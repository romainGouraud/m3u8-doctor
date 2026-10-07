/**
 * Track sniffing from the first bytes of a segment: MPEG-TS (PAT/PMT),
 * fragmented MP4 init segments (moov/trak/hdlr/stsd) and packed audio
 * (raw ADTS AAC, MP3, AC-3 with optional ID3 header). Pure: bytes in, tracks out.
 */

export interface SniffedTrack {
  type: 'video' | 'audio' | 'text' | 'data';
  codec: string;
  encrypted?: boolean;
}

export interface SniffResult {
  container: 'mpegts' | 'mp4' | 'packed-audio' | 'unknown';
  tracks: SniffedTrack[];
  /** DRM system ids found in pssh boxes (fMP4 only). */
  psshSystems: string[];
  /** CENC scheme (cenc, cbcs...) when sample entries are encrypted. */
  scheme: string | null;
}

const TS_PACKET = 188;

const TS_STREAM_TYPES: Record<number, SniffedTrack> = {
  0x01: { type: 'video', codec: 'mpeg1video' },
  0x02: { type: 'video', codec: 'mpeg2video' },
  0x03: { type: 'audio', codec: 'mp3' },
  0x04: { type: 'audio', codec: 'mp3' },
  0x0f: { type: 'audio', codec: 'aac' },
  0x11: { type: 'audio', codec: 'aac-latm' },
  0x1b: { type: 'video', codec: 'h264' },
  0x24: { type: 'video', codec: 'hevc' },
  0x81: { type: 'audio', codec: 'ac-3' },
  0x87: { type: 'audio', codec: 'ec-3' },
  0x15: { type: 'data', codec: 'id3' },
  0x86: { type: 'data', codec: 'scte35' },
  // Apple SAMPLE-AES stream types
  0xdb: { type: 'video', codec: 'h264', encrypted: true },
  0xcf: { type: 'audio', codec: 'aac', encrypted: true },
  0xc1: { type: 'audio', codec: 'ac-3', encrypted: true },
  0xc2: { type: 'audio', codec: 'ec-3', encrypted: true },
};

function findTsSync(b: Uint8Array): number {
  const limit = Math.min(b.length - TS_PACKET * 2, 4096);
  for (let i = 0; i < limit; i++) {
    if (b[i] === 0x47 && b[i + TS_PACKET] === 0x47 && b[i + TS_PACKET * 2] === 0x47) return i;
  }
  // A single packet in a short buffer still counts.
  if (b.length >= TS_PACKET && b[0] === 0x47) return 0;
  return -1;
}

function tsPayload(b: Uint8Array, p: number): { pid: number; start: boolean; payload: Uint8Array } | null {
  if (b[p] !== 0x47) return null;
  const pid = ((b[p + 1]! & 0x1f) << 8) | b[p + 2]!;
  const start = (b[p + 1]! & 0x40) !== 0;
  const afc = (b[p + 3]! >> 4) & 0x3;
  let off = p + 4;
  if (afc === 2) return null; // adaptation only
  if (afc === 3) off += 1 + b[off]!;
  if (off >= p + TS_PACKET) return null;
  return { pid, start, payload: b.subarray(off, p + TS_PACKET) };
}

function sectionOf(payload: Uint8Array): Uint8Array | null {
  const pointer = payload[0];
  if (pointer === undefined) return null;
  const s = payload.subarray(1 + pointer);
  if (s.length < 3) return null;
  const len = ((s[1]! & 0x0f) << 8) | s[2]!;
  return s.subarray(0, Math.min(s.length, 3 + len));
}

