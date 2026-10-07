# m3u8-doctor

**Explain any HLS stream (.m3u8) in plain words, then print the ffmpeg command that keeps the sound.**

[![CI](https://github.com/romainGouraud/m3u8-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/romainGouraud/m3u8-doctor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/m3u8-doctor.svg)](https://www.npmjs.com/package/m3u8-doctor)
![node](https://img.shields.io/node/v/m3u8-doctor.svg)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

You copied an `.m3u8` URL from DevTools, ran `ffmpeg -i ... out.mp4`, and the file has **no sound**. Or ffmpeg fails with a 403, a key error, or a silent "Invalid data". `m3u8-doctor` tells you why in one command:

```text
$ npx m3u8-doctor "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"

Input    https://devstreaming-cdn.apple.com/.../master.m3u8
Type     Master playlist · 24 variants · 3 audio tracks (English x3) · 1 subtitle track
Picked   1920x1080 · 8.0 Mb/s · H.264 + AAC · 60 fps
Audio    English · 2 ch

Findings
 ! The audio is in a separate playlist
   The video variant carries no sound of its own. Downloading only the video
   URL gives a silent file. The command below downloads both and merges them.
 ✓ Picture and sound found (H.264 + AAC)
 ✓ On-demand video, 10:00 in 100 segments (fragmented MP4)
 i Segments are byte ranges of one file (EXT-X-BYTERANGE), ffmpeg handles it

Command
  ffmpeg -i https://.../v9/prog_index.m3u8 -i https://.../a1/prog_index.m3u8 -map 0:v:0 -map 1:a:0 -c copy img_bipbop_adv_example_fmp4.mp4
```

It does not trust the playlist alone: it **reads the first bytes of a real segment** (MPEG-TS PMT, fMP4 init, raw AAC/MP3/AC-3) to see which tracks actually exist, decrypting AES-128 segments on the fly when needed. That is how it can say "this playlist has video but no sound" even when the playlist declares nothing.

## Install

Nothing to install, Node.js 18.17 or later is enough:

```sh
npx m3u8-doctor "<url>"
```

Or globally: `npm install -g m3u8-doctor`. Zero runtime dependencies.

## What it checks

| Check | What you learn |
|---|---|
| Master or media playlist | Whether you have the playlist with every quality, or a single variant |
| Variants | Resolution, bitrate, codecs, frame rate, and which one is picked |
| **Separate audio** (`EXT-X-MEDIA TYPE=AUDIO`) | The #1 cause of "downloaded video has no sound", and the `-map` command that fixes it |
| **Real tracks** in the first segment | Video only, audio only, or both, with codecs (H.264, HEVC, AV1, AAC, AC-3, E-AC-3, MP3, Opus...) |
| Encryption | None, AES-128 (with a test of the key URL), SAMPLE-AES, or DRM |
| DRM (Widevine, PlayReady, FairPlay, CENC) | A clear stop: no command is printed for DRM content |
| Live, event or on-demand | Duration, segment count, Low-Latency HLS |
| Signed URLs | Expiry date read from `Expires`, `X-Amz-*` or Akamai `hdnts` tokens |
| Server behavior | 403 to non-browser clients (retried with a browser User-Agent), Referer checks, HTML error pages, DASH sent as HLS |
| Oddities | Byte ranges, discontinuities (ads, splices), segments disguised as `.jpg` or `.png` |

## Usage

```sh
m3u8-doctor <url-or-file> [options]
```

| Option | Description |
|---|---|
| `-r, --referer <url>` | Send this Referer: the page that plays the video. Many CDNs require it |
| `-H, --header "Name: value"` | Extra header, repeatable (`Cookie`, `Origin`, `Authorization`) |
| `-A, --user-agent <ua>` | Custom User-Agent |
| `--max-height <px>` | Best variant at or below this height, e.g. `720` |
| `--no-probe` | Do not fetch any segment bytes (playlists only) |
| `--base <url>` | Base URL for relative URIs when you pass a saved `.m3u8` file |
| `-o, --output <file>` | Output file name used in the command |
| `--shell <posix\|powershell\|cmd>` | Quote the command for your shell (PowerShell is the default on Windows) |
| `--json` | Full machine-readable report |
| `--no-color`, `--no-links` | Plain output (`NO_COLOR` is honored) |

Every header you pass is sent to the playlists, keys and segments, and carried into the printed ffmpeg command, so what worked during the diagnosis also works for the download.

**Exit codes:** `0` ready to download, `1` a problem was found (silent stream, expired or forbidden URL, not HLS), `2` DRM protected. Useful in scripts:

```sh
m3u8-doctor "$URL" --json > report.json || echo "not downloadable as is"
```

### Examples

A CDN that checks the Referer and a cookie:

```sh
npx m3u8-doctor "https://cdn.example.com/hls/index.m3u8" \
  --referer "https://example.com/watch/42" \
  -H "Cookie: session=abc123"
```

The printed command reuses them:

```sh
ffmpeg -referer https://example.com/watch/42 -headers $'Cookie: session=abc123\r\n' -i https://cdn.example.com/hls/index.m3u8 -c copy hls.mp4
```

A variant copied from DevTools, without its audio:

```text
 ✗ This playlist contains video but no sound
   You probably copied a variant playlist. The sound lives in another playlist
   listed by the master playlist (the first .m3u8 the player requests, often
   master.m3u8, playlist.m3u8 or index.m3u8). Run m3u8-doctor on that one.
```

## Use it as a library

```js
import { diagnose, parsePlaylist, sniff } from 'm3u8-doctor';

const report = await diagnose('https://example.com/master.m3u8', {
  headers: { Referer: 'https://example.com/watch/42' },
  maxHeight: 1080,
});

report.findings;   // [{ severity: 'warn', code: 'SEPARATE_AUDIO', title, detail }]
report.command;    // ffmpeg command string, or null (DRM, forbidden key...)
report.audio?.url; // the separate audio playlist, when there is one
```

`parsePlaylist(text, baseUrl)` and `sniff(bytes)` are pure functions with no network access. Types are included.

## FAQ

**Why does my downloaded HLS video have no sound?**
Most streaming sites serve audio as its own playlist (`#EXT-X-MEDIA:TYPE=AUDIO`). The video URL you see in DevTools then contains pictures only. You need both inputs and `-map 0:v:0 -map 1:a:0`, which is the command `m3u8-doctor` prints. Other causes (a muted preview file, an audio codec MP4 cannot hold, a silent source) are covered in [this guide to videos downloaded without sound](https://getvidora.com/blog/downloaded-video-no-sound/).

**Where do I find the .m3u8 URL?**
Open DevTools, then the Network tab, filter on `m3u8`, and play the video. Take the first request: it is usually the master playlist. Step by step, including signed URLs: [how to find the M3U8 URL of a video](https://getvidora.com/blog/find-m3u8-url/).

**Can it download encrypted streams?**
AES-128 is standard HLS encryption, not DRM: ffmpeg decrypts it when the key URL answers, and `m3u8-doctor` tests that key for you ([AES-128 encrypted M3U8 explained](https://getvidora.com/blog/download-encrypted-m3u8/)). Widevine, PlayReady and FairPlay are DRM. `m3u8-doctor` detects them and stops: there is no legitimate way to save DRM content, and bypassing it is illegal in most countries.

**Does it download the video?**
No. It reads playlists, the key, and at most 256 KB of the first segment (or the small init segment). The download itself is ffmpeg's job. For the full ffmpeg workflow, see [converting M3U8 to MP4](https://getvidora.com/blog/m3u8-to-mp4/), and for broadcasts, [recording a live M3U8 stream](https://getvidora.com/blog/live-stream-m3u8-download/).

**What about DASH (.mpd)?**
Out of scope: `m3u8-doctor` says so when it receives a DASH manifest. ffmpeg and yt-dlp both read `.mpd` URLs directly.

## Privacy and legal

`m3u8-doctor` sends requests only to the URLs you give it and to the URLs those playlists reference. No telemetry, no analytics, no third-party service. Use it on content you own or have the right to download, and respect the terms of the sites you use.

## Contributing

Bug reports with a playlist sample are welcome (redact tokens and signatures). See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
git clone https://github.com/romainGouraud/m3u8-doctor && cd m3u8-doctor
npm install && npm test
```

## About

Built by the maintainer of [Vidora](https://getvidora.com), a Chrome extension that does the same diagnosis and the download in one click inside the browser. `m3u8-doctor` is the command-line half, free and MIT licensed.

## License

[MIT](LICENSE)
