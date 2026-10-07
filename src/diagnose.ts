/**
 * The diagnosis pipeline: load -> parse -> pick variant -> inspect media
 * playlists -> probe the first segment -> findings -> ffmpeg command.
 * Runs in Node >= 20 and in browsers (WebCrypto, fetch, no node:* at top level).
 */
import { aes128CbcDecryptPrefix, hlsIv } from './aes.js';
import { codecKind, codecName, classifyEncryption, psshSystem, signedUrlExpiry, type DrmSystem, type Encryption } from './classify.js';
import { buildFfmpegCommand, defaultShell, outputName, type CommandInput, type Shell } from './command.js';
import { BROWSER_UA, FetchError, get, isHttpUrl, loadText, type LoadedText, type RequestContext } from './http.js';
import { parsePlaylist, PlaylistError, type KeyTag, type MasterPlaylist, type MediaPlaylist, type Playlist, type Rendition, type Segment, type Variant } from './playlist.js';
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
  /** Clock used for signed-URL expiry (tests). */
  now?: Date;
}

export type Container = 'mpegts' | 'fmp4' | 'packed-audio' | 'unknown';

export interface MediaReport {
  url: string;
  type: 'vod' | 'event' | 'live';
  durationSec: number;
  segments: number;
  targetDuration: number | null;
  container: Container;
  encryption: Encryption;
  key: { url: string; status: number | null; validLength: boolean | null; error: string | null } | null;
  byteRanges: boolean;
  discontinuities: number;
  lowLatency: boolean;
  segmentExtensions: string[];
  probe: { tracks: SniffedTrack[]; drm: DrmSystem[]; note: string | null } | null;
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
const INIT_BYTES = 2 * 1024 * 1024;
/** Extensions that are never media: the classic disguise of pirate CDNs. */
const DISGUISE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg', 'html', 'htm', 'js', 'css', 'txt', 'json', 'php', 'xml']);

function hasCodec(v: Variant, kind: 'video' | 'audio'): boolean | null {
  if (v.codecs.length === 0) return null;
  return v.codecs.some((c) => codecKind(c) === kind);
}

function height(v: Variant): number {
  return v.resolution?.height ?? 0;
}

export function pickVariant(variants: Variant[], maxHeight?: number): Variant | null {
  const withVideo = variants.filter((v) => hasCodec(v, 'video') !== false);
  const pool = withVideo.length > 0 ? withVideo : variants;
  const capped = maxHeight ? pool.filter((v) => height(v) === 0 || height(v) <= maxHeight) : pool;
  const candidates = capped.length > 0 ? capped : pool;
  // Same height: prefer AAC audio (plays everywhere once in MP4), then the higher bitrate.
  const aacScore = (v: Variant) => (v.codecs.some((c) => c.toLowerCase().startsWith('mp4a.40')) ? 1 : 0);
  return [...candidates].sort((a, b) => height(b) - height(a) || aacScore(b) - aacScore(a) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0] ?? null;
}

/**
 * The audio rendition a player would use with this variant, or null when that
 * audio is muxed into the variant itself (RFC 8216 4.3.4.1: no URI = in the variant).
 */
export function pickAudio(master: MasterPlaylist, variant: Variant | null): Rendition | null {
  if (!variant?.audioGroup) return null;
  const group = master.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup);
  if (group.length === 0) return null;
  const preferred = group.find((r) => r.isDefault) ?? group.find((r) => r.autoselect) ?? group[0]!;
  if (!preferred.uri) return null;
  return preferred;
}

function mediaType(m: MediaPlaylist): MediaReport['type'] {
  if (m.endList || m.playlistType === 'VOD') return 'vod';
  if (m.playlistType === 'EVENT') return 'event';
  return 'live';
}

function extOf(uri: string): string {
  try {
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(new URL(uri).pathname);
    return m ? m[1]!.toLowerCase() : '';
  } catch {
    const m = /\.([A-Za-z0-9]{1,6})(?:\?|$)/.exec(uri);
    return m ? m[1]!.toLowerCase() : '';
  }
}

function guessContainer(m: MediaPlaylist): Container {
  const first = m.segments[0];
  if (!first) return 'unknown';
  if (first.map) return 'fmp4';
  const ext = extOf(first.uri);
  if (['m4s', 'mp4', 'cmfv', 'cmfa', 'm4a', 'm4v'].includes(ext)) return 'fmp4';
  if (['aac', 'mp3', 'ac3', 'ec3'].includes(ext)) return 'packed-audio';
  return 'mpegts';
}

