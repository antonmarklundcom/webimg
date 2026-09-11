# Phase O3 — `audit`: scan a project and write the plan skeleton. Opus session. Lane 1.

Read ONLY: this file, `plan.md` §1, §2, §4, §5.3, the phase table and §9, and `docs/log/o2.md`.
Execute under the autonomy protocol §4. Build nothing outside §5.3.

Owns: `src/audit/**` (new), `src/plan.js` (new), `webimg.mjs` (`audit` command only),
`test/audit.test.mjs`, `test/fixtures/site-php/**`, `test/fixtures/site-html/**`, `docs/log/o3.md`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/o3` off latest main. `npm ci && npm test` green first.
- No new dependencies. Regex extraction is fine; it must survive attributes in any order,
  single/double/no quotes, multi-line tags, and PHP short tags inside attributes (mark
  `dynamic`). Write the extractor as pure functions over strings and unit-test them on
  literal snippets before the fixture test.
- Fixtures commit only text files; the test copies the fixture to a temp dir and generates the
  image bytes with sharp (sizes chosen to trigger `oversize` and `legacy-format`).
- The plan CSV is the contract O4 consumes: columns exactly `file,name,alt,ar,position,action,refs,notes`.
  Reuse `parseCsv` from `src/batch.js` for reading; write with proper quoting.
- Rerunning `audit` preserves user-filled `name`/`alt`/`ar`/`action` for rows whose `file`
  already exists in the plan. Test it.
- Do NOT implement any rewriting (O4). Do NOT touch `src/ui.html`/`src/server.js`.
- Re-runnable; minor issues → docs/log/o3.md; stop only per §4.4.

Exit:
- `npm test` green: extractor unit tests, resolver tests (absolute vs relative src, web root
  detection), findings on `site-php` and `site-html` match a committed `expected-plan.csv`
  per fixture, preservation on rerun, `--no-write` writes nothing, `--json` shape.
- `node webimg.mjs audit <temp copy of site-php>` prints the table and the summary line and
  exits 0.
- `npx --yes github:antonmarklundcom/webimg#phase/o3 audit --help` works from a clean npx cache.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Next: `prompts/opus-4-fix.md`, model Opus.
