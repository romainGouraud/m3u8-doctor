import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertM3u8, buildFfmpegCommand, classifyEncryption, codecKind, outputName, parseAttributes, parsePlaylist,
  pickVariant, quote, signedUrlExpiry, sniff, PlaylistError,
} from '../dist/index.js';
import { makeInit, makeTs } from './helpers.js';

test('parseAttributes keeps commas inside quotes', () => {
  const a = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aac"');
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.AUDIO, 'aac');
});

test('master playlist: variants, renditions and resolved URIs', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Français",LANGUAGE="fr",URI="subs/fr.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud",FRAME-RATE=29.97',
    'https://cdn.example.com/high/index.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"',
  ].join('\r\n');
  const p = parsePlaylist(text, 'https://example.com/v/master.m3u8?token=1');
  assert.equal(p.kind, 'master');
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].uri, 'https://example.com/v/low/index.m3u8');
  assert.equal(p.variants[1].frameRate, 29.97);
  assert.equal(p.renditions.find((r) => r.type === 'AUDIO').uri, 'https://example.com/v/audio/en.m3u8');
  assert.equal(p.iFrameVariants, 1);
  assert.equal(pickVariant(p.variants).resolution.height, 1080);
  assert.equal(pickVariant(p.variants, 720).resolution.height, 360);
});

test('media playlist: duration, keys, byte ranges, discontinuities, map', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000a
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@0
media.mp4
#EXTINF:5.5,
#EXT-X-BYTERANGE:1200
media.mp4
#EXT-X-DISCONTINUITY
#EXTINF:4,
seg3.m4s
#EXT-X-ENDLIST`;
  const p = parsePlaylist(text, 'https://example.com/a/b.m3u8');
  assert.equal(p.kind, 'media');
  assert.equal(p.segments.length, 3);
  assert.equal(p.segments[0].sequence, 10);
  assert.deepEqual(p.segments[1].byteRange, { length: 1200, offset: 1000 });
  assert.equal(p.segments[2].discontinuity, true);
  assert.equal(p.discontinuities, 1);
  assert.equal(p.endList, true);
  assert.equal(p.segments[0].map.uri, 'https://example.com/a/init.mp4');
  assert.equal(p.segments[0].key.uri, 'https://example.com/a/key.bin');
  assert.equal(classifyEncryption(p.keys).kind, 'aes-128');
});

test('assertM3u8 recognises HTML, DASH and empty bodies', () => {
  const code = (t) => {
    try {
      assertM3u8(t);
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof PlaylistError);
      return e.code;
    }
  };
  assert.equal(code('﻿#EXTM3U\n'), 'ok');
  assert.equal(code('<!DOCTYPE html><html>'), 'HTML');
  assert.equal(code('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'), 'DASH');
  assert.equal(code('   '), 'EMPTY');
  assert.equal(code('{"error":"denied"}'), 'NOT_M3U8');
});

