/**
 * Minimal HTTP layer on top of the global fetch (Node >= 18).
 * Bounded reads, timeouts, and a single retry with a browser User-Agent when
 * a CDN rejects non-browser clients. Local files are supported for playlists.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export interface RequestContext {
  headers: Record<string, string>;
  timeoutMs: number;
  /** Set when the server only answered once we sent a browser User-Agent. */
  usedBrowserUA: boolean;
  userAgentGiven: boolean;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  contentType: string | null;
  body: Uint8Array;
  truncated: boolean;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

async function readBounded(res: Response, maxBytes: number): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - o);
    out.set(c.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return { body: out, truncated };
}

async function once(url: string, headers: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : describeNetworkError(err);
    throw new FetchError(`Could not reach the server: ${reason}`, url, err);
  }
  const { body, truncated } = await readBounded(res, maxBytes);
  return { ok: res.ok, status: res.status, url: res.url || url, contentType: res.headers.get('content-type'), body, truncated };
}

function describeNetworkError(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = (cause as { code?: string } | undefined)?.code;
  if (code === 'ENOTFOUND') return 'the host name does not resolve (DNS)';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset by the server';
  if (code && code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `TLS error (${code})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * GET with the context headers. On 403 without a user-provided User-Agent,
 * retries once as a browser and remembers it for the rest of the run.
 */
export async function get(url: string, ctx: RequestContext, opts: { maxBytes: number; range?: string } = { maxBytes: 10 * 1024 * 1024 }): Promise<FetchResult> {
  const headers: Record<string, string> = { ...ctx.headers };
  if (ctx.usedBrowserUA && !ctx.userAgentGiven) headers['User-Agent'] = BROWSER_UA;
  if (opts.range) headers.Range = opts.range;
  let first = await once(url, headers, ctx.timeoutMs, opts.maxBytes);
  if (first.status >= 500 && first.status <= 504) {
    await new Promise((r) => setTimeout(r, 700));
    first = await once(url, headers, ctx.timeoutMs, opts.maxBytes);
  }
  if (first.status === 403 && !ctx.userAgentGiven && !ctx.usedBrowserUA) {
    const retry = await once(url, { ...headers, 'User-Agent': BROWSER_UA }, ctx.timeoutMs, opts.maxBytes);
    if (retry.ok) {
      ctx.usedBrowserUA = true;
      return retry;
    }
  }
  return first;
}

/** Reads a playlist from a URL or a local path. */
export async function loadText(input: string, ctx: RequestContext): Promise<{ text: string; url: string | null; status: number; contentType: string | null }> {
  if (isHttpUrl(input)) {
    const res = await get(input, ctx, { maxBytes: 16 * 1024 * 1024 });
    return { text: new TextDecoder().decode(res.body), url: res.url, status: res.status, contentType: res.contentType };
  }
  const path = input.startsWith('file:') ? new URL(input) : resolve(input);
  try {
    const text = await readFile(path, 'utf8');
    const url = typeof path === 'string' ? pathToFileURL(isAbsolute(path) ? path : resolve(path)).href : path.href;
    return { text, url, status: 200, contentType: null };
  } catch (err) {
    throw new FetchError(`Cannot read file: ${(err as Error).message}`, input, err);
  }
}
