/**
 * HLS playlist parser focused on diagnosis (RFC 8216 + common extensions).
 * Pure: no I/O. Tolerant of real-world playlists (CRLF, BOM, lowercase hex,
 * missing #EXT-X-VERSION, URIs on the line after #EXT-X-STREAM-INF).
 */

export type Attrs = Record<string, string>;

/**
 * Parses an attribute list: KEY=value,KEY="quoted, value",...
 * Linear single pass (no regex backtracking on hostile input).
 */
export function parseAttributes(input: string): Attrs {
  const out: Attrs = {};
  const n = input.length;
  let i = 0;
  while (i < n) {
    while (i < n && (input[i] === ',' || input[i] === ' ' || input[i] === '\t')) i++;
    const keyStart = i;
    while (i < n && input[i] !== '=' && input[i] !== ',') i++;
    const key = input.slice(keyStart, i).trim().toUpperCase();
    if (i >= n || input[i] === ',') continue; // key without value: skip
    i++; // '='
    while (i < n && input[i] === ' ') i++;
    let value: string;
    if (input[i] === '"') {
      const close = input.indexOf('"', i + 1);
      const end = close === -1 ? n : close;
      value = input.slice(i + 1, end);
      i = end + 1;
      while (i < n && input[i] !== ',') i++;
    } else {
      const comma = input.indexOf(',', i);
      const end = comma === -1 ? n : comma;
      value = input.slice(i, end).trim();
      i = end;
    }
    if (/^[A-Z0-9-]+$/.test(key)) out[key] = value;
  }
  return out;
}

export interface Resolution {
  width: number;
  height: number;
}

export interface Variant {
  uri: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  resolution: Resolution | null;
  codecs: string[];
  frameRate: number | null;
  audioGroup: string | null;
  subtitleGroup: string | null;
}

export interface Rendition {
  type: 'AUDIO' | 'SUBTITLES' | 'VIDEO' | 'CLOSED-CAPTIONS';
  groupId: string;
  name: string | null;
  language: string | null;
  isDefault: boolean;
  autoselect: boolean;
  channels: string | null;
  /** Absent when the rendition is muxed into the variant itself. */
  uri: string | null;
}

export interface KeyTag {
  method: string;
  uri: string | null;
  iv: string | null;
  keyFormat: string | null;
}

export interface ByteRange {
  length: number;
  offset: number | null;
}

export interface Segment {
  uri: string;
  duration: number;
  sequence: number;
  key: KeyTag | null;
  byteRange: ByteRange | null;
  /** Init segment; `key` is the EXT-X-KEY in effect when EXT-X-MAP appeared (RFC 8216 4.3.2.5). */
  map: { uri: string; byteRange: ByteRange | null; key: KeyTag | null } | null;
  discontinuity: boolean;
}

export interface MasterPlaylist {
  kind: 'master';
  variants: Variant[];
  renditions: Rendition[];
  iFrameVariants: number;
  sessionKeys: KeyTag[];
  independentSegments: boolean;
}

export interface MediaPlaylist {
  kind: 'media';
  segments: Segment[];
  targetDuration: number | null;
  mediaSequence: number;
  playlistType: 'VOD' | 'EVENT' | null;
  endList: boolean;
  iFramesOnly: boolean;
  lowLatency: boolean;
  discontinuities: number;
  keys: KeyTag[];
}

export type Playlist = MasterPlaylist | MediaPlaylist;

export class PlaylistError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_M3U8' | 'HTML' | 'DASH' | 'EMPTY',
  ) {
    super(message);
    this.name = 'PlaylistError';
  }
}

