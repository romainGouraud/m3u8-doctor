/**
 * The diagnosis pipeline: load -> parse -> pick variant -> inspect media
 * playlists -> probe the first segment -> findings -> ffmpeg command.
 */
import { createDecipheriv } from 'node:crypto';
import { codecKind, codecName, classifyEncryption, signedUrlExpiry, type Encryption } from './classify.js';
import { buildFfmpegCommand, defaultShell, outputName, type CommandInput, type Shell } from './command.js';
import { BROWSER_UA, FetchError, get, isHttpUrl, loadText, type RequestContext } from './http.js';
import { parsePlaylist, PlaylistError, type MasterPlaylist, type MediaPlaylist, type Rendition, type Segment, type Variant } from './playlist.js';
import { sniff, type SniffResult, type SniffedTrack } from './sniff.js';

export const GUIDES = {
  noSound: 'https://getvidora.com/blog/downloaded-video-no-sound/',
  findUrl: 'https://getvidora.com/blog/find-m3u8-url/',
  encrypted: 'https://getvidora.com/blog/download-encrypted-m3u8/',
  live: 'https://getvidora.com/blog/live-stream-m3u8-download/',
  dash: 'https://getvidora.com/blog/dash-mpd-downloader/',
  toMp4: 'https://getvidora.com/blog/m3u8-to-mp4/',
} as const;

export type Severity = 'ok' | 'info' | 'warn' | 'error';

export interface Finding {
  severity: Severity;
  code: string;
  title: string;
  detail?: string;
  learnMore?: string;
}

export interface DiagnoseOptions {
  headers?: Record<string, string>;
  userAgent?: string;
  /** Preferred maximum height (e.g. 720). Default: highest available. */
  maxHeight?: number;
  /** Probe the first segment to see which tracks really exist. Default true. */
  probe?: boolean;
  /** Base URL for relative URIs when the input is a local file. */
  baseUrl?: string;
  timeoutMs?: number;
  shell?: Shell;
  output?: string;
  now?: Date;
}

export interface MediaReport {
  url: string;
  type: 'vod' | 'event' | 'live';
  durationSec: number;
  segments: number;
  targetDuration: number | null;
  container: 'mpegts' | 'fmp4' | 'packed-audio' | 'unknown';
  encryption: Encryption;
  key: { url: string; status: number | null; validLength: boolean | null } | null;
  byteRanges: boolean;
  discontinuities: number;
  lowLatency: boolean;
  segmentExtensions: string[];
  probe: { tracks: SniffedTrack[]; note: string | null } | null;
}

export interface Report {
  input: string;
  url: string | null;
  playlist: 'master' | 'media' | null;
  master: {
    variants: Variant[];
    audio: Rendition[];
    subtitles: Rendition[];
    iFrameVariants: number;
  } | null;
  selected: { variant: Variant | null; audio: Rendition | null } | null;
  video: MediaReport | null;
  audio: MediaReport | null;
  signedUrlExpiresAt: string | null;
  findings: Finding[];
  downloadable: boolean;
  command: string | null;
  shell: Shell;
}

const PROBE_BYTES = 256 * 1024;
const NORMAL_SEGMENT_EXT = new Set(['ts', 'm4s', 'mp4', 'm4v', 'm4a', 'aac', 'mp3', 'ac3', 'ec3', 'cmfv', 'cmfa', 'mpegts', 'mpg', 'vtt', 'webvtt']);

function hasAudioCodec(v: Variant): boolean | null {
  if (v.codecs.length === 0) return null;
  return v.codecs.some((c) => codecKind(c) === 'audio');
}

function height(v: Variant): number {
  return v.resolution?.height ?? 0;
}

