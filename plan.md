# webimg 0.2 — build plan

Method: `phased-autonomous-build`. One phase = one branch = one PR merged green. All Opus
phases first (lane 1, sequential), then all Sonnet phases (lane 2, parallel), then one Sonnet
release pass. Background and reasoning: `docs/report-2026-09-11.md`.

## Phase table

| Phase | Lane | Model | Prompt file | Plan §§ | Owns (create/modify) | Depends on |
|---|---|---|---|---|---|---|
| O1 Output contract | 1 | Opus | `prompts/opus-1-output-contract.md` | §5.1 | `src/process.js`, `src/convert.js`, `src/naming.js`, `webimg.mjs` (convert/batch options), `package.json` deps, `test/smoke.test.mjs`, `test/formats.test.mjs` | — |
| O2 Config + manifest v2 | 1 | Opus | `prompts/opus-2-config-manifest.md` | §5.2 | `src/config.js`, `src/manifest.js`, `src/batch.js`, `src/convert.js` (snippet + entry shape), `webimg.mjs` (config wiring), `test/config.test.mjs`, `test/manifest.test.mjs` | O1 |
| O3 Audit | 1 | Opus | `prompts/opus-3-audit.md` | §5.3 | `src/audit/**`, `src/plan.js`, `webimg.mjs` (audit command), `test/audit.test.mjs`, `test/fixtures/site-*/**` | O2 |
| O4 Fix | 1 | Opus | `prompts/opus-4-fix.md` | §5.4 | `src/fix/**`, `src/rewrite.js`, `webimg.mjs` (fix command), `test/fix.test.mjs` | O3 |
| S5 Serve UI | 2 | Sonnet | `prompts/sonnet-5-serve.md` | §6.1 | `src/ui.html`, `src/server.js`, `test/serve.test.mjs` | O2 |
| S6 Git + init | 2 | Sonnet | `prompts/sonnet-6-git-init.md` | §6.2 | `src/init.js`, `templates/**`, `webimg.mjs` (init command only), `docs/git-repos.md`, `test/init.test.mjs` | O2, O3 |
| S7 Docs + consumers | 2 | Sonnet | `prompts/sonnet-7-docs.md` | §6.3 | `README.md`, `docs/consumers/**`, `docs/skill-delta.md`, `CHANGELOG.md` | O4 |
| S8 Release pass | — | Sonnet | `prompts/sonnet-8-release.md` | §6.4 | `package.json` version, `CHANGELOG.md`, `KNOWN-ISSUES.md`, `README.md` options table only | S5, S6, S7 |

Shared append-only files every phase may touch: its own `docs/log/<phase>.md`, its line in §9,
`docs/decisions-needed.md`. Nothing else outside Owns.

## 1. Decisions already made (do not re-litigate)

1. webimg stays a plain Node ≥20 CLI run via `npx --yes github:antonmarklundcom/webimg`. No
   build step, no hosted service, no wasm, no API key required. The Claude session names files.
2. Formats become generic: `--formats` accepts `avif`, `webp`, `jpg`, `png`, `original`, in
   order; default stays `avif,webp`. `original` = the source's format (`.webp` source → webp,
   deduplicated). JPEG default quality 82, PNG `compressionLevel: 9`, existing AVIF/WebP
   defaults unchanged.
3. No upscaling by default; `--allow-upscale` opts back in. Widths above the source width are
   dropped with one info line; if every width is above, one file at the source width is emitted.
4. Per-repo `webimg.config.json` (found by walking up from cwd to the git root) supplies
   defaults; CLI flags override it; built-in defaults are the floor. `--config <file>` overrides
   discovery. Optional `profiles` map inside the file, selected with `--profile <name>`. webimg
   never contains a site name.
5. Manifest v2 (§5.2) is additive: every existing key keeps its meaning; new keys are added.
   Unknown batch columns pass through into `meta`.
6. `--prompt` is optional when `--name` and `--alt` are both given (convert) or both present in
   the row (batch). It stays the fallback slug source otherwise.
7. `@anthropic-ai/sdk` leaves `dependencies`. It is dynamically imported only when
   `ANTHROPIC_API_KEY` is set; if missing, one warning and the slug fallback.
