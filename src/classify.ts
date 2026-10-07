/**
 * Pure classification helpers: encryption schemes and codec strings.
 */
import type { KeyTag } from './playlist.js';

export type DrmSystem = 'widevine' | 'playready' | 'fairplay' | 'unknown-drm';

export type Encryption =
  | { kind: 'none' }
  | { kind: 'aes-128'; keyUri: string | null; iv: string | null }
  | { kind: 'sample-aes'; keyUri: string | null }
  | { kind: 'drm'; systems: DrmSystem[] };

const WIDEVINE = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY = 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95';

export function drmSystemOf(key: KeyTag): DrmSystem | null {
  const format = (key.keyFormat ?? '').toLowerCase();
  const uri = (key.uri ?? '').toLowerCase();
  if (format === WIDEVINE) return 'widevine';
  if (format === PLAYREADY || format === 'com.microsoft.playready') return 'playready';
  if (format.startsWith('com.apple.streamingkeydelivery') || format === 'com.apple.fps' || uri.startsWith('skd:')) {
    return 'fairplay';
  }
  if (format === '' || format === 'identity') return null;
  return 'unknown-drm';
}

/** Collapses every key tag of a playlist into one verdict, DRM winning. */
export function classifyEncryption(keys: KeyTag[]): Encryption {
  const drm = new Set<DrmSystem>();
  let aes: KeyTag | null = null;
  let sample: KeyTag | null = null;
  for (const key of keys) {
    if (key.method === 'NONE') continue;
    const system = drmSystemOf(key);
    if (system) {
      drm.add(system);
      continue;
    }
    if (key.method === 'AES-128') aes ??= key;
    else if (key.method === 'SAMPLE-AES') sample ??= key;
    else drm.add('unknown-drm'); // SAMPLE-AES-CTR, SAMPLE-AES-CENC: CENC is a DRM container scheme
  }
  if (drm.size > 0) return { kind: 'drm', systems: [...drm] };
  if (sample) return { kind: 'sample-aes', keyUri: sample.uri };
  if (aes) return { kind: 'aes-128', keyUri: aes.uri, iv: aes.iv };
  return { kind: 'none' };
}

export type CodecKind = 'video' | 'audio' | 'text' | 'unknown';

export function codecKind(codec: string): CodecKind {
  const c = codec.toLowerCase();
  if (/^(avc[1-4]|hvc1|hev1|dvh1|dvhe|av01|vp0?8|vp0?9|mp4v)\b/.test(c)) return 'video';
  if (/^(mp4a|ac-3|ec-3|ac-4|opus|flac|alac|mp3|dtsc|dtse|dtsh|dtsl)\b/.test(c)) return 'audio';
  if (/^(wvtt|stpp|tx3g)\b/.test(c)) return 'text';
  return 'unknown';
}

/** Human name for a CODECS entry or a probed codec id. */
export function codecName(codec: string): string {
  const c = codec.toLowerCase();
  const probed: Record<string, string> = {
    h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', aac: 'AAC', 'aac-latm': 'AAC (LATM)',
    mp3: 'MP3', mpeg1video: 'MPEG-1', mpeg2video: 'MPEG-2', 'dolby-vision': 'Dolby Vision', webvtt: 'WebVTT', ttml: 'TTML',
  };
  if (probed[c]) return probed[c]!;
  if (c.startsWith('avc')) return 'H.264';
  if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'HEVC';
  if (c.startsWith('dvh')) return 'Dolby Vision';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09') || c === 'vp9') return 'VP9';
  if (c.startsWith('vp08') || c === 'vp8') return 'VP8';
  if (c === 'mp4a.40.34' || c === 'mp3' || c === 'mp4a.6b' || c === 'mp4a.69') return 'MP3';
  if (c.startsWith('mp4a')) return 'AAC';
  if (c === 'ac-3') return 'AC-3';
  if (c === 'ec-3') return 'E-AC-3';
  if (c === 'ac-4') return 'AC-4';
  if (c === 'opus') return 'Opus';
  if (c === 'flac') return 'FLAC';
  if (c === 'wvtt') return 'WebVTT';
  return codec;
}

/** Matches signed-URL expiry parameters used by common CDNs. Returns epoch seconds. */
export function signedUrlExpiry(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const q = u.searchParams;
  const asEpoch = (v: string | null): number | null => {
    if (!v || !/^\d{9,13}$/.test(v)) return null;
    const n = Number(v);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  };
  for (const name of ['Expires', 'expires', 'exp', 'e', 'expiry', 'expire', 'Expire']) {
    const v = asEpoch(q.get(name));
    if (v) return v;
  }
  const amzDate = q.get('X-Amz-Date');
  const amzExpires = q.get('X-Amz-Expires');
  if (amzDate && amzExpires && /^\d{8}T\d{6}Z$/.test(amzDate)) {
    const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
    const start = Date.parse(iso);
    if (Number.isFinite(start)) return Math.floor(start / 1000) + Number(amzExpires);
  }
  // Akamai token: hdnts=exp=1700000000~acl=...
  const hdnts = q.get('hdnts') ?? q.get('__token__');
  const m = hdnts ? /(?:^|~)exp=(\d{9,10})/.exec(hdnts) : null;
  if (m) return Number(m[1]);
  return null;
}