function readDescriptors(d: Uint8Array): { tag: number; data: Uint8Array }[] {
  const out: { tag: number; data: Uint8Array }[] = [];
  let i = 0;
  while (i + 2 <= d.length) {
    const tag = d[i]!;
    const len = d[i + 1]!;
    out.push({ tag, data: d.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

function privateStreamTrack(descriptors: { tag: number; data: Uint8Array }[]): SniffedTrack {
  for (const { tag, data } of descriptors) {
    if (tag === 0x6a) return { type: 'audio', codec: 'ac-3' };
    if (tag === 0x7a) return { type: 'audio', codec: 'ec-3' };
    if (tag === 0x59) return { type: 'text', codec: 'dvb-subtitles' };
    if (tag === 0x56) return { type: 'text', codec: 'teletext' };
    if (tag === 0x05 && data.length >= 4) {
      const id = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
      if (id === 'Opus') return { type: 'audio', codec: 'opus' };
      if (id === 'AC-3') return { type: 'audio', codec: 'ac-3' };
      if (id === 'EAC3') return { type: 'audio', codec: 'ec-3' };
      if (id === 'ID3 ') return { type: 'data', codec: 'id3' };
    }
  }
  return { type: 'data', codec: 'private' };
}

export function sniffTs(b: Uint8Array): SniffedTrack[] | null {
  let p = findTsSync(b);
  if (p < 0) return null;
  let pmtPid: number | null = null;
  for (; p + TS_PACKET <= b.length; p += TS_PACKET) {
    const pkt = tsPayload(b, p);
    if (!pkt || !pkt.start) continue;
    if (pkt.pid === 0 && pmtPid === null) {
      const s = sectionOf(pkt.payload);
      if (!s || s[0] !== 0x00) continue;
      const end = s.length - 4; // CRC
      for (let i = 8; i + 4 <= end; i += 4) {
        const program = (s[i]! << 8) | s[i + 1]!;
        const pid = ((s[i + 2]! & 0x1f) << 8) | s[i + 3]!;
        if (program !== 0) {
          pmtPid = pid;
          break;
        }
      }
    } else if (pmtPid !== null && pkt.pid === pmtPid) {
      const s = sectionOf(pkt.payload);
      if (!s || s[0] !== 0x02 || s.length < 12) continue;
      const end = s.length - 4;
      const programInfoLength = ((s[10]! & 0x0f) << 8) | s[11]!;
      const tracks: SniffedTrack[] = [];
      for (let i = 12 + programInfoLength; i + 5 <= end; ) {
        const streamType = s[i]!;
        const esInfoLength = ((s[i + 3]! & 0x0f) << 8) | s[i + 4]!;
        const descriptors = readDescriptors(s.subarray(i + 5, i + 5 + esInfoLength));
        const known = TS_STREAM_TYPES[streamType];
        tracks.push(known ? { ...known } : streamType === 0x06 ? privateStreamTrack(descriptors) : { type: 'data', codec: `0x${streamType.toString(16)}` });
        i += 5 + esInfoLength;
      }
      return tracks;
    }
  }
  return [];
}

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'sinf', 'schi', 'dinf']);
const VISUAL_ENTRY_HEADER = 78;
const AUDIO_ENTRY_HEADER = 28;

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > end) return;
      const hi = u32(b, o + 8);
      const lo = u32(b, o + 12);
      size = hi * 2 ** 32 + lo;
      body = o + 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < 8) return;
    const boxEnd = Math.min(o + size, end);
    yield { type, start: o, end: boxEnd, body };
    o += size;
  }
}

