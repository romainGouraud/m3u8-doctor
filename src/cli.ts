#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { diagnose, type DiagnoseOptions } from './diagnose.js';
import type { Shell } from './command.js';
import { render } from './render.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const HELP = `m3u8-doctor ${pkg.version}
Explain an HLS (.m3u8) stream and print the ffmpeg command that keeps the sound.

Usage
  m3u8-doctor <url-or-file> [options]

Options
  -H, --header "Name: value"  Send an HTTP header (repeatable), e.g. Cookie or Origin
  -r, --referer <url>         Send this Referer (the page that plays the video)
  -A, --user-agent <ua>       Send this User-Agent
      --max-height <px>       Pick the best variant at or below this height (e.g. 720)
      --no-probe              Do not download the first bytes of a segment
      --base <url>            Base URL for relative URIs when reading a local file
  -o, --output <file>         Output file name used in the command
      --shell <posix|powershell|cmd>  Quote the command for this shell
      --timeout <seconds>     Network timeout per request (default 15)
      --json                  Print the full report as JSON
      --no-color              Disable colors (NO_COLOR is honored too)
      --no-links              Do not print guide links
  -v, --version               Print the version
  -h, --help                  Print this help

Exit codes
  0  ready to download
  1  a problem was found (silent stream, expired URL, network, not HLS...)
  2  DRM protected, cannot be downloaded

Examples
  npx m3u8-doctor "https://example.com/video/master.m3u8"
  npx m3u8-doctor "https://cdn.example.com/v.m3u8" --referer "https://example.com/watch/42"
`;

function fail(message: string): never {
  process.stderr.write(`m3u8-doctor: ${message}\nRun m3u8-doctor --help for usage.\n`);
  process.exit(1);
}

function parseHeader(raw: string): [string, string] {
  const i = raw.indexOf(':');
  if (i <= 0) fail(`invalid header "${raw}", expected "Name: value"`);
  return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()];
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        header: { type: 'string', short: 'H', multiple: true },
        referer: { type: 'string', short: 'r' },
        'user-agent': { type: 'string', short: 'A' },
        'max-height': { type: 'string' },
        'no-probe': { type: 'boolean' },
        base: { type: 'string' },
        output: { type: 'string', short: 'o' },
        shell: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        'no-links': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const headers: Record<string, string> = {};
  for (const h of values.header ?? []) {
    const [k, v] = parseHeader(h);
    headers[k] = v;
  }
  const input = positionals[0];
  if (!input) {
    process.stdout.write(HELP);
    process.exit(1);
  }
  if (positionals.length > 1) fail('expected a single URL or file (quote URLs that contain & or ?)');

  if (values.referer) headers.Referer = values.referer;

  const opts: DiagnoseOptions = { headers, probe: !values['no-probe'] };
  if (values['user-agent']) opts.userAgent = values['user-agent'];
  if (values['max-height']) {
    const h = Number(values['max-height']);
    if (!Number.isInteger(h) || h <= 0) fail('--max-height expects a positive integer');
    opts.maxHeight = h;
  }
  if (values.base) opts.baseUrl = values.base;
  if (values.output) opts.output = values.output;
  if (values.shell) {
    if (!['posix', 'powershell', 'cmd'].includes(values.shell)) fail('--shell expects posix, powershell or cmd');
    opts.shell = values.shell as Shell;
  }
  if (values.timeout) {
    const t = Number(values.timeout);
    if (!(t > 0)) fail('--timeout expects a number of seconds');
    opts.timeoutMs = t * 1000;
  }

  const report = await diagnose(input, opts);
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const color = !values['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY === true;
    process.stdout.write(render(report, { color, links: !values['no-links'] }));
  }
  const drm = report.findings.some((f) => f.code === 'DRM');
  const error = report.findings.some((f) => f.severity === 'error');
  process.exitCode = drm ? 2 : error ? 1 : 0;
}

main().catch((err: unknown) => {
  process.stderr.write(`m3u8-doctor: unexpected error: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
