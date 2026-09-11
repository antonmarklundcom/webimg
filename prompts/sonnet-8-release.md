# Phase S8 — Release pass. Sonnet session. Sequential, after S5, S6, S7 are merged.

Read ONLY: this file, `plan.md` §1, §4, §6.4, the phase table and §9, every `docs/log/*.md`
Known-issues section, and `docs/decisions-needed.md`. Do not read the rest.
Execute under the autonomy protocol §4. Build nothing outside §6.4.

Owns: `package.json` (version only), `package-lock.json` (refresh), `CHANGELOG.md`,
`KNOWN-ISSUES.md` (new), `README.md` (options tables only), `docs/log/s8.md`.

Budget: one session, ≤ 60 min.

Phase rules:
- Branch `phase/s8` off latest main. `npm ci && npm test` green first.
- `rm -rf ~/.npm/_npx` then `npx --yes github:antonmarklundcom/webimg#main audit --help`,
  `… fix --help`, `… init --help`, `… config` inside a temp copy of `test/fixtures/site-php`.
  Any failure here is this phase's to fix only if it is a packaging issue (`files`, `bin`,
  lockfile); anything else → KNOWN-ISSUES.md.
- Promote still-open Known issues from all phase logs into `KNOWN-ISSUES.md`, one line each with
  the phase id.
- Regenerate README options tables from `--help`.
- Version `0.2.0`; CHANGELOG `0.2.0 — <today>`; after the PR merges, tag `v0.2.0` on main and push the tag.
- Delete the watcher Routine (`list_triggers` → `delete_trigger`) if it exists.

Exit:
- `npm test` green on main; npx smoke of all four commands from a clean cache OK; tag pushed.
- `docs/log/s8.md` is the closing report: what shipped, what is in KNOWN-ISSUES.md, the two
  things Anton does next (apply `docs/skill-delta.md`; run the thingstodoinparaguay prompt).

## After this phase
STOP with the closing report. Spawn nothing.
