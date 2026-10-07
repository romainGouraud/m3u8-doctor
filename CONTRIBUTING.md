# Contributing

Thanks for helping. The most useful contribution is a playlist that m3u8-doctor explains wrongly.

## Reporting a stream

Open an issue with:

- the command you ran and the full output (`--no-color`),
- the playlist text, or a public URL that reproduces it,
- what ffmpeg did with the printed command.

Remove tokens, signatures, cookies and account identifiers before posting. Do not post links to content you are not allowed to share. Requests about DRM circumvention will be closed.

## Development

```sh
npm install
npm test        # builds with tsc, then runs node --test
```

- Source is TypeScript in `src/`, tests are plain `node:test` files in `test/` that run against `dist/`.
- Keep the package free of runtime dependencies.
- Every new finding needs a test, ideally through the local server in `test/helpers.js`, which builds MPEG-TS and fMP4 bytes from scratch.