8. `--skip-existing` exists on `batch` and `fix`. Skip = every expected output file exists and
   is newer than the source (URL sources: exists).
9. New commands: `audit`, `fix`, `init`. Contracts in §5.3, §5.4, §6.2. `fix` never edits a
   file it has no plan row for and never touches a dynamic `src` expression.
10. thingstodoinparaguay's importer and `cover:` front matter are built in that repo from
    `docs/consumers/thingstodoinparaguay.md`. Not here.
11. Models: Opus for O1–O4, Sonnet for S5–S8. Fable is never spawned (§4.8).
12. Version bumps to 0.2.0 in S8 only. CI = `npm test` on Node 20 and 22 (workflow committed
    with this plan).

## 2. Contracts (the shapes everything builds on)

Written fully in §5.1–§5.4 by the Opus phases; summarised here so lane 2 can read one place.

- **Config file** `webimg.config.json`: `{ out, widths, formats, quality:{avif,webp,jpg}, position, sizes, allowUpscale, profiles:{<name>:{same keys}}, audit:{include, exclude, webRoot, maxSourceKb}, fix:{deleteSources, out} }`. All keys optional.
- **Manifest v2 entry**: existing keys (`filename_base source prompt alt_text naming_source aspect_ratio files html_snippet`) plus `width height mime fallback formats widths meta`.
- **Plan CSV** `webimg-plan.csv`: columns `file,name,alt,ar,position,action,refs,notes` (§5.3). `action` ∈ `convert | alt-only | skip`.
- **Core API** (`src/convert.js`): `convertImage({...})` keeps its signature and gains `formats`, `qualityJpg`, `allowUpscale`, `sizes`, `meta`, `skipExisting`.

## 3. Feature scope

Core (this plan): §1.2–§1.9. Extras approved: `init` with an Action template (S6), consumer
docs for thingstodoinparaguay, viaje.com.py and php-site-template (S7). Everything else → §10.

## 4. Autonomy protocol

1. Work until the phase's exit criteria pass; never ask permission for in-plan work.
2. One PR per phase. Branch `phase/<id>` (e.g. `phase/o1`) off latest `main`. Open the PR,
   watch CI, merge when green. A red build is the session's own work. Lane 2 phases wait only
   for the lane 1 phases in their Depends on column.
3. Minor issues → "Known issues" in `docs/log/<phase>.md`; keep building. Cross-phase leftovers
   are promoted to `KNOWN-ISSUES.md` by S8.
4. Stop and ask ONLY for a contract decision (§2) where guessing wrong forces a rewrite:
   append the question to `docs/decisions-needed.md`, commit, push, end the session. Never
   wait in-session for an answer.
5. Every prompt is re-runnable: inspect the branch first, continue from the first unmet exit
   criterion. WIP commit at least every 30 minutes.
6. Lane 2 hard limits: no changes to `src/process.js`, `src/convert.js`, `src/config.js`,
   `src/manifest.js`, `src/audit/**`, `src/fix/**`, `src/rewrite.js`. Workaround + §10 note.
7. Tests: every new behaviour gets a `node --test` case that passes offline with
   `ANTHROPIC_API_KEY` unset. Fixtures are generated with sharp at test time; no binary
   fixtures committed. `npm test` green is an exit criterion of every phase.
8. **Model cost guardrail** — Fable (`claude-fable-5`, Mythos-class) is never used for build
   phases, subagents, spawned sessions, watchers or Routines. Only Opus and Sonnet appear in
   this plan. If a session believes Fable is needed, it writes why to `docs/decisions-needed.md`
   and ends.
9. File ownership: write only inside your Owns column plus the append-only files listed under
   the phase table. On `git merge main` conflicts: main wins, re-apply your change, re-run
   tests. Never resolve a conflict in a file outside your Owns.
10. Handoff: a phase is done when (a) PR merged green, (b) exit list passed, (c) ONE
    adversarial re-read of the merged diff with findings fixed in ONE follow-up commit,
    (d) `docs/log/<phase>.md` committed and §9 updated. Then follow `prompts/_handoff.md`.
11. Phase log: ≤ 12 lines Built, ≤ 8 Decisions, ≤ 8 Known issues, one line
    "Verification: npm test green on <sha>; npx smoke from branch OK".
