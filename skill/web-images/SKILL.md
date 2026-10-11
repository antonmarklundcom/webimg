---
name: web-images
description: Anton's single image skill for his websites and apps — plan one image per page, generate with the Higgsfield MCP using Nano Banana 2.1 (nano_banana_2_1, thinking_level high, 2k by default), convert with webimg to AVIF/WebP + og:image with SEO file names and per-page alt text, place per stack (PHP, static, Next.js, apps), verify, ship a merged PR. Use whenever Anton writes "Generate image", "generate images", "kör bilder", "images for a site", "bilder till en sajt", "imágenes para un sitio", "optimize images", "the site has no photos", "fix the images", or when a Higgsfield result URL, a local PNG or old WordPress media must become site files. Load it before ANY Higgsfield generate_image call for a site or app. Loading it never authorizes spending credits; generation happens only after Anton writes the exact words "Generate image" in the current chat. Replaces higgsfield-image-pipeline, higgsfield-web-imagery and webimg-pipeline. Not for social video or cuentos books.
---

# Web images: Higgsfield (Nano Banana 2.1) → webimg → repo → live

Goal: Anton asks for images and gets a merged PR with fast, SEO-named, alt-texted images on
the right pages. He never downloads, renames, converts or uploads a file.

Verified: pipeline end to end 2026-09-26/27 (dentista.com.py PRs #5, #6, then on GPT Image);
Nano Banana 2.1 model id, parameters and prices re-verified against the MCP on 2026-10-11.

## The one hard rule: no generation without "Generate image"

Credits are only spent after Anton has written the exact words **"Generate image"** (or
"Generate images") in the current chat. "Plan the images", "images for X", "optimize images",
"kör bilder" and loading this skill are **not** authorization: do steps 0–1 (and 3–6 for
images that already exist), then stop and show the plan with the credit total. Never generate
on your own initiative, in a Routine, a subagent, or a background task.

## 0. Check before spending anything

1. **What exists.** `git ls-files | grep -Ei 'imagery|jobs\.csv|assets/img/manifest'`, read
   `docs/imagery-manifest.json` (or root `imagery-manifest.json`), and for each row check its
   files exist under the image folder. Also `git log --oneline -i --grep=imag`.
   - All files present → **done**, do not generate. Only place/wire what's unused.
   - Manifest has URLs but files are missing → **re-download** those URLs, do not regenerate.
   - Empty slots (pages whose image helper renders nothing, `image => null`, manifest rows
     without files) → these are the only candidates for generation.
   Regenerating an image that already exists wastes credits and has happened before.
2. **Downloads work here.** `curl -sS -o /dev/null -w '%{http_code}\n' <any cloudfront result URL>`
   (take one from the manifest, or from `show_generations`). `200` → go. `403`/`000` → you
   are in a cloud environment without the allowlist: stop before generating and tell Anton
   to start the session in the **Images** cloud environment (Custom network:
   `*.cloudfront.net`, package managers ticked). Local sessions on Anton's PC are unrestricted.
3. **webimg runs.** `npx -y github:antonmarklundcom/webimg --help` prints the command list.
   If a documented flag shows as unknown, clear the npx cache: `rm -rf ~/.npm/_npx`.
4. **Credit preflight** (every run, even for one image): `balance` → note credits. Then
   `generate_image` with `get_cost: true` once per resolution you will use (see §2) and
   multiply by the slot count. Write balance, unit prices and the planned total into the
   manifest `_notes`. If the total is more than ~10% of the balance, ask before generating.

## 1. Plan the slots (write the manifest first)

Decide every slot before generating so names and alt text are never improvised later.
Add rows to `docs/imagery-manifest.json` (keep the repo's existing shape and indentation).
Record per slot:

`id` (the key the page uses) · `page` (route) · `file` (SEO slug) · `alt_es`/`alt_sv` ·
`ratio` · `px` (rendered width) · `model` (`nano_banana_2_1`) · `resolution` (`2k`/`4k`) ·
`thinking_level` (`high`) · `aspect_ratio` · `prompt` · later `url`, `width`, `height`,
`job_id`, `credits`, `generated_at`.

- **One image per page, no category fallbacks.** Every page that renders an image gets its
  own slot and its own picture. Do not reuse one "servicios" image across the service pages
  or one city image across the city pages unless Anton says so in this chat. Pages whose
  template never renders an image (e.g. dentista guides) get no slot.
- **File name = SEO slug**: lowercase kebab-case ASCII, 3–8 words, **subject + use + place**,
  in the site's language: Spanish for Paraguay sites (`limpieza-dental-consultorio-asuncion`,
  `tasacion-casa-barrio-luque`), Swedish for Sweden sites (`takbyte-villa-hantverkare-umea`,
  `redovisning-kontor-moten-stockholm`). Never `hero`, `img1`, `banner`, `IMG_1234`, no
  dates, no model names.
- **Alt text per page, from what is visible**: one natural sentence in the site's language,
  8–20 words, describing what the picture actually shows (people, objects, place, action),
  no "imagen de"/"foto de"/"bild på". Write a draft while planning, then **rewrite it after
  looking at the result** so it matches the pixels, not the prompt.
- Keep `docs/imagery-manifest.json` as the record; webimg's own `manifest.json` is a build
  artifact (see §3).

### What may be generated

Illustrative people and scenes are fine (a dentist at work, a party setup). Never generate
anything that asserts a false fact about the business: no staff names or "nuestra
odontóloga"/"vår tandläkare" captions, no faces presented as testimonials or reviews, no
before/after presented as real work, no specific real premises, vehicle, certificate or
award. Health sites: prefer educational still lifes and models over "results"; simulations
must be captioned as simulations. Emergency pages: calm, non-graphic scenes (no blood).

### Shared style tail per site

Write one style tail per site and append it to **every** prompt so the set looks like one
photographer shot it. Store it in the manifest under `_style`. It contains:

- palette as hex (brand colours plus 1–2 neutrals), e.g. `#0F766E, #F1F5F9, warm wood`;
- light (`soft daylight from a large window`, `golden hour`), lens (`35mm`, `85mm f/2`),
  mood;
- the negative block, verbatim: `No text, letters, numbers, logos, watermarks, brand names,
  signage with words, UI overlays. No deformed or extra hands and fingers, no distorted
  faces or teeth, no plastic skin.`

For a new site in a vertical that already has a set, reuse and re-crop before generating.

## 2. Generate (Nano Banana 2.1, thinking High, 2K default)

Model is always `nano_banana_2_1` ("Nano Banana 2.1", Google, via the Higgsfield MCP).
It has **no `quality` parameter**; "High" means `thinking_level: "high"`. Pass every
parameter explicitly, the defaults are wrong (`1k`, `medium`):

```json
{ "model": "nano_banana_2_1", "prompt": "<slot prompt + style tail>",
  "aspect_ratio": "16:9", "resolution": "2k", "thinking_level": "high" }
```

| slot | resolution | credits each (verified 2026-10-11) |
|---|---|---|
| default: every page image, cards, service heroes, articles, OG source | `2k` | **2** |
| full-bleed home hero / LCP image shown ≥ 1600 px wide, or when Anton asks | `4k` | **3** |
| not used (too small for 1280 variants) | `1k` | 1.5 |

Price depends only on `resolution`; `thinking_level` does not change it. Confirm with
`get_cost: true` each run (step 0.4), the numbers above are what to expect.

Allowed `aspect_ratio` values: `auto, 1:1, 3:2, 2:3, 4:3, 3:4, 4:5, 5:4, 9:16, 16:9, 21:9,
4:1, 1:4, 8:1, 1:8`. Pick the slot's ratio; `16:9` or `3:2` for anything that also feeds
the 1200×630 og:image (1.91:1 crops cleanly from both). Optional: `seed` to repeat a look,
`medias` with role `image_references` to keep a product or room consistent.

1. `models_explore action=get model_id=nano_banana_2_1` once per session: confirm the id
   and that `resolution` still offers `2k`/`4k` and `thinking_level` offers `high`.
2. Preflight done in 0.4. Never pass `use_unlim`.
3. `generate_image_batch` (≤12 per call) with `model`, `resolution`, `thinking_level`,
   `aspect_ratio` on **every** item; one image → `generate_image`. Then `jobs_wait` until
   terminal. On a timeout never resubmit blindly: resolve the job ids first
   (`show_generation_by_ids`).
4. **Look at every result** (download and Read the PNG/WebP). Reject anything with text,
   logos, warped hands/teeth/faces, or a mismatch with the planned alt text; regenerate only
   that one, with the defect named in the prompt.
5. **Pixel class check**: `2k` ≈ 2048 px on the long edge (±10%), `4k` ≈ 4096. A `1k`-sized
   result (~1024) means the parameter did not apply: stop, do not convert, report.
6. **Ledger check**: `transactions` → one `Nano Banana 2.1` row per job, `-2` (2k) or `-3`
   (4k) credits, sum equal to the preflight total. Anything else (extra rows, different
   amounts): stop and report job ids to Anton. Write the check result in `_notes`.

## 3. Convert with webimg (straight from the result URL)

Run from the repo root:

```
npx -y github:antonmarklundcom/webimg convert "<result URL>" \
  --name <slug> --alt "<alt>" --widths 640,1280 --out <image dir> --public-path <web path> \
  --sizes "<layout width, e.g. (min-width: 1024px) 620px, 100vw>" [--eager for the hero/LCP image]
```

The printed `<picture>` snippet is paste-ready for hand-written HTML: `sizes` on every
source, and `--eager` swaps lazy loading for `fetchpriority="high"`.

- `--widths`: match what the site's templates reference. Most of Anton's PHP/static sites
  use `640,1280`; use `640,1280,1920` for `4k` images shown full-width. webimg never
  upscales: a width above the source is written at source width but keeps its `-<width>`
  name, so templates stay stable.
- `--ar 21:9` etc. only when the slot's ratio differs from the generated ratio;
  `--position top` for people cropped wide.
- `--prompt` is optional when `--name` and `--alt` are given. Don't set `ANTHROPIC_API_KEY`.
- **Windows Git Bash** rewrites `/assets/img` into `C:/Program Files/Git/assets/img`:
  prefix the command with `MSYS_NO_PATHCONV=1` or run it from PowerShell.
- webimg writes `<out>/manifest.json`. Delete it unless the stack helper reads it (see
  `references/stacks.md`); the repo's `docs/imagery-manifest.json` is the record.
- Batch alternative: `webimg batch . --manifest jobs.csv --out <dir>` with columns
  `file,name,alt,ar,position` (file = URL).
- Budget: AVIF at 1280 ≤ ~120 KB, nothing > 200 KB. If a file is over, lower
  `--quality-avif`/`--quality-webp` for that image only and note it.

## 4. Place (per stack)

Read `references/stacks.md` for the section matching the repo: PHP image map + `img()`
helper, static HTML (hand-written or generated by a build script), Node/Next.js
`<Picture>` component, or native apps. Rules for every stack:

- `<picture>` with AVIF then WebP sources, `srcset` + `sizes`, `<img>` with `alt`,
  `width`, `height` (real pixel size of the file, so there is no layout shift).
- The LCP image (hero) gets `fetchpriority="high"` and no lazy loading; everything else
  gets `loading="lazy" decoding="async"`.
- Add new images to the image sitemap if the site has one; set the page's `og:image` if the
  template supports it.

## 5. Verify by running the site

- Every slug referenced by a page has all its files (`<slug>-640.avif/.webp`, …).
- Start the site locally (`php -S`, the build script + static server, `npm run dev`/`build`)
  and fetch each changed page: HTTP 200, the `<picture>` is present, alt text correct and
  specific to that page.
- Crawl the sitemap if it's small: 200, one `<h1>`, JSON-LD parses. Lint what you touched
  (`php -l`, `npm run build`, the repo's checks).

## 6. Ship

One branch, one commit (or a few) with images + wiring + manifest update together.
Push, open a PR with: slots filled (page → file), model + resolution + thinking level,
credits spent (preflight vs ledger), what was verified. Merge when checks pass if Anton asked
for merge in this conversation (he usually does: "PR and merge when green"); a repo without
CI counts as green after your local checks, say so in the PR. Then confirm the live site:
fetch one new page on the production domain. If production doesn't show `main` content,
report the deploy mismatch instead of assuming it deployed.

## Report back

Short table: page → slot → file, credits spent (preflight vs ledger, per job), PR link +
merged or not, live check result, anything skipped and why.

## Don'ts

- Don't generate before Anton has written "Generate image" in this chat.
- Don't regenerate existing images, pick another model, raise to `4k`, or add
  `use_unlim` on your own.
- Don't share one image across several pages unless told to.
- Don't write one-off sharp/ImageMagick scripts, rename files by hand, or upload through
  Hostinger's file manager. webimg + git only.
- Don't spend credits in an environment that can't download (step 0.2).
- Don't commit source PNGs.
