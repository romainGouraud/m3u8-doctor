import { createCipheriv } from 'node:crypto';
import { createServer } from 'node:http';

/** One 188-byte TS packet carrying a PSI section on `pid`. */
function psiPacket(pid, section) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = 0x40 | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10; // payload only
  p[4] = 0x00; // pointer field
  section.copy(p, 5);
  return p;
}

/** Minimal MPEG-TS start: PAT + PMT declaring `streamTypes`, padded to `size`. */
export function makeTs(streamTypes, { size = 188 * 20, esDescriptors = {} } = {}) {
  const pmtPid = 0x1000;
  const pat = Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0]);
  const es = [];
  streamTypes.forEach((t, i) => {
    const d = esDescriptors[i] ?? Buffer.alloc(0);
    const pid = 0x100 + i;
    es.push(Buffer.from([t, 0xe0 | (pid >> 8), pid & 0xff, 0xf0 | (d.length >> 8), d.length & 0xff]), d);
  });
  const esBuf = Buffer.concat(es);
  const sectionLength = 9 + esBuf.length + 4;
  const pmt = Buffer.concat([
    Buffer.from([0x02, 0xb0 | (sectionLength >> 8), sectionLength & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00]),
    esBuf,
    Buffer.alloc(4),
  ]);
  const out = [psiPacket(0, pat), psiPacket(pmtPid, pmt)];
  while (out.length * 188 < size) {
    const filler = Buffer.alloc(188, 0xff);
    filler[0] = 0x47;
    filler[1] = 0x1f;
    filler[2] = 0xff;
    filler[3] = 0x10;
    out.push(filler);
  }
  return Buffer.concat(out);
}

function box(type, ...children) {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(type, payload) {
  return box(type, Buffer.alloc(4), payload);
}

function hdlr(handler) {
  return fullBox('hdlr', Buffer.concat([Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(13)]));
}

function sampleEntry(type, headerLen, ...children) {
  return box(type, Buffer.alloc(headerLen), ...children);
}

/** fMP4 init segment with one trak per { handler, entry, encrypted?, scheme? }. */
export function makeInit(tracks, { pssh = [] } = {}) {
  const traks = tracks.map((t) => {
    const headerLen = t.handler === 'soun' ? 28 : 78;
    const children = t.encrypted
      ? [box('sinf', box('frma', Buffer.from(t.entry, 'latin1')), fullBox('schm', Buffer.concat([Buffer.from(t.scheme ?? 'cenc', 'latin1'), Buffer.alloc(4)])))]
      : [];
    const entryType = t.encrypted ? (t.handler === 'soun' ? 'enca' : 'encv') : t.entry;
    const entryCount = Buffer.alloc(4);
    entryCount.writeUInt32BE(1);
    const stsd = fullBox('stsd', Buffer.concat([entryCount, sampleEntry(entryType, headerLen, ...children)]));
    return box('trak', box('mdia', hdlr(t.handler), box('minf', box('stbl', stsd))));
  });
  const psshBoxes = pssh.map((id) => fullBox('pssh', Buffer.concat([Buffer.from(id.replace(/-/g, ''), 'hex'), Buffer.alloc(4)])));
  return Buffer.concat([box('ftyp', Buffer.from('iso6', 'latin1'), Buffer.alloc(4)), box('moov', ...psshBoxes, ...traks)]);
}

export function aes128(data, key, iv) {
  const c = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

/**
 * Serves `routes`: { '/path': { status?, body, type?, requireUA?, requireReferer? } | (req) => route }.
 * Records every request. Returns { url, requests, close }.
 */
export async function serve(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const path = (req.url ?? '/').split('?')[0];
    let route = routes[path];
    if (typeof route === 'function') route = route(req);
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    if (route.requireUA && !/Mozilla/.test(req.headers['user-agent'] ?? '')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (route.requireReferer && req.headers.referer !== route.requireReferer) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body ?? '');
    let status = route.status ?? 200;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (range && status === 200 && !route.ignoreRange) {
      body = body.subarray(Number(range[1]), Number(range[2]) + 1);
      status = 206;
    }
    res.writeHead(status, { 'content-type': route.type ?? 'application/vnd.apple.mpegurl' }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