12. Orientation read: prompt file, plan §1, §2, §4, own §5/§6 section, the phase table, §9,
    and `docs/log/<dep>.md` for each dependency. Not the whole plan, not the report.
13. Polish cap: one final `npm test`, one `npx --yes github:antonmarklundcom/webimg#<branch> --help`
    smoke (clear `~/.npm/_npx` first if stale), PR body ≤ 20 lines written once. Improvement
    ideas found afterwards go to §10.
14. Decisions travel by files. To change a running phase, edit its prompt file on main; phases
    re-read their prompt before opening and before merging the PR.

## 5. Lane 1 phases (Opus, sequential)

### 5.1 O1 — Output contract (formats, no-upscale, skip-existing, prompt optional, SDK lazy)

- `src/process.js`: replace the fixed avif+webp loop with a `formats` list. Encoder map:
  `avif` → `.avif({quality, effort:4})`, `webp` → `.webp({quality, effort:4})`, `jpg` →
  `.jpeg({quality, mozjpeg:true})` extension `.jpg`, `png` → `.png({compressionLevel:9})`,
  `original` → resolved from `metadata.format` (`jpeg`→`jpg`, `png`, `webp`; anything else →
  `jpg`), deduplicated after resolution. Output name stays `<slug>-<width>.<ext>`.
- Upscale rule per §1.3. Log lines: `ℹ skipping 1920 (source is 1500px)`; when all widths are
  dropped: `ℹ emitting 1500 (source width) instead of 640,1280,1920`.
- `--formats <list>`, `--quality-jpg <n>` (default 82), `--allow-upscale`, `--skip-existing`
  on `convert` and `batch`. `--prompt` no longer `requiredOption`; error only if neither
  `--prompt` nor (`--name` and `--alt`).
- `src/naming.js`: `import Anthropic` becomes `await import("@anthropic-ai/sdk")` inside
  `generateNaming`, guarded by `apiKey`; ImportError → `⚠ @anthropic-ai/sdk not installed — using slug fallback`.
  `package.json`: remove it from `dependencies`, add to `optionalDependencies`? **No** — remove
  entirely and mention `npm i @anthropic-ai/sdk` in the README API section (S7 writes that).
  Regenerate `package-lock.json` with `npm install`.
- `buildHtmlSnippet`: one `<source>` per non-fallback format, order as configured; fallback
  `<img>` = last format, middle width; `sizes` attribute on every `<source>` and `srcset`
  `<img>` (default `100vw`, `--sizes` flag).
- `files[]` entries for jpg/png carry `format: "jpg"|"png"`.
- Tests: formats `webp,jpg` produce 6 files with correct extensions; `original` on a PNG
  source yields png; no-upscale drops widths; `--allow-upscale` restores; `--skip-existing`
  second run writes nothing (compare mtimes); `convert` with `--name --alt` and no `--prompt`
  works; existing tests still pass. Run with `ANTHROPIC_API_KEY` unset.
- Exit: `npm test` green; `node webimg.mjs convert <fixture> --name a-b-c --alt "x y" --formats webp,jpg --widths 400,800,1600 --out /tmp/x`
  writes 6 files and a snippet with one `<source type="image/webp">` and a `.jpg` fallback.

### 5.2 O2 — Config discovery + manifest v2 + meta passthrough

- `src/config.js`: `loadConfig({ cwd, configPath, profile })` → merged object. Discovery:
  walk up from cwd until a `webimg.config.json` or a `.git` directory or root; first file wins.
  Validate keys (unknown keys → warning, not error). `profiles[name]` merged over the base.
  Export `resolveOptions(cliOpts, config, defaults)` used by every command so precedence is
  CLI > profile > config > default. Commander defaults must NOT shadow config: register
  options without defaults and apply defaults in `resolveOptions`.
- Manifest v2 entry: add `width`/`height` (largest generated variant), `mime` (fallback
  format), `fallback` (file name of the `<img src>`), `formats`, `widths` (as emitted),
  `meta` (object). `writeManifest` unchanged semantics (merge by `filename_base`), and it
  preserves `meta` keys from an existing entry when the new one has none.
