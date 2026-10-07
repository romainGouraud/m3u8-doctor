import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { diagnose } from '../dist/index.js';
import { aes128, makeInit, makeTs, serve } from './helpers.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const media = (seg, extra = '') => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${extra}#EXTINF:6,\n${seg}\n#EXTINF:6,\n${seg}\n#EXT-X-ENDLIST\n`;

let srv;
before(async () => {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(0, 12); // media sequence 0
  srv = await serve({
    // muxed TS
    '/muxed/master.m3u8': { body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nv.m3u8\n' },
    '/muxed/v.m3u8': { body: media('s.ts') },
    '/muxed/s.ts': { body: makeTs([0x1b, 0x0f]), type: 'video/mp2t' },
    // separate audio, fMP4
    '/split/master.m3u8': {
      body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"\nv.m3u8\n',
    },
    '/split/v.m3u8': { body: media('v.m4s', '#EXT-X-MAP:URI="vinit.mp4"\n') },
    '/split/a.m3u8': { body: media('a.m4s', '#EXT-X-MAP:URI="ainit.mp4"\n') },
    '/split/vinit.mp4': { body: makeInit([{ handler: 'vide', entry: 'avc1' }]), type: 'video/mp4' },
    '/split/ainit.mp4': { body: makeInit([{ handler: 'soun', entry: 'mp4a' }]), type: 'audio/mp4' },
    // video-only variant copied from DevTools
    '/silent/v.m3u8': { body: media('s.ts') },
    '/silent/s.ts': { body: makeTs([0x1b]) },
    // AES-128
    '/aes/v.m3u8': { body: media('s.ts', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n') },
    '/aes/key': { body: KEY, type: 'application/octet-stream' },
    '/aes/s.ts': { body: aes128(makeTs([0x1b, 0x0f]), KEY, iv) },
    '/aeslocked/v.m3u8': { body: media('s.ts', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n') },
    '/aeslocked/key': { status: 403, body: 'nope' },
    // DRM
    '/drm/v.m3u8': { body: media('s.m4s', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-MAP:URI="init.mp4"\n') },
    // live
    '/live/v.m3u8': { body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:900\n#EXTINF:4,\ns.ts\n#EXTINF:4,\ns.ts\n' },
    '/live/s.ts': { body: makeTs([0x1b, 0x0f]) },
    // browser-only CDN + Referer check
    '/ua/v.m3u8': { body: media('s.ts'), requireUA: true },
    '/ua/s.ts': { body: makeTs([0x1b, 0x0f]), requireUA: true },
    '/ref/v.m3u8': { body: media('s.ts'), requireReferer: 'https://site.example/watch/1' },
    '/ref/s.ts': { body: makeTs([0x1b, 0x0f]), requireReferer: 'https://site.example/watch/1' },
    // errors
    '/html': { body: '<!doctype html><title>Login</title>', type: 'text/html' },
    '/dash.mpd': { body: '<?xml version="1.0"?><MPD></MPD>', type: 'application/dash+xml' },
    '/gone.m3u8': { status: 410, body: '' },
    // disguised segments + discontinuity + HEVC
    '/odd/v.m3u8': { body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.jpg\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\na.jpg\n#EXT-X-ENDLIST\n' },
    '/odd/a.jpg': { body: makeTs([0x24, 0x0f]), type: 'image/jpeg' },
    // server ignoring Range must still be probed (body capped)
    '/norange/v.m3u8': { body: media('s.ts') },
    '/norange/s.ts': { body: makeTs([0x1b, 0x0f], { size: 188 * 4000 }), ignoreRange: true },
  });
});
after(() => srv.close());

const codes = (r) => r.findings.map((f) => f.code);

test('muxed stream: sound found, plain command', async () => {
  const r = await diagnose(`${srv.url}/muxed/master.m3u8`, { shell: 'posix' });
  assert.equal(r.playlist, 'master');
  assert.ok(codes(r).includes('TRACKS'));
  assert.ok(!codes(r).includes('SEPARATE_AUDIO'));
  assert.equal(r.command, `ffmpeg -i ${srv.url}/muxed/v.m3u8 -c copy muxed.mp4`);
  assert.equal(r.downloadable, true);
});

test('separate audio: two inputs mapped together', async () => {
  const r = await diagnose(`${srv.url}/split/master.m3u8`, { shell: 'posix' });
  assert.ok(codes(r).includes('SEPARATE_AUDIO'));
  assert.equal(r.audio.container, 'fmp4');
  assert.equal(r.command, `ffmpeg -i ${srv.url}/split/v.m3u8 -i ${srv.url}/split/a.m3u8 -map 0:v:0 -map 1:a:0 -c copy split.mp4`);
});

test('variant without audio is reported as silent', async () => {
  const r = await diagnose(`${srv.url}/silent/v.m3u8`);
  assert.ok(codes(r).includes('NO_AUDIO_TRACK'));
  assert.equal(r.findings.find((f) => f.code === 'NO_AUDIO_TRACK').severity, 'error');
});

test('AES-128: key fetched, segment decrypted, tracks read', async () => {
  const r = await diagnose(`${srv.url}/aes/v.m3u8`);
  assert.ok(codes(r).includes('AES_128'));
  assert.deepEqual(r.video.probe.tracks.map((t) => t.codec), ['h264', 'aac']);
});

test('AES-128 with a forbidden key is blocking', async () => {
  const r = await diagnose(`${srv.url}/aeslocked/v.m3u8`);
  assert.ok(codes(r).includes('AES_KEY_UNREACHABLE'));
  assert.equal(r.downloadable, false);
  assert.equal(r.command, null);
});

test('FairPlay DRM: no command, no segment request', async () => {
  const before = srv.requests.length;
  const r = await diagnose(`${srv.url}/drm/v.m3u8`);
  assert.ok(codes(r).includes('DRM'));
  assert.equal(r.command, null);
  assert.deepEqual(srv.requests.slice(before).map((q) => q.url), ['/drm/v.m3u8']);
});

test('live playlist is flagged', async () => {
  const r = await diagnose(`${srv.url}/live/v.m3u8`);
  assert.equal(r.video.type, 'live');
  assert.ok(codes(r).includes('LIVE'));
});

test('403 to non-browsers: retried as a browser, UA carried into the command', async () => {
  const r = await diagnose(`${srv.url}/ua/v.m3u8`, { shell: 'posix' });
  assert.ok(codes(r).includes('BROWSER_UA'));
  assert.ok(codes(r).includes('TRACKS'));
  assert.match(r.command, /^ffmpeg -user_agent 'Mozilla\/5\.0 /);
});

test('Referer is sent to every request and into the command', async () => {
  const r = await diagnose(`${srv.url}/ref/v.m3u8`, { headers: { Referer: 'https://site.example/watch/1' }, shell: 'posix' });
  assert.ok(codes(r).includes('TRACKS'));
  assert.match(r.command, /-referer https:\/\/site\.example\/watch\/1 -i /);
  const denied = await diagnose(`${srv.url}/ref/v.m3u8`);
  assert.ok(codes(denied).includes('HTTP_FORBIDDEN'));
});

test('HTML, DASH and 410 inputs explain themselves', async () => {
  assert.deepEqual(codes(await diagnose(`${srv.url}/html`)), ['NOT_HLS_HTML']);
  assert.deepEqual(codes(await diagnose(`${srv.url}/dash.mpd`)), ['NOT_HLS_DASH']);
  assert.deepEqual(codes(await diagnose(`${srv.url}/gone.m3u8`)), ['HTTP_GONE']);
  assert.deepEqual(codes(await diagnose('http://127.0.0.1:1/x.m3u8', { timeoutMs: 2000 })), ['FETCH_FAILED']);
});

test('disguised .jpg segments, discontinuity and HEVC tag', async () => {
  const r = await diagnose(`${srv.url}/odd/v.m3u8`, { shell: 'posix' });
  assert.ok(codes(r).includes('DISGUISED_SEGMENTS'));
  assert.ok(codes(r).includes('DISCONTINUITY'));
  assert.ok(codes(r).includes('HEVC_TAG'));
  assert.match(r.command, /-tag:v hvc1/);
});

test('server ignoring Range: probe reads a bounded prefix only', async () => {
  const r = await diagnose(`${srv.url}/norange/v.m3u8`);
  assert.deepEqual(r.video.probe.tracks.map((t) => t.codec), ['h264', 'aac']);
});

test('expired signed URL is reported even when the server still answers', async () => {
  const r = await diagnose(`${srv.url}/muxed/master.m3u8?Expires=1500000000`);
  assert.ok(codes(r).includes('SIGNED_URL_EXPIRED'));
});

test('--no-probe skips segment requests', async () => {
  const before = srv.requests.length;
  await diagnose(`${srv.url}/muxed/master.m3u8`, { probe: false });
  assert.deepEqual(srv.requests.slice(before).map((q) => q.url), ['/muxed/master.m3u8', '/muxed/v.m3u8']);
});

test('CLI: exit codes, JSON output, help', async () => {
  const ok = await run('node', [CLI, `${srv.url}/muxed/master.m3u8`, '--no-color']);
  assert.match(ok.stdout, /Command\n {2}ffmpeg -i /);
  const json = JSON.parse((await run('node', [CLI, `${srv.url}/split/master.m3u8`, '--json'])).stdout);
  assert.equal(json.audio.url, `${srv.url}/split/a.m3u8`);
  await assert.rejects(run('node', [CLI, `${srv.url}/silent/v.m3u8`]), (e) => e.code === 1 && /silent/.test(e.stdout));
  await assert.rejects(run('node', [CLI, `${srv.url}/drm/v.m3u8`]), (e) => e.code === 2);
  await assert.rejects(run('node', [CLI, '-H', 'bad']), (e) => e.code === 1 && /invalid header/.test(e.stderr));
  assert.match((await run('node', [CLI, '--help'])).stdout, /Usage/);
});