function containerOf(result: SniffResult): Container {
  if (result.container === 'mp4') return 'fmp4';
  return result.container;
}

function rangeHeader(start: number, length: number): string {
  return `bytes=${start}-${start + length - 1}`;
}

interface KeyCheck {
  status: number | null;
  key: Uint8Array | null;
  error: string | null;
}

async function fetchKey(url: string, ctx: RequestContext): Promise<KeyCheck> {
  if (!isHttpUrl(url)) return { status: null, key: null, error: `key URI is not http(s) (${url.split(':')[0]}:)` };
  try {
    const res = await get(url, ctx, { maxBytes: 4096 });
    return { status: res.status, key: res.ok && res.body.byteLength === 16 ? res.body : null, error: null };
  } catch (err) {
    return { status: null, key: null, error: (err as Error).message };
  }
}

interface ProbeOutcome {
  tracks: SniffedTrack[];
  container: Container | null;
  drm: DrmSystem[];
  note: string | null;
}

function drmFromSniff(result: SniffResult, playlistHasAes: boolean): DrmSystem[] {
  const encryptedSamples = result.tracks.some((t) => t.encrypted);
  const systems = new Set<DrmSystem>();
  for (const id of result.psshSystems) {
    const s = psshSystem(id);
    if (s !== 'clearkey') systems.add(s);
  }
  // CENC-encrypted samples without an HLS key the player could fetch = DRM.
  if (encryptedSamples && systems.size === 0 && !playlistHasAes) systems.add('unknown-drm');
  return [...systems];
}

async function decryptIfNeeded(bytes: Uint8Array, key: KeyTag | null, sequence: number, keys: Map<string, KeyCheck>, ctx: RequestContext): Promise<{ bytes: Uint8Array; failed: string | null }> {
  if (!key || key.method !== 'AES-128' || !key.uri) return { bytes, failed: null };
  let check = keys.get(key.uri);
  if (!check) {
    check = await fetchKey(key.uri, ctx);
    keys.set(key.uri, check);
  }
  if (!check.key) return { bytes, failed: 'the AES-128 key could not be fetched' };
  return { bytes: await aes128CbcDecryptPrefix(check.key, hlsIv(key.iv, sequence), bytes), failed: null };
}

async function probeSegment(m: MediaPlaylist, ctx: RequestContext, keys: Map<string, KeyCheck>, playlistHasAes: boolean): Promise<ProbeOutcome> {
  const first: Segment | undefined = m.segments[0];
  const empty = (note: string): ProbeOutcome => ({ tracks: [], container: null, drm: [], note });
  if (!first) return empty('The playlist has no segments yet.');
  if (!isHttpUrl(first.uri)) return empty('Relative segment URLs: pass --base <url> to probe them.');

  try {
    if (first.map) {
      if (!isHttpUrl(first.map.uri)) return empty('The init segment URI is not http(s), it was not fetched.');
      const r = first.map.byteRange;
      const res = await get(first.map.uri, ctx, { maxBytes: INIT_BYTES, ...(r ? { range: rangeHeader(r.offset ?? 0, r.length) } : {}) });
      if (!res.ok) return empty(`Init segment returned HTTP ${res.status}.`);
      // An init segment encrypted with AES-128 uses the IV of the key that applies to EXT-X-MAP.
      const { bytes, failed } = await decryptIfNeeded(res.body, first.map.key, first.sequence, keys, ctx);
      if (failed) return empty(`The init segment is encrypted and ${failed}, so the tracks cannot be inspected.`);
      const result = sniff(bytes);
      return { tracks: result.tracks, container: 'fmp4', drm: drmFromSniff(result, playlistHasAes), note: result.tracks.length ? null : 'The init segment declares no track.' };
    }
    const r = first.byteRange;
    const want = r ? Math.min(r.length, PROBE_BYTES) : PROBE_BYTES;
    const res = await get(first.uri, ctx, { maxBytes: want, range: rangeHeader(r?.offset ?? 0, want) });
    if (!res.ok) return empty(`First segment returned HTTP ${res.status}.`);
    // Decide from the key of THIS segment: a clear pre-roll can precede encrypted segments.
    const { bytes, failed } = await decryptIfNeeded(res.body, first.key, first.sequence, keys, ctx);
    if (failed) return empty(`Segments are encrypted and ${failed}, so the tracks cannot be inspected.`);
    const result = sniff(bytes);
    if (result.container === 'unknown') {
      return empty('The first segment is not MPEG-TS, MP4 or raw audio (wrong key, an HTML error page, or an exotic format).');
    }
    return { tracks: result.tracks, container: containerOf(result), drm: drmFromSniff(result, playlistHasAes), note: null };
  } catch (err) {
    return empty(`Probe failed: ${(err as Error).message}`);
  }
}