- `src/batch.js`: `normalizeRow` keeps known columns and puts every other non-empty column
  into `meta`. JSON rows likewise. Add `target` as a known alias for `meta.target_path`? **No**:
  keep it plain passthrough; `target_path` is just a column.
- `webimg.mjs`: `--config <file>`, `--profile <name>` on convert, batch, serve, zip(no), plus a
  `webimg config` command that prints the resolved config as JSON (for debugging and for
  S5/S6 to read).
- Tests: discovery from a nested cwd; profile merge; CLI overrides config; `webimg config`
  output; batch CSV with `target_path` column lands in `meta.target_path`; manifest v2 keys.
- Exit: `npm test` green; a temp project with `webimg.config.json` `{ "widths":[400,800,1600], "formats":["webp","original"], "out":"public/media" }`
  and `npx … batch . --manifest jobs.csv` (no flags) writes into `public/media` with those
  widths and the manifest carries `meta.target_path`.

### 5.3 O3 — `audit`: scan a project, write the plan skeleton

- `webimg audit [dir]` (default `.`). Options: `--include <globs>`, `--exclude <globs>`,
  `--web-root <dir>` (default: config, else auto-detect first existing of `public`, `web`,
  `htdocs`, `.`), `--max-source-kb <n>` (default 300), `--plan <file>` (default
  `webimg-plan.csv`), `--json <file>` (default `webimg-audit.json`), `--no-write`.
- Scanner (`src/audit/scan.js`): recursive walk with default excludes
  `node_modules .git vendor dist build .next assets/img/manifest.json`; file types
  `.html .htm .php .md .markdown .jsx .tsx .vue .astro`. Extractor (`src/audit/extract.js`),
  regex-based, no HTML parser dependency: `<img … src= srcset= alt= width= height= loading=>`,
  `<picture><source srcset= type=>`, CSS `url(...)` in `<style>` and in `.css` files under the
  web root, `<meta property="og:image" content=>`, Markdown `![alt](src)`. Each reference:
  `{ file, line, kind, src, alt, hasDimensions, hasLoading, dynamic }`. `dynamic` = src
  contains `<?`, `{{`, `${`, `{`+`}` JSX, or starts with `http` to another host.
- Resolver (`src/audit/resolve.js`): map `src` to a file under the web root (absolute `/x`
  → `<webRoot>/x`; relative → relative to the referencing file). Also list image files under
  the web root that nothing references (`unreferenced`).
- Findings per source image: `missing-file`, `dynamic-src`, `oversize` (> max-source-kb),
  `legacy-format` (jpg/png with no sibling `<base>-<w>.webp|avif`), `generic-name`
  (matches `/^(img|image|photo|foto|pic|hero|banner|screenshot|dsc|img_)?[-_ ]?\d*$/i` or
  is < 3 tokens), `no-alt`, `empty-alt` (informational: may be decorative), `no-dimensions`,
  `no-lazy`, `unreferenced`, `already-webimg` (a `<picture>` whose sources match a manifest
  entry → action `skip`).
- Plan CSV (`src/plan.js` read/write, reuse `parseCsv`): columns
  `file,name,alt,ar,position,action,refs,notes`. `name` pre-filled with the existing basename
  when it passes `validateSlug` and is not `generic-name`, else empty. `alt` pre-filled from the
  first non-empty existing alt. `action` = `skip` for `already-webimg` and `dynamic-src`,
  `alt-only` when the only findings are alt/lazy/dimensions, else `convert`. `refs` =
  `path:line;path:line`. `notes` = finding codes joined by `;`. Rerunning `audit` on a project
  with an existing plan preserves filled `name`/`alt`/`ar`/`action` for known rows.
- Terminal output: one table (file, size, findings) and a summary line
  `N images, M to convert, K alt-only, J skipped, plan written to webimg-plan.csv`. Exit code 0
  always (audit is a report), except usage errors.
- Fixtures: `test/fixtures/site-php/` (a php-site-template-like tree with `assets/img`,
  two `.php` pages, one `<img>` with a generic name and no alt, one already-converted
  `<picture>`, one dynamic `<?= $img ?>` src, one CSS `url()`), `test/fixtures/site-html/`
  (flat html + md). Image bytes generated by the test at setup into a temp copy.
