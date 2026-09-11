# Phase O4 — `fix`: convert per plan and rewrite markup in place. Opus session. Lane 1 (last).

Read ONLY: this file, `plan.md` §1, §2, §4, §5.4, the phase table and §9, and `docs/log/o3.md`.
Execute under the autonomy protocol §4. Build nothing outside §5.4.

Owns: `src/fix/**` (new), `src/rewrite.js` (new), `webimg.mjs` (`fix` command only),
`test/fix.test.mjs`, `test/fixtures/site-php/expected-after/**`, `docs/log/o4.md`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/o4` off latest main. `npm ci && npm test` green first.
- Rewriting is string surgery on the exact byte range the extractor reported. Never re-serialise
  a whole file through a parser. Preserve line endings (detect CRLF), indentation, and every
  attribute not in the replace list.
- The `<picture>` comes from the manifest v2 entry (O2) so `fix` and `convert` cannot drift.
  Web path = out dir relative to the web root, with a leading `/` when the original `src` was
  absolute, relative otherwise.
- Idempotence is an exit criterion: run twice, second `--dry-run` must print `0 changes`.
- `--delete-sources` deletes only originals whose every ref was rewritten in this run and whose
  outputs exist. Count and print what was deleted.
- Row errors (missing `name`/`alt` on a `convert` row) are collected, printed at the end,
  exit 1; other rows still complete.
- Do NOT touch `src/ui.html`/`src/server.js`, README, or docs beyond your log.
- Re-runnable; minor issues → docs/log/o4.md; stop only per §4.4.

Exit:
- `npm test` green: fix on a temp copy of `site-php` with a filled plan produces
  `expected-after/` (compare normalised whitespace), second run 0 changes, `--dry-run` writes
  nothing, `--delete-sources` semantics, `alt-only` rows, row-error exit code, CRLF file
  round-trips with CRLF intact.
- After `audit` → filled plan → `fix` on the fixture, a fresh `audit` reports 0 `convert` rows.
- `npx --yes github:antonmarklundcom/webimg#phase/o4 fix --help` works from a clean npx cache.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Create the watcher (`prompts/_watcher.md`), then spawn ALL of:
`prompts/sonnet-5-serve.md`, `prompts/sonnet-6-git-init.md`, `prompts/sonnet-7-docs.md`,
each model Sonnet.