async function fetchMedia(url: string, ctx: RequestContext): Promise<MediaPlaylist> {
  const res = await get(url, ctx, { maxBytes: 16 * 1024 * 1024 });
  if (!res.ok) throw new FetchError(`Media playlist returned HTTP ${res.status} (${url})`, url);
  const parsed = parsePlaylist(new TextDecoder().decode(res.body), res.url);
  if (parsed.kind !== 'media') throw new FetchError('Expected a media playlist but got another master playlist', url);
  return parsed;
}

async function inspectMedia(url: string, playlist: MediaPlaylist, ctx: RequestContext, probe: boolean): Promise<MediaReport> {
  const encryption = classifyEncryption(playlist.keys);
  const keys = new Map<string, KeyCheck>();
  let key: MediaReport['key'] = null;
  if (encryption.kind === 'aes-128' && encryption.keyUri) {
    const k = await fetchKey(encryption.keyUri, ctx);
    keys.set(encryption.keyUri, k);
    key = { url: encryption.keyUri, status: k.status, validLength: k.status !== null && k.status < 400 ? k.key !== null : null, error: k.error };
  }
  const exts = [...new Set(playlist.segments.slice(0, 50).map((s) => extOf(s.uri)))];
  const probed = probe && encryption.kind !== 'drm' ? await probeSegment(playlist, ctx, keys, encryption.kind === 'aes-128') : null;
  return {
    url,
    type: mediaType(playlist),
    durationSec: Math.round(playlist.segments.reduce((s, x) => s + x.duration, 0) * 1000) / 1000,
    segments: playlist.segments.length,
    targetDuration: playlist.targetDuration,
    container: probed?.container ?? guessContainer(playlist),
    encryption,
    key,
    byteRanges: playlist.segments.some((s) => s.byteRange !== null),
    discontinuities: playlist.discontinuities,
    lowLatency: playlist.lowLatency,
    segmentExtensions: exts,
    probe: probed ? { tracks: probed.tracks, drm: probed.drm, note: probed.note } : null,
  };
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function tracksOf(m: MediaReport | null, kind: 'video' | 'audio'): SniffedTrack[] {
  return m?.probe?.tracks.filter((t) => t.type === kind) ?? [];
}

function probed(m: MediaReport | null): boolean {
  return !!m?.probe && m.probe.tracks.length > 0;
}

const DRM_DETAIL = 'DRM-protected streams cannot be saved with ffmpeg, and removing DRM is illegal in most countries. m3u8-doctor stops here.';

function encryptionFindings(m: MediaReport, label: string, out: Finding[]): void {
  const e = m.encryption;
  if (e.kind === 'drm') {
    out.push({ severity: 'error', code: 'DRM', title: `${label} is protected by DRM (${e.systems.join(', ')})`, detail: DRM_DETAIL });
    return;
  }
  if (m.probe && m.probe.drm.length > 0) {
    out.push({ severity: 'error', code: 'DRM', title: `${label} is protected by DRM (${m.probe.drm.join(', ')}, found in the init segment)`, detail: DRM_DETAIL });
    return;
  }
  if (e.kind === 'none') return;
  if (e.kind === 'sample-aes') {
    out.push({
      severity: 'warn',
      code: 'SAMPLE_AES',
      title: `${label} uses SAMPLE-AES encryption`,
      detail: 'Recent ffmpeg builds decrypt SAMPLE-AES in MPEG-TS segments (H.264, AAC, AC-3) when the key is reachable. Older builds produce a corrupt file.',
      learnMore: GUIDES.encrypted,
    });
    return;
  }
  const k = m.key;
  if (!k) return;
  if (k.status === null) {
    out.push({
      severity: 'warn',
      code: 'AES_KEY_UNCHECKED',
      title: `${label} is AES-128 encrypted and the key could not be checked`,
      detail: `${k.error ?? 'The key request failed'}. ffmpeg will need to fetch it with the same headers.`,
      learnMore: GUIDES.encrypted,
    });
  } else if (k.status >= 400) {
    out.push({
      severity: 'error',
      code: 'AES_KEY_UNREACHABLE',
      title: `${label} is AES-128 encrypted and the key returns HTTP ${k.status}`,
      detail: 'The key server wants something the request did not send: usually cookies, a Referer or a token that expired. Pass the same headers as the browser (--referer, -H "Cookie: ...") or copy a fresh URL.',
      learnMore: GUIDES.encrypted,
    });
  } else if (k.validLength === false) {
    out.push({
      severity: 'error',
      code: 'AES_KEY_INVALID',
      title: `${label} is AES-128 encrypted but the key URL does not return a 16-byte key`,
      detail: 'The key URL answered with something else (often an HTML login page or a wrapped key). ffmpeg will fail to decrypt.',
      learnMore: GUIDES.encrypted,
    });
  } else {
    out.push({ severity: 'ok', code: 'AES_128', title: `${label} is AES-128 encrypted, key reachable`, detail: 'Standard HLS encryption, not DRM: ffmpeg fetches the key and decrypts on the fly.' });
  }
}

function videoExpected(r: Report): boolean {
  if (tracksOf(r.video, 'video').length > 0) return true;
  if (probed(r.video)) return false;
  const v = r.selected?.variant;
  return v ? hasCodec(v, 'video') !== false : true;
}

function buildFindings(r: Report, master: MasterPlaylist | null, now: Date): Finding[] {
  const out: Finding[] = [];
  const v = r.video;
  const a = r.audio;

  if (master && master.variants.length === 0) out.push({ severity: 'warn', code: 'NO_VARIANTS', title: 'The master playlist lists no variants' });

  if (v) encryptionFindings(v, a ? 'Video' : 'Stream', out);
  if (a) encryptionFindings(a, 'Audio', out);
  if (master) {
    for (const key of master.sessionKeys) {
      const enc = classifyEncryption([key]);
      if (enc.kind === 'drm' && !out.some((f) => f.code === 'DRM')) {
        out.push({ severity: 'error', code: 'DRM', title: `Protected by DRM (${enc.systems.join(', ')}), declared in the master playlist`, detail: DRM_DETAIL });
      }
    }
  }

  // Sound: the reason this tool exists.
  const variant = r.selected?.variant ?? null;
  const hasVideo = videoExpected(r);
  if (a && hasVideo) {
    out.push({
      severity: 'warn',
      code: 'SEPARATE_AUDIO',
      title: 'The audio is in a separate playlist',
      detail: 'The video variant carries no sound of its own. Downloading only the video URL gives a silent file. The command below downloads both and merges them.',
      learnMore: GUIDES.noSound,
    });
  } else if (variant && hasCodec(variant, 'audio') === false && !variant.audioGroup) {
    out.push({
      severity: 'warn',
      code: 'VIDEO_ONLY_VARIANT',
      title: 'The selected variant declares no audio codec',
      detail: `CODECS="${variant.codecs.join(',')}" lists video only and no audio group is attached, so the result will probably be silent.`,
      learnMore: GUIDES.noSound,
    });
  }

  if (probed(v)) {
    const vHasVideo = tracksOf(v, 'video').length > 0;
    const vHasAudio = tracksOf(v, 'audio').length > 0;
    if (!a && vHasVideo && !vHasAudio) {
      out.push({
        severity: 'error',
        code: 'NO_AUDIO_TRACK',
        title: 'This playlist contains video but no sound',
        detail: r.playlist === 'media'
          ? 'You probably copied a variant playlist. The sound lives in another playlist listed by the master playlist (the first .m3u8 the player requests, often master.m3u8, playlist.m3u8 or index.m3u8). Run m3u8-doctor on that one.'
          : 'The first segment has a video track and no audio track. The source itself may be silent, or the audio is served outside HLS.',
        learnMore: r.playlist === 'media' ? GUIDES.findUrl : GUIDES.noSound,
      });
    } else if (!vHasVideo && (vHasAudio || a)) {
      out.push({ severity: 'info', code: 'AUDIO_ONLY', title: 'Audio only: this stream has no picture', ...(r.playlist === 'media' ? { detail: 'Use the master playlist to get the matching video.', learnMore: GUIDES.findUrl } : {}) });
    } else if (vHasVideo && (vHasAudio || a)) {
      const names = [...tracksOf(v, 'video'), ...tracksOf(v, 'audio'), ...tracksOf(a, 'audio')].map((t) => codecName(t.codec));
      out.push({ severity: 'ok', code: 'TRACKS', title: `Picture and sound found (${[...new Set(names)].join(' + ')})` });
    }
    if (tracksOf(v, 'video')[0]?.codec === 'hevc') {
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
        detail: 'The command writes .ts so the file stays playable even if the recording is cut. Press q to stop, or add -t 3600 for one hour. A sliding live playlist cannot give back what aired before.',
        learnMore: GUIDES.live,
      });
    } else if (v.type === 'event') {
      out.push({ severity: 'info', code: 'EVENT', title: 'Event playlist still growing: the recording stops at the current end unless you run it again later', learnMore: GUIDES.live });
    } else {
      const label = v.container === 'fmp4' ? 'fragmented MP4' : v.container === 'mpegts' ? 'MPEG-TS' : v.container === 'packed-audio' ? 'raw audio' : 'unknown format';
      out.push({ severity: 'ok', code: 'VOD', title: `On-demand, ${formatDuration(v.durationSec)} in ${plural(v.segments, 'segment', 'segments')} (${label})` });
    }
    if (v.lowLatency) out.push({ severity: 'info', code: 'LL_HLS', title: 'Low-Latency HLS playlist: ffmpeg reads the full segments and ignores the partial ones' });
    if (v.byteRanges) out.push({ severity: 'info', code: 'BYTERANGE', title: 'Segments are byte ranges of one file (EXT-X-BYTERANGE), ffmpeg handles it' });
    if (v.discontinuities > 0) {
      out.push({
        severity: 'warn',
        code: 'DISCONTINUITY',
        title: `${plural(v.discontinuities, 'discontinuity', 'discontinuities')} (inserted ads or spliced parts)`,
        detail: 'Timestamps restart at each discontinuity. If the result stutters or loses sync, re-encode instead of copying (-c copy).',
      });
    }
    const odd = [...v.segmentExtensions, ...(a?.segmentExtensions ?? [])].filter((e) => DISGUISE_EXT.has(e));
    if (odd.length > 0) {
      out.push({
        severity: 'warn',
        code: 'DISGUISED_SEGMENTS',
        title: `Segments are disguised with non-media extensions (.${[...new Set(odd)].join(', .')})`,
        detail: 'Recent ffmpeg builds check segment extensions. If ffmpeg stops with an error about the extension, add -extension_picky 0 before each -i (that option does not exist in older builds, which accept these segments anyway).',
      });
    }
  }

  if (r.signedUrlExpiresAt) {
    const expired = Date.parse(r.signedUrlExpiresAt) <= now.getTime();
    out.push({
      severity: expired ? 'warn' : 'info',
      code: expired ? 'SIGNED_URL_EXPIRED' : 'SIGNED_URL',
      title: expired ? `The URL looks signed and its expiry date passed (${r.signedUrlExpiresAt})` : `Signed URL, valid until ${r.signedUrlExpiresAt}`,
      detail: expired ? 'The server still answered, but segments or the key may be refused midway. Copy a fresh URL if ffmpeg fails.' : 'Download before it expires, or copy a fresh one from the page.',
      learnMore: GUIDES.findUrl,
    });
  }

  return out;
}