- Exit: `npm test` green; `node webimg.mjs audit test/fixtures/site-php` (on a temp copy)
  lists exactly the seeded findings and writes a plan whose rows match a committed
  `expected-plan.csv`.

### 5.4 O4 — `fix`: convert per plan and rewrite markup in place

- `webimg fix [dir] --plan webimg-plan.csv` (default plan path), `--dry-run` (print the
  unified diff per file, write nothing), `--delete-sources`, `--out <dir>` (default: config
  `fix.out`, else the source image's own directory), `--skip-existing`, `--yes` (no-op today,
  reserved). Uses O2's config for widths/formats/quality/sizes.
- For each plan row with `action=convert`: require `name` and `alt` (row error otherwise,
  listed at the end, exit 1, other rows still processed). Call `convertImage` with
  `writeManifestFile: true` into the out dir. Then rewrite every ref in `refs`
  (`src/rewrite.js`): `<img>` → `<picture>` built from the manifest entry, keeping
  `class id style data-* title fetchpriority decoding` from the original `<img>`, replacing
  `alt`, setting `width height`, `loading="lazy"` unless the original had
  `fetchpriority="high"` or `loading="eager"`; an `<img>` already inside a `<picture>` →
  replace the whole `<picture>`; Markdown `![alt](src)` → `![new alt](<fallback>)`; CSS
  `url()` → largest file of the first format that is not avif (browser support), a note in the
  summary. URL prefix = web path derived from out dir relative to the web root (respect
  `--out`; absolute paths never end up in markup).
- `action=alt-only`: only rewrite `alt` (and add `loading="lazy"`, `width`/`height` when the
  file is readable) on each ref; no conversion.
- `action=skip`: nothing.
- Idempotence: a second run on the fixed project produces no file changes (`--dry-run` prints
  "0 changes"). `--delete-sources` deletes the original only after every ref was rewritten and
  the outputs exist; never deletes a file that is still referenced elsewhere untouched.
- Line endings and indentation of the edited file are preserved; the `<picture>` block is
  indented to the `<img>` it replaces.
- Tests: fix on a temp copy of `site-php` with a filled plan → files exist, markup diff equals
  a committed `expected-after/` tree (normalised whitespace), second run = 0 changes,
  `--dry-run` writes nothing, `--delete-sources` removes only converted originals, alt-only
  path, row-error path exits 1 but processes other rows.
- Exit: the above green in `npm test`; manual: `audit` → edit plan → `fix` on the fixture
  yields a project where `audit` reports 0 `convert` rows.

## 6. Lane 2 phases (Sonnet, parallel after O4 merges; S5/S6 may start after their deps)

### 6.1 S5 — Serve UI: prepared lists, filename matching, config-aware

- "Load list" button: accepts a CSV/JSON with the batch columns (`file,name,alt,ar,position`
  + any extra). Rows appear in the queue without files; dropped files attach to the row whose
  `file` matches the dropped filename (exact, then basename, then basename without extension).
  Unmatched files become new rows; unmatched rows show "waiting for file".
- Per-row extra columns are shown read-only and passed through (`meta`).
- Formats + widths + profile selector read from `GET /api/config` (new endpoint returning the
  resolved config from O2); the server starts with config discovery like the CLI.
- Convert uses O1's `formats`; result rows list every file from the manifest entry.
- The "everything" zip includes `manifest.json`. Existing endpoints keep their shapes.
- Tests extend `test/serve.test.mjs`: `/api/config`, list upload + match by name, convert with
  `formats=webp,jpg` yields jpg files.
- Exit: `npm test` green; manual run `node webimg.mjs serve` in a temp project with a config
  shows the config's widths pre-filled.

### 6.2 S6 — `init` command + git/Action templates + git-repos doc

- `webimg init [dir]`: detects project type (php-site-template: `lib/` + `assets/img`;
  Next.js: `next.config.*`; DB-backed PHP: `public/media`; else generic) and writes a
  `webimg.config.json` with sensible `out`/`widths`/`formats` and an `audit.webRoot`.
  `--action` also writes `.github/workflows/webimg-audit.yml` from `templates/`. Never
  overwrites an existing file without `--force`.
