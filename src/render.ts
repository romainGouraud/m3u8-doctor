/**
 * Human-readable terminal output. Respects NO_COLOR and non-TTY output.
 */
import { codecName } from './classify.js';
import { formatDuration, type Finding, type Report } from './diagnose.js';
import type { Rendition, Variant } from './playlist.js';

export interface RenderOptions {
  color: boolean;
  links: boolean;
}

const ESC = '\u001b[';

function paint(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `${ESC}${code}m${s}${ESC}0m` : s);
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33'), cyan: wrap('36') };
}

function mbps(bps: number | null): string {
  return bps ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mb/s` : '?';
}

function variantLine(v: Variant): string {
  const res = v.resolution ? `${v.resolution.width}x${v.resolution.height}` : 'unknown size';
  const codecs = v.codecs.length ? ` · ${v.codecs.map(codecName).join(' + ')}` : '';
  const fps = v.frameRate ? ` · ${Math.round(v.frameRate * 100) / 100} fps` : '';
  return `${res} · ${mbps(v.averageBandwidth ?? v.bandwidth)}${codecs}${fps}`;
}

function renditionLabel(r: Rendition): string {
  return r.name || r.language || r.groupId;
}

export function render(report: Report, opts: RenderOptions): string {
  const c = paint(opts.color);
  const lines: string[] = [];
  const label = (k: string) => c.dim(k.padEnd(9));
  const icon: Record<Finding['severity'], string> = {
    ok: c.green('✓'),
    info: c.cyan('i'),
    warn: c.yellow('!'),
    error: c.red('✗'),
  };

  lines.push(`${label('Input')}${report.input}`);
  if (report.master) {
    const m = report.master;
    const audio = m.audio.length ? `${m.audio.length} audio track${m.audio.length > 1 ? 's' : ''} (${summarize(m.audio.map(renditionLabel))})` : 'no separate audio';
    const subs = m.subtitles.length ? ` · ${m.subtitles.length} subtitle track${m.subtitles.length > 1 ? 's' : ''}` : '';
    lines.push(`${label('Type')}Master playlist · ${m.variants.length} variant${m.variants.length === 1 ? '' : 's'} · ${audio}${subs}`);
    const v = report.selected?.variant;
    if (v) lines.push(`${label('Picked')}${variantLine(v)}`);
    const a = report.selected?.audio;
    if (a) lines.push(`${label('Audio')}${renditionLabel(a)}${a.channels ? ` · ${a.channels} ch` : ''}`);
  } else if (report.playlist === 'media') {
    lines.push(`${label('Type')}Media playlist (a single quality)`);
  }

  if (report.findings.length) {
    lines.push('', c.bold('Findings'));
    for (const f of report.findings) {
      lines.push(` ${icon[f.severity]} ${f.severity === 'error' ? c.bold(f.title) : f.title}`);
      if (f.detail) lines.push(...wrap(f.detail, 76).map((l) => `   ${c.dim(l)}`));
      if (opts.links && f.learnMore && (f.severity === 'warn' || f.severity === 'error')) lines.push(`   ${c.dim('Guide:')} ${f.learnMore}`);
    }
  }

  if (report.master && report.master.variants.length > 1) {
    lines.push('', c.bold('Variants'));
    const sorted = [...report.master.variants].sort((a, b) => (b.resolution?.height ?? 0) - (a.resolution?.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    for (const v of sorted.slice(0, 12)) {
      const mark = v === report.selected?.variant ? c.green('›') : ' ';
      lines.push(` ${mark} ${variantLine(v)}`);
    }
    if (sorted.length > 12) lines.push(c.dim(`   ... ${sorted.length - 12} more`));
  }

  lines.push('');
  if (report.command) {
    const silent = report.findings.some((f) => f.code === 'NO_AUDIO_TRACK');
    lines.push(c.bold(silent ? 'Command (picture only: the file will be silent)' : 'Command'), `  ${report.command}`);
    if (report.video?.type === 'live') lines.push(c.dim('  Press q to stop the recording.'));
  } else if (report.playlist) {
    lines.push(c.dim('No download command: fix the errors above first.'));
  }
  return lines.join('\n') + '\n';
}

function summarize(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} x${n}` : l)).join(', ');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

