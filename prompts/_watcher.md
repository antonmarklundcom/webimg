# Watcher — hourly Sonnet Routine (created by O4, deleted by S8)

Create with `create_trigger`: `cron_expression: "0 * * * *"`, `create_new_session_on_fire: true`,
`model` = Sonnet (current id from the `claude-api` skill), `prompt` exactly
`Read prompts/_watcher.md in this repo and execute it.`, name `webimg watcher`.

Each firing, in a fresh session, within a few minutes:

1. Read `plan.md` phase table and §9, then `git fetch --all` and list `phase/*` branches and
   open PRs.
2. For S5, S6, S7, S8 decide: merged / running (branch has a commit < 90 min old) / stalled
   (older, PR not merged) / not started.
3. Re-spawn stalled phases and start not-started ones whose Depends on are merged, keeping at
   most 3 running. Use `create_session` with `model` = Sonnet, same environment, prompt
   `Read prompts/<file>.md in this repo and execute it.`
4. If a phase PR is green and mergeable but its session is gone, merge it (squash).
5. When S5, S6 and S7 are all merged and S8 is not started, spawn S8.
6. Read `docs/decisions-needed.md`; if it has unanswered entries, push a notification to Anton
   with the questions verbatim.
7. Never edit code, never answer a design question, never message a running session. After 10
   firings with the build still not done, notify Anton and disable this Routine.
