# Changelog

## 0.1.0 - 2026-10-07

First release.

- Master and media playlist analysis: variants, audio and subtitle renditions, I-frame playlists.
- Separate audio detection and the matching `ffmpeg -map` command.
- Track probing from the first segment: MPEG-TS PMT, fMP4 init segments, packed AAC/MP3/AC-3.
- Encryption: AES-128 (key fetched and length-checked, segment decrypted for the probe), SAMPLE-AES, DRM detection (Widevine, PlayReady and FairPlay keys, CENC init segments with pssh boxes).
- Live, event and on-demand detection, Low-Latency HLS, byte ranges, discontinuities, disguised segment extensions.
- Signed URL expiry (Expires, X-Amz, Akamai hdnts).
- Browser User-Agent retry on 403, Referer and custom headers carried into the command.
- Shell-aware quoting (bash/zsh and PowerShell), JSON output, exit codes.
- Same engine usable in browsers (fetch + WebCrypto).
