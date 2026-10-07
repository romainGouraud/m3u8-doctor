/**
 * Minimal HTTP layer on top of the global fetch (Node >= 20, browsers).
 * Bounded reads, timeouts, one retry on 5xx, and one retry with a browser
 * User-Agent when a CDN rejects non-browser clients. Local files are read
 * through a lazy node:fs import so the module also runs in a browser.
 */

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

/** Header names and values ffmpeg and fetch both accept (no CR/LF, no control chars). */
export function isValidHeader(name: string, value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value);
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

function describeNetworkError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `timed out after ${timeoutMs / 1000}s`;
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = (cause as { code?: string } | undefined)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name does not resolve (DNS)';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection reset by the server';
  if ((code && code.startsWith('ERR_TLS')) || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `TLS error (${code})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

async function once(url: string, headers: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<FetchResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal });
    const { body, truncated } = await readBounded(res, maxBytes);
    return { ok: res.ok, status: res.status, url: res.url || url, contentType: res.headers.get('content-type'), body, truncated };
  } catch (err) {
    throw new FetchError(`Could not reach the server: ${describeNetworkError(err, timeoutMs)}`, url, err);
  }
}

/**
 * GET with the context headers. Retries once on 500-504. On 403 without a
 * user-provided User-Agent, retries once as a browser and remembers it.
 */
export async function get(url: string, ctx: RequestContext, opts: { maxBytes: number; range?: string } = { maxBytes: 10 * 1024 * 1024 }): Promise<FetchResult> {
  if (!isHttpUrl(url)) throw new FetchError(`Refusing to fetch a non-HTTP URL (${url.split(':')[0]}:)`, url);
  const headers: Record<string, string> = { ...ctx.headers };
  if (ctx.usedBrowserUA && !ctx.userAgentGiven) headers['User-Agent'] = BROWSER_UA;
  if (opts.range) headers.Range = opts.range;
  let first = await once(url, headers, ctx.timeoutMs, opts.maxBytes);
  if (first.status >= 500 && first.status <= 504) {
    await new Promise((r) => setTimeout(r, 700));
    first = await once(url, headers, ctx.timeoutMs, opts.maxBytes);
  }
  if (first.status === 403 && !ctx.userAgentGiven && !ctx.usedBrowserUA) {
    const retry = await once(url, { ...headers, 'User-Agent': BROWSER_UA }, ctx.timeoutMs, opts.maxBytes).catch(() => null);
    if (retry?.ok) {
      ctx.usedBrowserUA = true;
      return retry;
    }
  }
  return first;
}

export const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;

export interface LoadedText {
  text: string;
  url: string | null;
  status: number;
  contentType: string | null;
  truncated: boolean;
  local: boolean;
}

/** Reads a playlist from a URL or, in Node, a local path. */
export async function loadText(input: string, ctx: RequestContext): Promise<LoadedText> {
  if (isHttpUrl(input)) {
    const res = await get(input, ctx, { maxBytes: MAX_PLAYLIST_BYTES });
    return { text: new TextDecoder().decode(res.body), url: res.url, status: res.status, contentType: res.contentType, truncated: res.truncated, local: false };
  }
  let fs: typeof import('node:fs/promises');
  let nodeUrl: typeof import('node:url');
  let nodePath: typeof import('node:path');
  try {
    fs = await import('node:fs/promises');
    nodeUrl = await import('node:url');
    nodePath = await import('node:path');
  } catch {
    throw new FetchError('Only http(s) URLs are supported here.', input);
  }
  try {
    const path = input.startsWith('file:') ? nodeUrl.fileURLToPath(input) : input;
    const text = await fs.readFile(path, 'utf8');
    return { text, url: nodeUrl.pathToFileURL(nodePath.resolve(path)).href, status: 200, contentType: null, truncated: false, local: true };
  } catch (err) {
    throw new FetchError(`Cannot read file: ${(err as Error).message}`, input, err);
  }
}