- `templates/webimg-audit.yml`: on `pull_request`, Node 22, `npx --yes github:antonmarklundcom/webimg audit --no-write --json audit.json`,
  uploads the JSON as an artifact and posts a short summary via `$GITHUB_STEP_SUMMARY`. Report
  only, never commits.
- `templates/webimg-fix.yml`: `workflow_dispatch` with a `plan` input path; runs `fix` on a new
  branch and opens a PR with `peter-evans/create-pull-request`. Documented as opt-in.
- `docs/git-repos.md`: the three flows: (1) local clone → audit → session fills plan → fix →
  commit; (2) cloud Claude session in the repo (same commands); (3) the Actions. Includes the
  brief's option D as "when the sources are too big to attach".
- Tests: `init` on each fixture type writes the expected config; `--force` semantics.
- Exit: `npm test` green; `node webimg.mjs init test/fixtures/site-php --action` (temp copy)
  produces both files.

### 6.3 S7 — README restructure, consumer docs, skill delta, changelog

- README: new top section "Use it from a Claude session" (3 commands), then "Fix an existing
  site" (audit → plan → fix), "Config file" (full key table), "Bulk images from your PC"
  (serve with a prepared list), "Output" (manifest v2), options table regenerated from
  `--help` output of every command, API-key section moved to the end as optional with the
  `npm i @anthropic-ai/sdk` note.
- `docs/consumers/thingstodoinparaguay.md`: the config file to commit
  (`widths 400,800,1600; formats webp,original; out public/media; sizes`), the
  `content/media-jobs.csv` skeleton with `target_path`, the run command, and a **paste-ready
  prompt for a session in that repo** to build `bin/import-media.php` (reads manifest v2,
  copies into `public/media/YYYY/MM/`, inserts `media` rows with `sizes_json` built from
  `files[]`, sets `cover_media_id` by `meta.target_path`, idempotent by `path`, honours
  Uploader limits) and the `cover:` front-matter key in `bin/seed.php`/`src/Exporter.php`, plus
  the optional AVIF `<source>` in `src/View.php`.
- `docs/consumers/viaje.md` (480/960/1600 webp) and `docs/consumers/php-site-template.md`
  (defaults) — short.
- `docs/skill-delta.md`: exact text changes for the synced `webimg-pipeline` skill.
- `CHANGELOG.md` with an `Unreleased` section listing O1–S6.
- Exit: every command in the README runs as written against the fixtures; no reference to
  "six files per slug" remains.

### 6.4 S8 — Release pass (after S5, S6, S7 merge)

- Merge main, `npm test`, `npm install` to refresh the lockfile, `npx --yes github:antonmarklundcom/webimg#main audit --help` smoke from a clean npx cache.
- Bump `package.json` to 0.2.0; `CHANGELOG.md` `0.2.0 — <date>`; tag `v0.2.0` after merge.
- Promote still-open items from all `docs/log/*.md` to `KNOWN-ISSUES.md`.
- Sync the README options table with actual `--help` output.
- Delete the watcher Routine if one exists. Closing report in `docs/log/s8.md`.

## 7. Human-inputs checklist

- None for lane 1. Everything runs offline.
- S6 Action templates: nothing to configure; they use the default `GITHUB_TOKEN`.
- After S8: Anton applies `docs/skill-delta.md` to the synced `webimg-pipeline` skill, and
  opens a session in `thingstodoinparaguay` with the prompt from `docs/consumers/thingstodoinparaguay.md`.

## 8. Open business questions (parked)

- Whether viaje.com.py and the Next.js sites should adopt `audit`/`fix` now or at their next
  content pass.
- Whether to publish webimg to npm under a scoped name (would shave the first-run clone).

## 9. Build log index

| Phase | PR | Log |
|---|---|---|
| plan | (this PR) | — |

## 10. Backlog

- `--concurrency` for batch/fix (sharp is already multi-threaded per op; measure first).
- `sharp` `limitInputPixels` / size caps on `serve` uploads beyond the 200 MB body limit.
- A `--snippet php|jsx` output style (return a PHP array / JSX element instead of HTML).
- `audit` for `.css`/`.scss` outside the web root; SVG handling (currently ignored on purpose).
- Publishing to npm.
