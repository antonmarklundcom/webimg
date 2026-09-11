# Phase S6 — `init` command + git/Action templates + git-repos doc. Sonnet session. Lane 2, runs in parallel with S5, S7.

Read ONLY: this file, `plan.md` §1, §2, §4, §6.2, the phase table and §9, and `docs/log/o2.md`,
`docs/log/o3.md`. Do not read the rest.
Execute under the autonomy protocol §4. Build nothing outside §6.2.

Owns: `src/init.js` (new), `templates/**` (new), `webimg.mjs` (`init` command only),
`docs/git-repos.md`, `test/init.test.mjs`, `docs/log/s6.md`.

Hard limits (§4.6): no changes to `src/process.js`, `src/convert.js`, `src/config.js`,
`src/manifest.js`, `src/audit/**`, `src/fix/**`, `src/rewrite.js`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn (§4.13).

Phase rules:
- Branch `phase/s6` off latest main. `npm ci && npm test` green first.
- Detection order: php-site-template (`lib/` + `assets/img`) → Next.js (`next.config.*`) →
  DB-backed PHP (`public/media`) → generic. Each writes a config whose keys match O2's
  `webimg config` output exactly.
- Templates are copied verbatim from `templates/`; never overwrite without `--force`.
- The audit Action is report-only: uploads `audit.json` as an artifact and writes a
  summary to `$GITHUB_STEP_SUMMARY`. The fix Action is `workflow_dispatch` only and opens a PR.
- `docs/git-repos.md`: three flows (local clone, cloud Claude session, Actions), each as a
  copy-paste command block, ≤ 120 lines.
- Re-runnable; minor issues → docs/log/s6.md; stop only per §4.4.

Exit:
- `npm test` green: `init` on each fixture type writes the expected config; `--action` writes
  the workflow; `--force` semantics; refuses to overwrite otherwise.
- `node webimg.mjs init <temp copy of test/fixtures/site-php> --action` produces both files and
  `node webimg.mjs config` in that dir prints the written values.
- PR merged green.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