function commandFor(r: Report, ctx: RequestContext, opts: DiagnoseOptions): string | null {
  if (!r.downloadable) return null;
  const video = r.video;
  if (!video || !isHttpUrl(video.url)) return null;
  const headers = { ...(opts.headers ?? {}) };
  delete headers['User-Agent'];
  const userAgent = opts.userAgent ?? (ctx.usedBrowserUA ? BROWSER_UA : null);
  const live = video.type === 'live';
  const hasVideo = videoExpected(r);

  const inputs: CommandInput[] = [];
  const maps: string[] = [];
  if (r.audio && isHttpUrl(r.audio.url) && hasVideo) {
    inputs.push({ url: video.url, headers, userAgent }, { url: r.audio.url, headers, userAgent });
    maps.push('0:v:0', '1:a:0');
  } else {
    inputs.push({ url: r.audio && !hasVideo ? r.audio.url : video.url, headers, userAgent });
    if (!hasVideo) maps.push('0:a:0');
  }
  const ext = live ? 'ts' : hasVideo ? 'mp4' : 'm4a';
  const outputOptions: string[] = [];
  if (hasVideo && !live && tracksOf(video, 'video')[0]?.codec === 'hevc') outputOptions.push('-tag:v', 'hvc1');
  const base = r.url && isHttpUrl(r.url) ? r.url : video.url;
  return buildFfmpegCommand({ inputs, maps, output: opts.output ?? outputName(base, ext), outputOptions }, opts.shell ?? defaultShell());
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

function notHlsFinding(err: PlaylistError): Finding {
  return {
    severity: 'error',
    code: `NOT_HLS_${err.code}`,
    title: err.message,
    ...(err.code === 'DASH' ? { detail: 'Use ffmpeg or yt-dlp directly on the .mpd URL.', learnMore: GUIDES.dash } : {}),
    ...(err.code === 'HTML' ? { detail: 'Often a login page, a geo-block or an expired link. Copy the .m3u8 request from DevTools while the video plays.', learnMore: GUIDES.findUrl } : {}),
  };
}

export async function diagnose(input: string, opts: DiagnoseOptions = {}): Promise<Report> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
  const ctx: RequestContext = { headers, timeoutMs: opts.timeoutMs ?? 15000, usedBrowserUA: false, userAgentGiven: !!opts.userAgent };
  const probe = opts.probe !== false;
  const now = opts.now ?? new Date();

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

  let loaded: LoadedText;
  try {
    loaded = await loadText(input, ctx);
  } catch (err) {
    report.findings.push({ severity: 'error', code: 'FETCH_FAILED', title: (err as Error).message });
    return report;
  }
  report.url = loaded.url;
  const expiry = isHttpUrl(input) ? signedUrlExpiry(input) : null;
  if (expiry) report.signedUrlExpiresAt = new Date(expiry * 1000).toISOString().replace('.000Z', 'Z');

  if (loaded.status >= 400) {
    report.findings.push(httpFinding(loaded.status, ctx));
    if (expiry && expiry * 1000 <= now.getTime()) {
      report.findings.push({ severity: 'info', code: 'SIGNED_URL_EXPIRED', title: `The URL looks signed and expired at ${report.signedUrlExpiresAt}`, detail: 'That is the likely cause: reload the page and copy a fresh URL.', learnMore: GUIDES.findUrl });
    }
    return report;
  }
  if (loaded.truncated) {
    report.findings.push({ severity: 'error', code: 'PLAYLIST_TOO_LARGE', title: 'The playlist is larger than 16 MB and was not analyzed' });
    return report;
  }

  const base = loaded.local ? (opts.baseUrl ?? null) : loaded.url;
  let parsed: Playlist;
  try {
    parsed = parsePlaylist(loaded.text, base);
  } catch (err) {
    if (err instanceof PlaylistError) {
      report.findings.push(notHlsFinding(err));
      return report;
    }
    throw err;
  }
  report.playlist = parsed.kind;
  if (loaded.local && !opts.baseUrl) {
    report.findings.push({ severity: 'info', code: 'RELATIVE_URIS', title: 'Local file: relative URIs cannot be fetched. Pass --base with the playlist URL to inspect variants and segments' });
  }

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
      const fetchable = (u: string | null | undefined): u is string => !!u && isHttpUrl(u);
      const [video, audioReport] = await Promise.all([
        fetchable(variant?.uri) ? fetchMedia(variant!.uri, ctx).then((m) => inspectMedia(variant!.uri, m, ctx, probe)) : Promise.resolve(null),
        fetchable(audio?.uri) ? fetchMedia(audio!.uri!, ctx).then((m) => inspectMedia(audio!.uri!, m, ctx, probe)) : Promise.resolve(null),
      ]);
      report.video = video;
      report.audio = audioReport;
    } else {
      const url = loaded.local ? (opts.baseUrl ?? loaded.url ?? input) : (loaded.url ?? input);
      report.video = await inspectMedia(url, parsed, ctx, probe && isHttpUrl(url));
    }
  } catch (err) {
    report.findings.push({ severity: 'error', code: err instanceof PlaylistError ? `NOT_HLS_${err.code}` : 'MEDIA_FETCH_FAILED', title: (err as Error).message });
  }

  report.findings.push(...buildFindings(report, parsed.kind === 'master' ? parsed : null, now));
  if (ctx.usedBrowserUA) {
    report.findings.push({ severity: 'info', code: 'BROWSER_UA', title: 'The server rejects non-browser clients: the command sends a browser User-Agent' });
  }
  report.downloadable = !report.findings.some((f) => f.severity === 'error' && f.code !== 'NO_AUDIO_TRACK');
  report.command = commandFor(report, ctx, opts);
  return report;
}