export function pickVariant(variants: Variant[], maxHeight?: number): Variant | null {
  const playable = variants.filter((v) => !v.codecs.length || v.codecs.some((c) => codecKind(c) === 'video'));
  const pool = playable.length > 0 ? playable : variants;
  const capped = maxHeight ? pool.filter((v) => height(v) === 0 || height(v) <= maxHeight) : pool;
  const candidates = capped.length > 0 ? capped : pool;
  // Same height: prefer AAC audio (plays everywhere once in MP4), then the higher bitrate.
  const aacScore = (v: Variant) => (v.codecs.some((c) => c.toLowerCase().startsWith('mp4a.40')) ? 1 : 0);
  return [...candidates].sort((a, b) => height(b) - height(a) || aacScore(b) - aacScore(a) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0] ?? null;
}

export function pickAudio(master: MasterPlaylist, variant: Variant | null): Rendition | null {
  if (!variant?.audioGroup) return null;
  const group = master.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup);
  return group.find((r) => r.isDefault && r.uri) ?? group.find((r) => r.autoselect && r.uri) ?? group.find((r) => r.uri) ?? null;
}

function mediaType(m: MediaPlaylist): MediaReport['type'] {
  if (m.endList || m.playlistType === 'VOD') return 'vod';
  if (m.playlistType === 'EVENT') return 'event';
  return 'live';
}

function extOf(uri: string): string {
  try {
    const p = new URL(uri).pathname;
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(p);
    return m ? m[1]!.toLowerCase() : '';
  } catch {
    const m = /\.([A-Za-z0-9]{1,6})(?:\?|$)/.exec(uri);
    return m ? m[1]!.toLowerCase() : '';
  }
}

function guessContainer(m: MediaPlaylist): MediaReport['container'] {
  const first = m.segments[0];
  if (!first) return 'unknown';
  if (first.map) return 'fmp4';
  const ext = extOf(first.uri);
  if (ext === 'm4s' || ext === 'mp4' || ext === 'cmfv' || ext === 'cmfa' || ext === 'm4a' || ext === 'm4v') return 'fmp4';
  if (ext === 'aac' || ext === 'mp3' || ext === 'ac3' || ext === 'ec3') return 'packed-audio';
  return 'mpegts';
}

function ivFor(segment: Segment): Buffer {
  const iv = segment.key?.iv;
  if (iv && /^0x[0-9a-f]+$/i.test(iv)) {
    const hex = iv.slice(2).padStart(32, '0').slice(-32);
    return Buffer.from(hex, 'hex');
  }
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(BigInt(segment.sequence), 8);
  return buf;
}

function rangeHeader(start: number, length: number): string {
  return `bytes=${start}-${start + length - 1}`;
}

async function fetchKey(url: string, ctx: RequestContext): Promise<{ status: number | null; key: Buffer | null }> {
  if (!isHttpUrl(url)) return { status: null, key: null };
  try {
    const res = await get(url, ctx, { maxBytes: 4096 });
    return { status: res.status, key: res.ok && res.body.byteLength === 16 ? Buffer.from(res.body) : null };
  } catch {
    return { status: null, key: null };
  }
}

