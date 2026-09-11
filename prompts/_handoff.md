# Handoff (every phase, after its exit criteria pass)

Gates, in order. Do not skip one, do not repeat one.

1. PR merged green (CI = `npm test` on Node 20 + 22). If red: fix, push, wait, merge.
2. Exit checklist in your prompt file passed on `main` after the merge.
3. ONE adversarial re-read of the merged diff on `main`. Findings fixed in ONE follow-up
   commit pushed straight to `main` only if trivial (typo, missing test assertion); otherwise
   a note in your phase log's Known issues. No second round.
4. `docs/log/<phase>.md` committed (≤ 12 lines Built, ≤ 8 Decisions, ≤ 8 Known issues,
   one Verification line), and your row added to `plan.md` §9. Commit both to `main`
   (append-only files, allowed).

Then spawn per your phase:

- **Lane 1 (O1–O3):** spawn the next lane 1 phase with `create_session`: same environment,
  same permission mode (never `plan`), `model` = Opus (current id from the `claude-api`
  skill), `prompt` exactly `Read prompts/<next-file>.md in this repo and execute it.`
- **O4 (last lane 1 phase):** create the watcher Routine from `prompts/_watcher.md`, then
  spawn S5, S6 and S7 at once, each with `model` = Sonnet and the same prompt shape.
- **S5, S6, S7:** spawn nothing. End with your phase report.
- **S8:** delete the watcher Routine, then STOP with the closing report.

Fallback when `create_session` is unavailable (local CLI): if the next phase uses the same
model, continue in this window with `Read prompts/<next-file>.md and execute it.`; at a model
switch, stop and print the exact line Anton should paste into a fresh window and which model.

Never spawn anything on Fable (plan §4.8).