function hexId(b: Uint8Array, o: number): string {
  const h = Array.from(b.subarray(o, o + 16), (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const SAMPLE_ENTRY_CODECS: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', dvh1: 'dolby-vision', dvhe: 'dolby-vision',
  av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4a: 'aac', 'ac-3': 'ac-3', 'ec-3': 'ec-3', 'ac-4': 'ac-4',
  Opus: 'opus', fLaC: 'flac', '.mp3': 'mp3', wvtt: 'webvtt', stpp: 'ttml',
};

export function sniffMp4(b: Uint8Array): Omit<SniffResult, 'container'> | null {
  if (b.length < 8) return null;
  const firstType = fourcc(b, 4);
  if (!['ftyp', 'styp', 'moov', 'moof', 'sidx', 'free', 'emsg', 'prft'].includes(firstType)) return null;

  const tracks: SniffedTrack[] = [];
  const pssh = new Set<string>();
  let scheme: string | null = null;

  const walk = (start: number, end: number, handler: string | null): string | null => {
    let currentHandler = handler;
    for (const box of boxes(b, start, end)) {
      if (box.type === 'pssh' && box.body + 20 <= box.end) pssh.add(hexId(b, box.body + 4));
      if (box.type === 'hdlr' && box.body + 12 <= box.end) currentHandler = fourcc(b, box.body + 8);
      if (box.type === 'schm' && box.body + 8 <= box.end) scheme = fourcc(b, box.body + 4);
      if (box.type === 'stsd' && box.body + 8 <= box.end) {
        for (const entry of boxes(b, box.body + 8, box.end)) {
          const encrypted = entry.type === 'encv' || entry.type === 'enca';
          let codecType = entry.type;
          const headerLen = currentHandler === 'soun' || entry.type === 'enca' ? AUDIO_ENTRY_HEADER : VISUAL_ENTRY_HEADER;
          if (encrypted) {
            for (const child of boxes(b, entry.body + headerLen, entry.end)) {
              if (child.type === 'sinf') {
                for (const s of boxes(b, child.body, child.end)) {
                  if (s.type === 'frma' && s.body + 4 <= s.end) codecType = fourcc(b, s.body);
                  if (s.type === 'schm' && s.body + 8 <= s.end) scheme = fourcc(b, s.body + 4);
                }
              }
            }
          }
          const type: SniffedTrack['type'] =
            currentHandler === 'vide' ? 'video' : currentHandler === 'soun' ? 'audio' : currentHandler === 'text' || currentHandler === 'subt' ? 'text' : 'data';
          tracks.push({ type, codec: SAMPLE_ENTRY_CODECS[codecType] ?? codecType, ...(encrypted ? { encrypted: true } : {}) });
        }
      }
      if (MP4_CONTAINERS.has(box.type)) {
        const inner = walk(box.body, box.end, box.type === 'trak' ? null : currentHandler);
        if (box.type !== 'trak') currentHandler = inner;
      }
    }
    return currentHandler;
  };
  walk(0, b.length, null);
  return { tracks, psshSystems: [...pssh], scheme };
}

function skipId3(b: Uint8Array): number {
  let o = 0;
  while (o + 10 <= b.length && b[o] === 0x49 && b[o + 1] === 0x44 && b[o + 2] === 0x33) {
    const size = ((b[o + 6]! & 0x7f) << 21) | ((b[o + 7]! & 0x7f) << 14) | ((b[o + 8]! & 0x7f) << 7) | (b[o + 9]! & 0x7f);
    o += 10 + size + ((b[o + 5]! & 0x10) !== 0 ? 10 : 0);
  }
  return o;
}

export function sniffPackedAudio(b: Uint8Array): SniffedTrack | null {
  const o = skipId3(b);
  if (o + 2 > b.length) return null;
  const b0 = b[o]!;
  const b1 = b[o + 1]!;
  if (b0 === 0x0b && b1 === 0x77) return { type: 'audio', codec: 'ac-3' };
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return { type: 'audio', codec: 'aac' }; // ADTS, layer 00
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0) return { type: 'audio', codec: 'mp3' };
  return null;
}

export function sniff(b: Uint8Array): SniffResult {
  const mp4 = sniffMp4(b);
  if (mp4) return { container: 'mp4', ...mp4 };
  const ts = sniffTs(b);
  if (ts) return { container: 'mpegts', tracks: ts, psshSystems: [], scheme: null };
  const packed = sniffPackedAudio(b);
  if (packed) return { container: 'packed-audio', tracks: [packed], psshSystems: [], scheme: null };
  return { container: 'unknown', tracks: [], psshSystems: [], scheme: null };
}