async function probeSegment(m: MediaPlaylist, ctx: RequestContext, key: Buffer | null, enc: Encryption): Promise<MediaReport['probe']> {
  const first = m.segments[0];
  if (!first) return { tracks: [], note: 'The playlist has no segments yet.' };
  if (enc.kind === 'drm') return null;
  if (!isHttpUrl(first.uri)) return { tracks: [], note: 'Relative segment URLs: pass --base <url> to probe them.' };

  try {
    if (first.map) {
      const r = first.map.byteRange;
      const res = await get(first.map.uri, ctx, { maxBytes: 2 * 1024 * 1024, ...(r ? { range: rangeHeader(r.offset ?? 0, r.length) } : {}) });
      if (!res.ok && res.status !== 206) return { tracks: [], note: `Init segment returned HTTP ${res.status}.` };
      const result = sniff(res.body);
      return { tracks: result.tracks, note: noteFor(result) };
    }
    if (enc.kind === 'sample-aes') {
      // Headers stay readable under SAMPLE-AES: only the samples are encrypted.
    } else if (enc.kind === 'aes-128' && !key) {
      return { tracks: [], note: 'Segments are AES-128 encrypted and the key could not be fetched, so the tracks cannot be inspected.' };
    }
    const r = first.byteRange;
    const want = r ? Math.min(r.length, PROBE_BYTES) : PROBE_BYTES;
    const res = await get(first.uri, ctx, { maxBytes: want, range: rangeHeader(r?.offset ?? 0, want) });
    if (!res.ok && res.status !== 206) return { tracks: [], note: `First segment returned HTTP ${res.status}.` };
    let bytes: Uint8Array = res.body;
    if (enc.kind === 'aes-128' && key) {
      const usable = bytes.byteLength - (bytes.byteLength % 16);
      const decipher = createDecipheriv('aes-128-cbc', key, ivFor(first));
      decipher.setAutoPadding(false);
      bytes = Buffer.concat([decipher.update(bytes.subarray(0, usable)), decipher.final()]);
    }
    const result = sniff(bytes);
    if (result.container === 'unknown') {
      return { tracks: [], note: 'The first segment is not MPEG-TS, MP4 or raw audio (wrong key, an HTML error page, or an exotic format).' };
    }
    return { tracks: result.tracks, note: noteFor(result) };
  } catch (err) {
    return { tracks: [], note: `Probe failed: ${(err as Error).message}` };
  }
}

function noteFor(result: SniffResult): string | null {
  if (result.psshSystems.length > 0 || result.tracks.some((t) => t.encrypted)) {
    return `Encrypted samples${result.scheme ? ` (${result.scheme})` : ''}${result.psshSystems.length ? `, DRM system ids ${result.psshSystems.join(', ')}` : ''}.`;
  }
  return null;
}

