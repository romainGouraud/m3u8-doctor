# Changelog

## 0.1.0 - 2026-10-07

First release.

- Master and media playlist analysis: variants, audio and subtitle renditions, I-frame playlists.
- Separate audio detection and the matching `ffmpeg -map` command.
- Track probing from the first segment: MPEG-TS PMT, fMP4 init segments, packed AAC/MP3/AC-3.
- Encryption: AES-128 (key tested, segment decrypted for the probe), SAMPLE-AES, DRM detection (Widevine, PlayReady, FairPlay, CENC pssh).
- Live, event and on-demand detection, Low-Latency HLS, byte ranges, discontinuities, disguised segment extensions.
- Signed URL expiry (Expires, X-Amz, Akamai hdnts).
- Browser User-Agent retry on 403, Referer and custom headers carried into the command.
- Shell-aware quoting (POSIX, PowerShell, cmd), JSON output, exit codes.
