# Phase S7 — README restructure, consumer docs, skill delta, changelog. Sonnet session. Lane 2, runs in parallel with S5, S6.

Read ONLY: this file, `plan.md` §1, §2, §4, §6.3, the phase table and §9, `docs/report-2026-09-11.md`
§3–§5, and `docs/log/o1.md` … `docs/log/o4.md`. Do not read the rest.
Execute under the autonomy protocol §4. Build nothing outside §6.3.

Owns: `README.md`, `docs/consumers/**`, `docs/skill-delta.md`, `CHANGELOG.md`, `docs/log/s7.md`.

Hard limits (§4.6): no source changes at all. A doc that needs a code change → note in plan §10.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/s7` off latest main. `npm ci && npm test` green first.
- Every command block in the README must be run against the fixtures (temp copies) before it is
  committed. Options tables are generated from `node webimg.mjs <cmd> --help`, not typed.
- `docs/consumers/thingstodoinparaguay.md` must contain, verbatim and copy-pasteable: the
  `webimg.config.json`, a `content/media-jobs.csv` skeleton with a `target_path` column and 3
  example rows, the run command, and a fenced prompt block for a session in that repo that
  builds `bin/import-media.php` + the `cover:` front-matter key + the optional AVIF `<source>`
  in `src/View.php`. Use the media table DDL from the report. State that the importer must
  reuse the `Uploader` guards and be idempotent by `media.path`.
- `docs/skill-delta.md`: a list of exact old → new text replacements for the synced
  `webimg-pipeline` skill (config file, optional `--prompt`, `audit`/`fix`, "every file in
  manifest.json" instead of "six files").
- Re-runnable; minor issues → docs/log/s7.md; stop only per §4.4.

Exit:
- `grep -n "six files" README.md docs/ -r` returns nothing.
- Each README command block runs as written on a temp copy of a fixture.
- `CHANGELOG.md` has an `Unreleased` section listing O1–S6 in one line each.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