async function inspectMedia(url: string, ctx: RequestContext, probe: boolean, preParsed?: MediaPlaylist): Promise<MediaReport> {
  let playlist = preParsed;
  if (!playlist) {
    const res = await get(url, ctx, { maxBytes: 16 * 1024 * 1024 });
    if (!res.ok) throw new FetchError(`Media playlist returned HTTP ${res.status}`, url);
    const parsed = parsePlaylist(new TextDecoder().decode(res.body), res.url);
    if (parsed.kind !== 'media') throw new FetchError('Expected a media playlist but got another master playlist', url);
    playlist = parsed;
  }
  const encryption = classifyEncryption(playlist.keys);
  let key: MediaReport['key'] = null;
  let keyBytes: Buffer | null = null;
  if (encryption.kind === 'aes-128' && encryption.keyUri) {
    const k = await fetchKey(encryption.keyUri, ctx);
    keyBytes = k.key;
    key = { url: encryption.keyUri, status: k.status, validLength: k.status !== null && k.status < 400 ? k.key !== null : null };
  }
  const exts = [...new Set(playlist.segments.slice(0, 50).map((s) => extOf(s.uri)))];
  const probed = probe ? await probeSegment(playlist, ctx, keyBytes, encryption) : null;
  let container = guessContainer(playlist);
  if (probed && probed.tracks.length > 0 && container === 'mpegts' && playlist.segments[0] && !playlist.segments[0].map) {
    const audioOnly = probed.tracks.every((t) => t.type === 'audio');
    if (audioOnly && extOf(playlist.segments[0].uri) !== 'ts') container = 'packed-audio';
  }
  return {
    url,
    type: mediaType(playlist),
    durationSec: Math.round(playlist.segments.reduce((s, x) => s + x.duration, 0) * 1000) / 1000,
    segments: playlist.segments.length,
    targetDuration: playlist.targetDuration,
    container,
    encryption,
    key,
    byteRanges: playlist.segments.some((s) => s.byteRange !== null),
    discontinuities: playlist.discontinuities,
    lowLatency: playlist.lowLatency,
    segmentExtensions: exts,
    probe: probed,
  };
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function tracksOf(m: MediaReport | null, kind: 'video' | 'audio'): SniffedTrack[] {
  return m?.probe?.tracks.filter((t) => t.type === kind) ?? [];
}

function probed(m: MediaReport | null): boolean {
  return !!m?.probe && m.probe.tracks.length > 0;
}

function encryptionFindings(m: MediaReport, label: string, out: Finding[]): void {
  const e = m.encryption;
  if (e.kind === 'none') return;
  if (e.kind === 'drm') {
    out.push({
      severity: 'error',
      code: 'DRM',
      title: `${label} is protected by DRM (${e.systems.join(', ')})`,
      detail: 'DRM-protected streams cannot be saved by ffmpeg or any honest tool, and circumventing DRM is illegal in most countries. m3u8-doctor stops here.',
    });
    return;
  }
  if (e.kind === 'sample-aes') {
    out.push({
      severity: 'warn',
      code: 'SAMPLE_AES',
      title: `${label} uses SAMPLE-AES encryption`,
      detail: 'ffmpeg 5.0 and later decrypt SAMPLE-AES in MPEG-TS segments when the key is reachable. Older versions produce a corrupt file.',
      learnMore: GUIDES.encrypted,
    });
    return;
  }
  const k = m.key;
  if (k && k.status !== null && k.status >= 400) {
    out.push({
      severity: 'error',
      code: 'AES_KEY_UNREACHABLE',
      title: `${label} is AES-128 encrypted and the key returns HTTP ${k.status}`,
      detail: 'The key server wants something the request did not send: usually cookies, a Referer or a token that expired. Pass the same headers as the browser (--referer, -H "Cookie: ...") or copy a fresh URL.',
      learnMore: GUIDES.encrypted,
    });
  } else if (k && k.validLength === false) {
    out.push({
      severity: 'warn',
      code: 'AES_KEY_INVALID',
      title: `${label} is AES-128 encrypted but the key is not 16 bytes`,
      detail: 'The key URL answered, but not with a raw 16-byte key (often an HTML login page or a wrapped key). ffmpeg will fail to decrypt.',
      learnMore: GUIDES.encrypted,
    });
  } else {
    out.push({
      severity: 'ok',
      code: 'AES_128',
      title: `${label} is AES-128 encrypted, key reachable`,
      detail: 'Standard HLS encryption (not DRM). ffmpeg fetches the key and decrypts on the fly.',
    });
  }
}

function buildFindings(r: Report, master: MasterPlaylist | null): Finding[] {
  const out: Finding[] = [];
  const v = r.video;
  const a = r.audio;

  if (master && r.master) {
    const total = r.master.variants.length;
    if (total === 0) out.push({ severity: 'warn', code: 'NO_VARIANTS', title: 'The master playlist lists no video variants' });
  }

  for (const [m, label] of [[v, r.audio ? 'Video' : 'Stream'], [a, 'Audio']] as const) {
    if (m) encryptionFindings(m, label, out);
  }
  if (r.master && master) {
    for (const key of master.sessionKeys) {
      const enc = classifyEncryption([key]);
      if (enc.kind === 'drm' && !out.some((f) => f.code === 'DRM')) {
        out.push({ severity: 'error', code: 'DRM', title: `Protected by DRM (${enc.systems.join(', ')}), declared in the master playlist`, detail: 'DRM-protected streams cannot be saved by ffmpeg or any honest tool. m3u8-doctor stops here.' });
      }
    }
  }

  // Sound: the reason this tool exists.
  const variant = r.selected?.variant ?? null;
  if (a) {
    out.push({
      severity: 'warn',
      code: 'SEPARATE_AUDIO',
      title: 'The audio is in a separate playlist',
      detail: 'The video variant carries no sound of its own. Downloading only the video URL gives a silent file. The command below downloads both and merges them.',
      learnMore: GUIDES.noSound,
    });
  } else if (variant && hasAudioCodec(variant) === false && !variant.audioGroup) {
    out.push({
      severity: 'warn',
      code: 'VIDEO_ONLY_VARIANT',
      title: 'The selected variant declares no audio codec',
      detail: `CODECS="${variant.codecs.join(',')}" lists video only and no audio group is attached, so the result will probably be silent.`,
      learnMore: GUIDES.noSound,
    });
  }

  if (probed(v)) {
    const hasVideo = tracksOf(v, 'video').length > 0;
    const hasAudio = tracksOf(v, 'audio').length > 0;
    if (!a && hasVideo && !hasAudio) {
      out.push({
        severity: 'error',
        code: 'NO_AUDIO_TRACK',
        title: 'This playlist contains video but no sound',
        detail: r.playlist === 'media'
          ? 'You probably copied a variant playlist. The sound lives in another playlist listed by the master playlist (the first .m3u8 the player requests, often master.m3u8, playlist.m3u8 or index.m3u8). Run m3u8-doctor on that one.'
          : 'The first segment has a video track and no audio track. The source itself may be silent, or the audio is served outside HLS.',
        learnMore: r.playlist === 'media' ? GUIDES.findUrl : GUIDES.noSound,
      });
    } else if (!a && !hasVideo && hasAudio && r.playlist === 'media') {
      out.push({ severity: 'info', code: 'AUDIO_ONLY', title: 'This playlist is audio only', detail: 'Use the master playlist to get the matching video.', learnMore: GUIDES.findUrl });
    } else if (hasVideo && (hasAudio || a)) {
      const names = [...tracksOf(v, 'video'), ...tracksOf(v, 'audio'), ...tracksOf(a, 'audio')].map((t) => codecName(t.codec));
      out.push({ severity: 'ok', code: 'TRACKS', title: `Picture and sound found (${[...new Set(names)].join(' + ')})` });
    }
    const vVideo = tracksOf(v, 'video')[0];
    if (vVideo?.codec === 'hevc') {
      out.push({ severity: 'info', code: 'HEVC_TAG', title: 'HEVC video: the command tags it hvc1 so QuickTime and iOS can play it' });
    }
  }
  if (probed(a) && tracksOf(a, 'audio').length === 0) {
    out.push({ severity: 'warn', code: 'AUDIO_PLAYLIST_EMPTY', title: 'The audio playlist has no audio track in its first segment' });
  }
  for (const m of [v, a]) {
    if (m?.probe?.note) out.push({ severity: 'info', code: 'PROBE_NOTE', title: m.probe.note });
  }

  if (v) {
    if (v.type === 'live') {
      out.push({
        severity: 'warn',
        code: 'LIVE',
        title: 'Live stream: ffmpeg records from now until you stop it',
        detail: 'Press q to stop cleanly. Add -t 3600 to stop after one hour. Earlier parts of the broadcast cannot be fetched from a sliding live playlist.',
        learnMore: GUIDES.live,
      });
    } else if (v.type === 'event') {
      out.push({ severity: 'info', code: 'EVENT', title: 'Event playlist still growing: the recording stops at the current end unless you rerun it later', learnMore: GUIDES.live });
    } else {
      out.push({ severity: 'ok', code: 'VOD', title: `On-demand video, ${formatDuration(v.durationSec)} in ${v.segments} segments (${v.container === 'fmp4' ? 'fragmented MP4' : v.container === 'mpegts' ? 'MPEG-TS' : v.container})` });
    }
    if (v.lowLatency) out.push({ severity: 'info', code: 'LL_HLS', title: 'Low-Latency HLS playlist: ffmpeg reads the full segments and ignores the partial ones' });
    if (v.byteRanges) out.push({ severity: 'info', code: 'BYTERANGE', title: 'Segments are byte ranges of one file (EXT-X-BYTERANGE), ffmpeg handles it' });
    if (v.discontinuities > 0) {
      out.push({
        severity: 'warn',
        code: 'DISCONTINUITY',
        title: `${v.discontinuities} discontinuit${v.discontinuities > 1 ? 'ies' : 'y'} (inserted ads or spliced parts)`,
        detail: 'Timestamps restart at each discontinuity. If the result stutters or desyncs, re-encode instead of -c copy.',
      });
    }
    const odd = [...v.segmentExtensions, ...(a?.segmentExtensions ?? [])].filter((e) => e && !NORMAL_SEGMENT_EXT.has(e));
    if (odd.length > 0) {
      out.push({
        severity: 'warn',
        code: 'DISGUISED_SEGMENTS',
        title: `Segments use unusual extensions (.${[...new Set(odd)].join(', .')})`,
        detail: 'Recent ffmpeg versions refuse segments whose extension does not match their content. If ffmpeg stops with an "extension" error, add -extension_picky 0 before -i (ffmpeg 7.1 and later).',
      });
    }
  }

  if (r.signedUrlExpiresAt) {
    const expired = Date.parse(r.signedUrlExpiresAt) <= Date.now();
    out.push({
      severity: expired ? 'error' : 'info',
      code: expired ? 'SIGNED_URL_EXPIRED' : 'SIGNED_URL',
      title: expired ? `The signed URL expired at ${r.signedUrlExpiresAt}` : `Signed URL, valid until ${r.signedUrlExpiresAt}`,
      detail: expired ? 'Reload the page and copy a fresh URL.' : 'Download before it expires, or copy a fresh one from the page.',
      learnMore: GUIDES.findUrl,
    });
  }

  return out;
}

function commandFor(r: Report, ctx: RequestContext, opts: DiagnoseOptions): string | null {
  if (!r.downloadable || !r.url || !isHttpUrl(r.url)) return null;
  const userAgent = opts.userAgent ?? (ctx.usedBrowserUA ? BROWSER_UA : null);
  const headers = { ...(opts.headers ?? {}) };
  delete headers['User-Agent'];
  const inputs: CommandInput[] = [{ url: r.video?.url ?? r.url, headers, userAgent }];
  const maps: string[] = [];
  if (r.audio) {
    inputs.push({ url: r.audio.url, headers, userAgent });
    maps.push('0:v:0', '1:a:0');
  }
  const outputOptions: string[] = [];
  if (tracksOf(r.video, 'video')[0]?.codec === 'hevc') outputOptions.push('-tag:v', 'hvc1');
  return buildFfmpegCommand({ inputs, maps, output: opts.output ?? outputName(r.url), outputOptions }, opts.shell ?? defaultShell());
}


export async function diagnose(input: string, opts: DiagnoseOptions = {}): Promise<Report> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
  const ctx: RequestContext = { headers, timeoutMs: opts.timeoutMs ?? 15000, usedBrowserUA: false, userAgentGiven: !!opts.userAgent };
  const probe = opts.probe !== false;

  const report: Report = {
    input,
    url: null,
    playlist: null,
    master: null,
    selected: null,
    video: null,
    audio: null,
    signedUrlExpiresAt: null,
    findings: [],
    downloadable: false,
    command: null,
    shell: opts.shell ?? defaultShell(),
  };

  let loaded: Awaited<ReturnType<typeof loadText>>;
  try {
    loaded = await loadText(input, ctx);
  } catch (err) {
    report.findings.push({ severity: 'error', code: 'FETCH_FAILED', title: (err as Error).message });
    return report;
  }
  report.url = opts.baseUrl ?? loaded.url;
  const expiry = isHttpUrl(input) ? signedUrlExpiry(input) : null;
  if (expiry) report.signedUrlExpiresAt = new Date(expiry * 1000).toISOString().replace('.000Z', 'Z');

  if (loaded.status >= 400) {
    report.findings.push(httpFinding(loaded.status, ctx));
    if (expiry && expiry * 1000 <= Date.now()) report.findings.push({ severity: 'error', code: 'SIGNED_URL_EXPIRED', title: `The signed URL expired at ${report.signedUrlExpiresAt}`, detail: 'Reload the page and copy a fresh URL.', learnMore: GUIDES.findUrl });
    return report;
  }

  let parsed;
  try {
    parsed = parsePlaylist(loaded.text, report.url);
  } catch (err) {
    if (err instanceof PlaylistError) {
      report.findings.push({
        severity: 'error',
        code: `NOT_HLS_${err.code}`,
        title: err.message,
        ...(err.code === 'DASH' ? { detail: 'Use ffmpeg or yt-dlp directly on the .mpd URL.', learnMore: GUIDES.dash } : {}),
        ...(err.code === 'HTML' ? { detail: 'Often a login page, a geo-block or an expired link. Copy the .m3u8 request from DevTools while the video plays.', learnMore: GUIDES.findUrl } : {}),
      });
      return report;
    }
    throw err;
  }
  report.playlist = parsed.kind;

  try {
    if (parsed.kind === 'master') {
      const variant = pickVariant(parsed.variants, opts.maxHeight);
      const audio = pickAudio(parsed, variant);
      report.master = {
        variants: parsed.variants,
        audio: parsed.renditions.filter((r) => r.type === 'AUDIO'),
        subtitles: parsed.renditions.filter((r) => r.type === 'SUBTITLES'),
        iFrameVariants: parsed.iFrameVariants,
      };
      report.selected = { variant, audio };
      const canFetch = (u: string | undefined) => !!u && isHttpUrl(u);
      const [video, audioReport] = await Promise.all([
        canFetch(variant?.uri) ? inspectMedia(variant!.uri, ctx, probe) : Promise.resolve(null),
        canFetch(audio?.uri ?? undefined) ? inspectMedia(audio!.uri!, ctx, probe) : Promise.resolve(null),
      ]);
      report.video = video;
      report.audio = audioReport;
      if (variant && !canFetch(variant.uri)) {
        report.findings.push({ severity: 'info', code: 'RELATIVE_URIS', title: 'Relative URIs in a local file: pass --base <url> to inspect the variants' });
      }
    } else {
      report.video = await inspectMedia(report.url ?? input, ctx, probe && !!report.url && isHttpUrl(report.url), parsed);
    }
  } catch (err) {
    report.findings.push({ severity: 'error', code: 'MEDIA_FETCH_FAILED', title: (err as Error).message });
  }

  report.findings.push(...buildFindings(report, parsed.kind === 'master' ? parsed : null));
  if (ctx.usedBrowserUA) {
    report.findings.push({ severity: 'info', code: 'BROWSER_UA', title: 'The server rejects non-browser clients: the command sends a browser User-Agent' });
  }
  report.downloadable = !report.findings.some((f) => f.severity === 'error' && f.code !== 'NO_AUDIO_TRACK');
  report.command = commandFor(report, ctx, opts);
  return report;
}

function httpFinding(status: number, ctx: RequestContext): Finding {
  if (status === 401 || status === 403) {
    return {
      severity: 'error',
      code: 'HTTP_FORBIDDEN',
      title: `The server refused the playlist (HTTP ${status})`,
      detail: `Most often the URL is signed and expired, or the server checks the Referer, cookies or IP${ctx.userAgentGiven ? '' : ' (a browser User-Agent was already tried)'}. Copy a fresh URL from DevTools and pass the page as --referer.`,
      learnMore: GUIDES.findUrl,
    };
  }
  if (status === 404 || status === 410) {
    return { severity: 'error', code: 'HTTP_GONE', title: `The playlist does not exist anymore (HTTP ${status})`, detail: 'Temporary playlist URLs disappear after a while. Copy a fresh one.', learnMore: GUIDES.findUrl };
  }
  if (status === 429) return { severity: 'error', code: 'HTTP_RATE_LIMITED', title: 'Rate limited by the server (HTTP 429)', detail: 'Wait a minute and retry.' };
  return { severity: 'error', code: 'HTTP_ERROR', title: `The server answered HTTP ${status}` };
}
