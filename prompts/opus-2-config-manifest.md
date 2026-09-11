# Phase O2 — Config discovery + manifest v2. Opus session. Lane 1.

Read ONLY: this file, `plan.md` §1, §2, §4, §5.2, the phase table and §9, and `docs/log/o1.md`.
Execute under the autonomy protocol §4. Build nothing outside §5.2.

Owns: `src/config.js` (new), `src/manifest.js`, `src/batch.js`, `src/convert.js` (entry shape and
snippet only), `webimg.mjs` (config wiring + `config` command), `test/config.test.mjs`,
`test/manifest.test.mjs`, `docs/log/o2.md`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/o2` off latest main. `npm ci && npm test` green first.
- Precedence CLI > `--profile` > config file > built-in default. Commander option defaults
  currently shadow any config: remove the defaults from the option definitions and apply them
  in `resolveOptions`. Test this explicitly (config `widths` must win over the built-in when the
  flag is absent).
- Discovery stops at the first `webimg.config.json` walking up from cwd, or at a directory
  containing `.git`, or at the filesystem root. `--config` bypasses discovery.
- Manifest v2 is additive (§1.5). `files[]` keeps its shape. `meta` is `{}` when empty.
- Batch passthrough: every non-empty column not in `file prompt name alt ar position` goes to
  `meta`. Both CSV and JSON rows.
- `webimg config` prints the resolved config as pretty JSON and exits 0. Include the `out`,
  `widths`, `formats`, `quality`, `position`, `sizes`, `allowUpscale`, `audit`, `fix` keys
  (defaults filled in), so S5/S6 can rely on the shape.
- Do NOT start audit/fix. Do NOT touch `src/ui.html`/`src/server.js` except a one-line call to
  `loadConfig` if it is needed to make `serve` honour the config (log it as a decision).
- Re-runnable; minor issues → docs/log/o2.md; stop only per §4.4.

Exit:
- `npm test` green: discovery from a nested cwd, profile merge, CLI override, `webimg config`
  JSON, CSV `target_path` → `meta.target_path`, manifest v2 keys present with correct values
  (`width`/`height` of largest variant, `mime` of fallback, `fallback` filename).
- Temp project with `{"widths":[400,800,1600],"formats":["webp","original"],"out":"public/media"}`:
  `node <repo>/webimg.mjs batch . --manifest jobs.csv` (no flags) writes into `public/media`
  at those widths and the manifest carries `meta.target_path`.
- `npx --yes github:antonmarklundcom/webimg#phase/o2 config` works from a clean npx cache.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Next: `prompts/opus-3-audit.md`, model Opus.