test('classifyEncryption: DRM wins, identity SAMPLE-AES is not DRM', () => {
  const k = (method, keyFormat = null, uri = 'https://k') => ({ method, uri, iv: null, keyFormat });
  assert.deepEqual(classifyEncryption([]), { kind: 'none' });
  assert.equal(classifyEncryption([k('SAMPLE-AES')]).kind, 'sample-aes');
  assert.deepEqual(classifyEncryption([k('SAMPLE-AES', 'com.apple.streamingkeydelivery', 'skd://x')]), { kind: 'drm', systems: ['fairplay'] });
  assert.deepEqual(classifyEncryption([k('SAMPLE-AES-CTR', 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')]), { kind: 'drm', systems: ['widevine'] });
  assert.deepEqual(classifyEncryption([k('AES-128'), k('SAMPLE-AES-CTR', 'com.microsoft.playready')]), { kind: 'drm', systems: ['playready'] });
  assert.deepEqual(classifyEncryption([k('SAMPLE-AES-CTR')]), { kind: 'drm', systems: ['unknown-drm'] });
});

test('codecKind', () => {
  assert.equal(codecKind('avc1.640028'), 'video');
  assert.equal(codecKind('hvc1.2.4.L123.B0'), 'video');
  assert.equal(codecKind('mp4a.40.2'), 'audio');
  assert.equal(codecKind('ec-3'), 'audio');
  assert.equal(codecKind('wvtt'), 'text');
});

test('signedUrlExpiry: Expires, X-Amz, Akamai, and ignores small numbers', () => {
  assert.equal(signedUrlExpiry('https://x/a.m3u8?Expires=1760000000&Signature=abc'), 1760000000);
  assert.equal(signedUrlExpiry('https://x/a.m3u8?X-Amz-Date=20261007T120000Z&X-Amz-Expires=3600'), Date.UTC(2026, 9, 7, 13) / 1000);
  assert.equal(signedUrlExpiry('https://x/a.m3u8?hdnts=st=1~exp=1760000000~acl=/*~hmac=ff'), 1760000000);
  assert.equal(signedUrlExpiry('https://x/a.m3u8?e=42'), null);
  assert.equal(signedUrlExpiry('https://x/a.m3u8'), null);
});

test('sniff MPEG-TS PMT', () => {
  assert.deepEqual(sniff(makeTs([0x1b, 0x0f])).tracks.map((t) => `${t.type}:${t.codec}`), ['video:h264', 'audio:aac']);
  assert.deepEqual(sniff(makeTs([0x24])).tracks.map((t) => t.codec), ['hevc']);
  const ac3 = makeTs([0x1b, 0x06], { esDescriptors: { 1: Buffer.from([0x6a, 0x01, 0x00]) } });
  assert.equal(sniff(ac3).tracks[1].codec, 'ac-3');
  assert.equal(sniff(makeTs([0xdb, 0xcf])).tracks.every((t) => t.encrypted), true);
});

test('sniff fMP4 init: handlers, codecs, CENC and pssh', () => {
  const plain = sniff(makeInit([{ handler: 'vide', entry: 'avc1' }, { handler: 'soun', entry: 'mp4a' }]));
  assert.equal(plain.container, 'mp4');
  assert.deepEqual(plain.tracks.map((t) => `${t.type}:${t.codec}`), ['video:h264', 'audio:aac']);
  const enc = sniff(makeInit([{ handler: 'vide', entry: 'hvc1', encrypted: true, scheme: 'cbcs' }], { pssh: ['edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'] }));
  assert.equal(enc.tracks[0].codec, 'hevc');
  assert.equal(enc.tracks[0].encrypted, true);
  assert.equal(enc.scheme, 'cbcs');
  assert.deepEqual(enc.psshSystems, ['edef8ba9-79d6-4ace-a3c8-27dcd51d21ed']);
});

test('sniff packed audio with ID3 header', () => {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00]);
  assert.equal(sniff(Buffer.concat([id3, Buffer.from([0xff, 0xf1, 0x50, 0x80])])).tracks[0].codec, 'aac');
  assert.equal(sniff(Buffer.from([0x0b, 0x77, 0x00, 0x00])).tracks[0].codec, 'ac-3');
  assert.equal(sniff(Buffer.from('<html>')).container, 'unknown');
});

test('quote and command building per shell', () => {
  const url = "https://x.com/a b/it's.m3u8?a=1&b=2";
  assert.equal(quote(url, 'posix'), `'https://x.com/a b/it'\\''s.m3u8?a=1&b=2'`);
  assert.equal(quote(url, 'powershell'), `'https://x.com/a b/it''s.m3u8?a=1&b=2'`);
  assert.equal(quote('https://x.com/v.m3u8', 'posix'), 'https://x.com/v.m3u8');
  const spec = {
    inputs: [
      { url: 'https://x/v.m3u8', headers: { Referer: 'https://site/page', Cookie: 'a=1; b=2' }, userAgent: null },
      { url: 'https://x/a.m3u8', headers: {}, userAgent: null },
    ],
    maps: ['0:v:0', '1:a:0'],
    output: 'out.mp4',
    outputOptions: [],
  };
  assert.equal(
    buildFfmpegCommand(spec, 'posix'),
    "ffmpeg -referer https://site/page -headers $'Cookie: a=1; b=2\\r\\n' -i https://x/v.m3u8 -i https://x/a.m3u8 -map 0:v:0 -map 1:a:0 -c copy out.mp4",
  );
  assert.match(buildFfmpegCommand(spec, 'powershell'), /-headers "Cookie: a=1; b=2`r`n"/);
});

test('outputName skips generic file names', () => {
  assert.equal(outputName('https://cdn.x/videos/my-talk/master.m3u8'), 'my-talk.mp4');
  assert.equal(outputName('https://cdn.x/videos/lecture_01.m3u8?sig=1'), 'lecture_01.mp4');
  assert.equal(outputName('https://cdn.x/index.m3u8'), 'video.mp4');
  assert.equal(outputName('not a url'), 'video.mp4');
});