export function resolveUri(uri: string, base: string | null): string {
  if (!base) return uri;
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function parseByteRange(value: string): ByteRange | null {
  const m = /^\s*(\d+)(?:@(\d+))?\s*$/.exec(value);
  if (!m) return null;
  return { length: Number(m[1]), offset: m[2] !== undefined ? Number(m[2]) : null };
}

function parseResolution(value: string | undefined): Resolution | null {
  if (!value) return null;
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(value.trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toKey(attrs: Attrs, base: string | null): KeyTag {
  return {
    method: (attrs.METHOD ?? 'NONE').toUpperCase(),
    uri: attrs.URI !== undefined ? resolveUri(attrs.URI, base) : null,
    iv: attrs.IV ?? null,
    keyFormat: attrs.KEYFORMAT ?? null,
  };
}

/** Throws PlaylistError with a useful code when the body is not an m3u8. */
export function assertM3u8(text: string): void {
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 512);
  if (head.startsWith('#EXTM3U')) return;
  if (head === '') throw new PlaylistError('The response body is empty.', 'EMPTY');
  if (/^<\?xml[\s\S]*<MPD|^<MPD/i.test(head) || /<MPD[\s>]/i.test(text.slice(0, 4096))) {
    throw new PlaylistError('This is a DASH manifest (.mpd), not an HLS playlist.', 'DASH');
  }
  if (/^<(!doctype|html|head|body)/i.test(head)) {
    throw new PlaylistError('The server returned a web page (HTML), not a playlist.', 'HTML');
  }
  throw new PlaylistError('This is not an HLS playlist (it does not start with #EXTM3U).', 'NOT_M3U8');
}

export function parsePlaylist(text: string, baseUrl: string | null): Playlist {
  assertM3u8(text);
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).map((l) => l.trim());

  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  const sessionKeys: KeyTag[] = [];
  let iFrameVariants = 0;
  let independentSegments = false;

  const segments: Segment[] = [];
  const keys: KeyTag[] = [];
  let targetDuration: number | null = null;
  let mediaSequence = 0;
  let playlistType: 'VOD' | 'EVENT' | null = null;
  let endList = false;
  let iFramesOnly = false;
  let lowLatency = false;
  let discontinuities = 0;
  let isMedia = false;

  let pendingVariant: Attrs | null = null;
  let pendingDuration: number | null = null;
  let pendingByteRange: ByteRange | null = null;
  let pendingDiscontinuity = false;
  let currentKey: KeyTag | null = null;
  let currentMap: Segment['map'] = null;
  const lastRangeEnd = new Map<string, number>();

  for (const line of lines) {
    if (line === '') continue;
    if (!line.startsWith('#')) {
      if (pendingVariant) {
        const a = pendingVariant;
        variants.push({
          uri: resolveUri(line, baseUrl),
          bandwidth: num(a.BANDWIDTH),
          averageBandwidth: num(a['AVERAGE-BANDWIDTH']),
          resolution: parseResolution(a.RESOLUTION),
          codecs: (a.CODECS ?? '').split(',').map((c) => c.trim()).filter(Boolean),
          frameRate: num(a['FRAME-RATE']),
          audioGroup: a.AUDIO ?? null,
          subtitleGroup: a.SUBTITLES ?? null,
        });
        pendingVariant = null;
      } else if (pendingDuration !== null) {
        const uri = resolveUri(line, baseUrl);
        let byteRange = pendingByteRange;
        if (byteRange && byteRange.offset === null) {
          const prevEnd = lastRangeEnd.get(uri);
          byteRange = { length: byteRange.length, offset: prevEnd ?? 0 };
        }
        if (byteRange && byteRange.offset !== null) lastRangeEnd.set(uri, byteRange.offset + byteRange.length);
        segments.push({
          uri,
          duration: pendingDuration,
          sequence: mediaSequence + segments.length,
          key: currentKey,
          byteRange,
          map: currentMap,
          discontinuity: pendingDiscontinuity,
        });
        pendingDuration = null;
        pendingByteRange = null;
        pendingDiscontinuity = false;
      }
      continue;
    }

    const colon = line.indexOf(':');
    const tag = (colon === -1 ? line : line.slice(0, colon)).toUpperCase();
    const value = colon === -1 ? '' : line.slice(colon + 1);

    switch (tag) {
      case '#EXT-X-STREAM-INF':
        pendingVariant = parseAttributes(value);
        break;
      case '#EXT-X-I-FRAME-STREAM-INF':
        iFrameVariants++;
        break;
      case '#EXT-X-MEDIA': {
        const a = parseAttributes(value);
        const type = (a.TYPE ?? '').toUpperCase();
        if (type === 'AUDIO' || type === 'SUBTITLES' || type === 'VIDEO' || type === 'CLOSED-CAPTIONS') {
          renditions.push({
            type,
            groupId: a['GROUP-ID'] ?? '',
            name: a.NAME ?? null,
            language: a.LANGUAGE ?? null,
            isDefault: (a.DEFAULT ?? '').toUpperCase() === 'YES',
            autoselect: (a.AUTOSELECT ?? '').toUpperCase() === 'YES',
            channels: a.CHANNELS ?? null,
            uri: a.URI !== undefined ? resolveUri(a.URI, baseUrl) : null,
          });
        }
        break;
      }
      case '#EXT-X-SESSION-KEY':
        sessionKeys.push(toKey(parseAttributes(value), baseUrl));
        break;
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        independentSegments = true;
        break;
      case '#EXTINF': {
        isMedia = true;
        const d = Number.parseFloat(value.split(',')[0] ?? '');
        pendingDuration = Number.isFinite(d) && d >= 0 ? d : 0;
        break;
      }
      case '#EXT-X-TARGETDURATION':
        isMedia = true;
        targetDuration = num(value);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        mediaSequence = Math.max(0, Math.floor(num(value) ?? 0));
        break;
      case '#EXT-X-PLAYLIST-TYPE': {
        const t = value.trim().toUpperCase();
        playlistType = t === 'VOD' || t === 'EVENT' ? t : null;
        break;
      }
      case '#EXT-X-ENDLIST':
        endList = true;
        break;
      case '#EXT-X-I-FRAMES-ONLY':
        iFramesOnly = true;
        break;
      case '#EXT-X-PART':
      case '#EXT-X-PART-INF':
      case '#EXT-X-PRELOAD-HINT':
        lowLatency = true;
        break;
      case '#EXT-X-DISCONTINUITY':
        discontinuities++;
        pendingDiscontinuity = true;
        break;
      case '#EXT-X-BYTERANGE':
        pendingByteRange = parseByteRange(value);
        break;
      case '#EXT-X-KEY': {
        const key = toKey(parseAttributes(value), baseUrl);
        currentKey = key.method === 'NONE' ? null : key;
        if (key.method !== 'NONE') keys.push(key);
        break;
      }
      case '#EXT-X-MAP': {
        const a = parseAttributes(value);
        currentMap = a.URI !== undefined
          ? { uri: resolveUri(a.URI, baseUrl), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null, key: currentKey }
          : null;
        break;
      }
      default:
        break;
    }
  }

  if (!isMedia && (variants.length > 0 || renditions.length > 0)) {
    return { kind: 'master', variants, renditions, iFrameVariants, sessionKeys, independentSegments };
  }
  return {
    kind: 'media',
    segments,
    targetDuration,
    mediaSequence,
    playlistType,
    endList,
    iFramesOnly,
    lowLatency,
    discontinuities,
    keys,
  };
}
