---
name: web-images
description: Anton's one standard process for images on his websites and apps — plan slots, generate with the Higgsfield MCP (GPT Image 2.5 Sunburst), convert with webimg to AVIF/WebP with SEO file names and alt text, place them in the repo for any stack (PHP, static HTML, Node/Next.js, apps), verify, and ship as a merged PR with zero manual image work from Anton. Use this skill BEFORE any Higgsfield generate_image call for a site or app, and whenever a site needs photos, images are missing or empty, Anton says "kör bilder", "generate the images", "images for <site>", "the site has no photos", "fix the images", "optimize the images", or when a Higgsfield result URL, a local PNG or an old WordPress site's media must become site files. Replaces higgsfield-image-pipeline, higgsfield-web-imagery and webimg-pipeline; if they disagree with this skill, this one wins. Not for Instagram/TikTok/social video.
---

# Web images: Higgsfield → webimg → repo → live

Goal: Anton asks for images and gets a merged PR with fast, SEO-named, alt-texted images
placed on the right pages. He never downloads, renames, converts or uploads a file.

Verified end to end on 2026-09-26/27 (dentista.com.py PRs #5, #6): generate → download →
webimg → PHP image map → local render check → PR → merge.

## 0. Check before spending anything

1. **What exists.** `git ls-files | grep -Ei 'imagery|jobs\.csv|assets/img/manifest'`,
   read `docs/imagery-manifest.json` (or root `imagery-manifest.json`), and for each entry
   check its files exist under the image folder. Also `git log --oneline -i --grep=imag`.
   - All files present → **done**, do not generate. Only place/wire what's unused.
   - Manifest has URLs but files are missing → **re-download** those URLs, do not regenerate.
   - Empty slots (pages whose image helper renders nothing, `image => null`, manifest rows
     without files) → these are the only things to generate.
   Regenerating an image that already exists wastes credits and has happened before.
2. **Downloads work here.** `curl -sS -o /dev/null -w '%{http_code}\n' <any cloudfront result URL>`
   (take one from the manifest). `200` → go. `403`/`000` → you are in a cloud environment
   without the allowlist: stop before generating and tell Anton to start the session in the
   **Images** cloud environment (Custom network: `*.cloudfront.net`, package managers ticked).
   Local sessions on Anton's PC have no restriction.
3. **webimg runs.** `npx -y github:antonmarklundcom/webimg --help` prints the command list.

## 1. Plan the slots (write the manifest first)

Decide every slot before generating so names and alt text are never improvised later.
Add rows to `docs/imagery-manifest.json` (keep the repo's existing shape and indentation):

`id` (the key the page uses) · `file` (SEO slug) · `alt_es` (or `alt_sv`) · `ratio` · `px`
(rendered width) · `model` · `variant` · `quality` · `resolution` · `prompt` · later `url`,
`width`, `height`, `job_id`.

- **file slug**: lowercase kebab-case ASCII, 3–8 words, subject + place:
  `endodoncia-tratamiento-conducto`, `urgencias-dentales-asuncion`. Never `hero`, `img1`.
- **alt**: one natural sentence in the site's language, 8–20 words, describes what is
  visible, no "imagen de"/"foto de". Alt must match the picture, so re-check it after
  seeing the result.
- **Only generate for a real slot.** Check the template: a page type that never renders an
  image (e.g. dentista guides) gets no image. Reuse an existing image when it fits.

### What may be generated

Illustrative people and scenes are fine (a dentist at work, a party setup). Never generate
anything that asserts a false fact about the business: captions naming staff ("nuestra
odontóloga", "Dr. X"), faces as testimonials or reviews, before/after presented as real
work, a specific real premises, vehicle or certificate. Health sites: prefer educational
still lifes and models over "results"; simulations must be captioned as simulations.
Emergency pages show calm, non-graphic scenes (no blood).

### Consistency

Write one shared style tail per site (palette with hex, light, lens, mood, and a negative
block: no text, letters, logos, watermarks, extra fingers, distorted teeth, plastic skin)
and append it to every prompt, so a set looks like one photographer shot it.
For a new site in a vertical that already has a set, reuse and re-crop before generating.

## 2. Generate (GPT Image 2.5 Sunburst)

Model is always `gpt_image_2_5` with `variant: "sunburst"`. No Nano Banana through the MCP.

| slot | quality | resolution | credits (2026-09) |
|---|---|---|---|
| shown ≤ 800 px wide (cards, service heroes, articles) | medium | 1k | 0.5 |
| ≥ 1200 px wide, 21:9 bands, OG image | medium | 2k | ~1.5 |
| home hero / LCP image, max 2–3 per site | high | 2k | ~2.75–3 |

1. `models_explore action=get model_id=gpt_image_2_5` once per session: confirm `sunburst`, `1k`, `2k`.
2. `generate_image` with `get_cost: true` for each quality/resolution you'll use. Record it
   in `_notes`. Never pass `use_unlim`.
3. `generate_image_batch` (≤12 per call), passing `model`, `variant`, `quality`,
   `resolution`, `aspect_ratio` explicitly every time — the defaults are wrong
   (`flare`/`low`). Then `jobs_wait` until terminal. On a timeout, never resubmit blindly:
   resolve the job ids first.
4. **Look at every result** (download and Read the PNG). Reject anything with text,
   warped hands/teeth, or a mismatch with the alt text; regenerate only that one.
5. **Pixel class check**: 1k ≈ 1024–1536 px long edge, 2k ≈ 2048–2752. Wrong class = wrong
   setting, stop.
6. `transactions` → one line per job, "GPT Image 2.5 Sunburst", credits equal to the preflight.
   Anything else: stop and report job ids to Anton. Note the check in `_notes`.

When a slot truly needs Nano Banana (dense on-image typography, exact reference edit),
don't generate: write the prompt into `docs/imagery-prompts-manual.md` and mark the row
`source: "manual-nanobanana"` for Anton to run in the Higgsfield UI (free for him there).

## 3. Convert with webimg (straight from the result URL)

Run from the repo root:

```
npx -y github:antonmarklundcom/webimg convert "<result URL>" \
  --name <slug> --alt "<alt>" --widths 640,1280 --out <image dir> --public-path <web path> \
  --sizes "<layout width, e.g. (min-width: 1024px) 620px, 100vw>" [--eager for the hero/LCP image]
```

The printed `<picture>` snippet is then paste-ready for hand-written HTML: `sizes` on every
source, and `--eager` swaps lazy loading for `fetchpriority="high"`. (Needs webimg with
these options, merged 2026-09-27; if `--sizes` is "unknown", clear the npx cache:
`rm -rf ~/.npm/_npx`.)

- `--widths`: match what the site's templates reference. Most of Anton's PHP/static sites
  use `640,1280`; use `640,1280,1920` only for 2k images shown full-width. webimg never
  upscales: a width above the source is written at source width but keeps its `-<width>`
  name, so templates stay stable. The info line "capped at source width" is expected for 1k.
- `--ar 21:9` etc. only when the slot's ratio differs from the generated ratio;
  `--position top` for people cropped wide.
- `--prompt` is optional when `--name` and `--alt` are given. Don't set `ANTHROPIC_API_KEY`.
- **Windows Git Bash** rewrites `/assets/img` into `C:/Program Files/Git/assets/img`:
  prefix the command with `MSYS_NO_PATHCONV=1` or run it from PowerShell.
- webimg writes `<out>/manifest.json`. Delete it unless the stack helper reads it (see
  `references/stacks.md`); the repo's `docs/imagery-manifest.json` is the record.
- Batch alternative: `webimg batch . --manifest jobs.csv --out <dir>` with columns
  `file,name,alt,ar,position` (file = URL).

## 4. Place (per stack)

Read `references/stacks.md` for the section matching the repo: PHP image map + `img()`
helper, static HTML (hand-written or generated by a build script), Node/Next.js
`<Picture>` component, or native apps. Rules for every stack:

- `<picture>` with AVIF then WebP sources, `srcset` + `sizes`, `<img>` with `alt`,
  `width`, `height`.
- The LCP image (hero) gets `fetchpriority="high"` and no lazy loading; everything else
  gets `loading="lazy" decoding="async"`.
- Add new images to the image sitemap if the site has one.

## 5. Verify by running the site

- Every slug referenced by a page has all its files (`<slug>-640.avif/.webp`, …).
- Start the site locally (`php -S`, the build script + static server, `npm run dev`/`build`)
  and fetch each changed page: HTTP 200, the `<picture>` is present, alt text correct.
- Crawl the sitemap if it's small: 200, one `<h1>`, JSON-LD parses. Lint what you touched
  (`php -l`, `npm run build`, the repo's checks).
- Budget: hero ≤ ~120 KB (AVIF at 1280 is usually 20–60 KB), no image > 200 KB.

## 6. Ship

One branch, one commit (or a few) with images + wiring + manifest update together.
Push, open a PR with: slots filled, model/settings, credits spent and ledger check, what was
verified. Merge when checks pass if Anton asked for merge in this conversation (he usually
does: "PR and merge when green"); a repo without CI counts as green after your local checks,
say so in the PR. Then confirm the live site: fetch one new page on the production domain.
If production doesn't show `main`/default-branch content, report the deploy mismatch
instead of assuming it deployed.

## Report back

Short table: slot → file → page, credits spent (preflight vs ledger), PR link + merged or
not, live check result, anything skipped and why.

## Don'ts

- Don't write one-off sharp/ImageMagick scripts, rename files by hand, or upload through
  Hostinger's file manager. webimg + git only.
- Don't regenerate existing images, pick another model, or raise quality on your own.
- Don't spend credits in an environment that can't download (step 0.2).
- Don't commit source PNGs.
