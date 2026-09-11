# Phase O1 — Output contract. Opus session. Lane 1.

Read ONLY: this file, `plan.md` §1, §2, §4, §5.1, the phase table and §9. Do not read the rest.
Execute under the autonomy protocol §4. Build nothing outside §5.1.

Owns: `src/process.js`, `src/convert.js`, `src/naming.js`, `webimg.mjs` (convert/batch options
only), `package.json` + `package-lock.json` (dependency removal), `test/smoke.test.mjs`,
`test/formats.test.mjs`, `docs/log/o1.md`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/o1` off latest main. `npm ci && npm test` first: 15 tests must pass before you touch anything.
- Keep `convertImage`'s public signature backwards compatible; add options, do not rename.
- `original` resolves from `sharp(...).metadata().format`; write a small table in `process.js`
  and a test per source type (png, jpg, webp fixture generated with sharp).
- No-upscale is the default (§1.3). Existing tests that assert 6 files at 640/1280/1920 must
  keep passing: check the fixture size they generate and enlarge the fixture if needed rather
  than weakening the assertion.
- Removing the SDK: `await import("@anthropic-ai/sdk")` inside `generateNaming` only when
  `apiKey` is set; catch the import error and fall back. Run `npm install` to regenerate the
  lockfile. Confirm `npm ls` shows no `@anthropic-ai/sdk`.
- Do NOT add config-file logic (that is O2). Do NOT change the manifest shape beyond
  `files[].format` values (O2 owns manifest v2).
- Re-runnable; minor issues → docs/log/o1.md; stop only per §4.4.

Exit:
- `npm test` green with `ANTHROPIC_API_KEY` unset, including new tests for: formats
  `webp,jpg`; `original` on png/jpg/webp; no-upscale drop + all-dropped case; `--allow-upscale`;
  `--skip-existing` second run writes nothing; `convert` with `--name --alt` and no `--prompt`.
- `node webimg.mjs convert <fixture> --name a-b-c --alt "x y" --formats webp,jpg --widths 400,800,1600 --out /tmp/x`
  writes 6 files; snippet has one `<source type="image/webp">`, a `.jpg` `<img src>`, and `sizes="100vw"`.
- `npx --yes github:antonmarklundcom/webimg#phase/o1 --help` works from a clean npx cache.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Next: `prompts/opus-2-config-manifest.md`, model Opus.
