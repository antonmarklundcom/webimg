# Phase S5 — Serve UI: prepared lists, filename matching, config-aware. Sonnet session. Lane 2, runs in parallel with S6, S7.

Read ONLY: this file, `plan.md` §1, §2, §4, §6.1, the phase table and §9, and `docs/log/o1.md`,
`docs/log/o2.md`. Do not read the rest.
Execute under the autonomy protocol §4. Build nothing outside §6.1.

Owns: `src/ui.html`, `src/server.js`, `test/serve.test.mjs`, `docs/log/s5.md`.

Hard limits (§4.6): no changes to `src/process.js`, `src/convert.js`, `src/config.js`,
`src/manifest.js`, `src/audit/**`, `src/fix/**`, `src/rewrite.js`. Need something there →
workaround + note in plan §10.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/s5` off latest main. `npm ci && npm test` green first.
- "Load list" accepts the same CSV/JSON as `batch` (use `loadBatchManifest`). Match dropped
  files to rows: exact `file`, then basename, then basename without extension. Show unmatched
  rows as "waiting for file" and never convert them.
- `GET /api/config` returns the resolved config (`loadConfig` from O2); the UI pre-fills
  widths, formats, position, and shows a profile `<select>` when `profiles` exists.
- Existing endpoint shapes stay unchanged; add fields, do not rename.
- Keep the UI a single dependency-free HTML file.
- Re-runnable; minor issues → docs/log/s5.md; stop only per §4.4.

Exit:
- `npm test` green: `/api/config`, list upload + match-by-name, convert with `formats=webp,jpg`
  yields jpg files, meta columns pass through to the batch manifest.
- Manual: `node webimg.mjs serve` in a temp project with a config shows the config's widths
  pre-filled; loading a 3-row CSV and dropping 2 matching files converts exactly those 2.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
