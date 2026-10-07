/**
 * Builds a copy-paste ffmpeg command, quoted for the target shell.
 */

/** posix = bash/zsh (the -headers value uses $'...' quoting). cmd.exe is not supported: it cannot quote % or CRLF. */
export type Shell = 'posix' | 'powershell';

export interface CommandInput {
  url: string;
  /** Per-input HTTP headers ffmpeg must send (Referer, Cookie, Origin...). */
  headers: Record<string, string>;
  userAgent: string | null;
}

export interface CommandSpec {
  inputs: CommandInput[];
  /** Explicit stream mapping, e.g. ['0:v:0', '1:a:0']. Empty = ffmpeg default selection. */
  maps: string[];
  output: string;
  /** Extra output options inserted before the output name. */
  outputOptions: string[];
  /** Extra input options inserted before every -i. */
  inputOptions?: string[];
}

export function defaultShell(platform?: string): Shell {
  const p = platform ?? (typeof process !== 'undefined' ? process.platform : '');
  return p === 'win32' ? 'powershell' : 'posix';
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quote(value: string, shell: Shell): string {
  if (SAFE.test(value)) return value;
  switch (shell) {
    case 'posix':
      return `'${value.replace(/'/g, `'\\''`)}'`;
    case 'powershell':
      // PowerShell also treats the Unicode single quotes as quote characters.
      return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`;
  }
}

/** Headers joined with CRLF, as ffmpeg's -headers option expects. */
function quoteHeaders(headers: Record<string, string>, shell: Shell): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  if (shell === 'posix') {
    const body = lines.map((l) => l.replace(/\\/g, '\\\\').replace(/'/g, "\\'")).join('\\r\\n') + '\\r\\n';
    return `$'${body}'`;
  }
  const body = lines.map((l) => l.replace(/[`"$\u201c\u201d\u201e]/g, (c) => '`' + c)).join('`r`n') + '`r`n';
  return `"${body}"`;
}

export function buildFfmpegCommand(spec: CommandSpec, shell: Shell): string {
  const parts: string[] = ['ffmpeg'];
  for (const input of spec.inputs) {
    for (const opt of spec.inputOptions ?? []) parts.push(opt);
    if (input.userAgent) parts.push('-user_agent', quote(input.userAgent, shell));
    const { Referer, referer, ...rest } = input.headers;
    const ref = Referer ?? referer;
    if (ref) parts.push('-referer', quote(ref, shell));
    if (Object.keys(rest).length > 0) parts.push('-headers', quoteHeaders(rest, shell));
    parts.push('-i', quote(input.url, shell));
  }
  for (const m of spec.maps) parts.push('-map', m);
  parts.push('-c', 'copy', ...spec.outputOptions, quote(spec.output, shell));
  return parts.join(' ');
}

/** Derives a safe output file name from a playlist URL. */
export function outputName(url: string, ext = 'mp4'): string {
  let base = 'video';
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const generic = /^(master|index|playlist|manifest|prog_index|chunklist|mono|stream|video|media|hls|main)(_\w+)?\.m3u8$/i;
    const last = segments[segments.length - 1] ?? '';
    const candidate = generic.test(last) || !/\.m3u8$/i.test(last) ? (segments[segments.length - 2] ?? '') : last;
    base = candidate.replace(/\.m3u8$/i, '');
  } catch {
    /* keep default */
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `${base || 'video'}.${ext}`;
}
