# webimg

Turns any source image (PNG, JPG, WebP, AVIF, TIFF, HEIC, GIF, local file or URL)
into a ready-to-commit website image set:

- `<slug>-640.avif` / `.webp`, `<slug>-1280.avif` / `.webp`, `<slug>-1920.…` (never upscaled)
- `<slug>-og.jpg`, 1200×630, for `og:image` (`--og`)
- each file held under a size budget by stepping quality down (`--max-kb`)
- EXIF/GPS stripped, colours converted to sRGB, alpha kept for logos
- a `manifest.json` with width, height, bytes, quality and a `<picture>` snippet per set
- SEO file names and alt text chosen by the Claude session (`--name` / `--alt`), no API key

Then `webimg upload` pushes the folder to Cloudflare R2, a git-deployed site folder or
SFTP, and `webimg audit` lists what is still wrong on a folder or a live page.

## Install

### Use from any repo without installing

```bash
npx --yes github:antonmarklundcom/webimg convert <image-or-URL> --name <slug> --alt "<alt>" --out assets/img --og
```

This works in Claude Code cloud sessions too: npm clones the public repo at run time.
If a documented flag shows as unknown, the npx cache is stale: `rm -rf ~/.npm/_npx`.

### Local install

```bash
cd webimg
npm install
npm link          # optional: puts `webimg` on your PATH
webimg --help     # or: node webimg.mjs --help
```

## Naming: no API key needed

The intended way to use webimg is from inside a Claude Code session: the session decides
the SEO slug and the alt text and passes them with `--name` and `--alt`. That path sends
nothing to any API. `ANTHROPIC_API_KEY` is optional, for running webimg on its own; then
`--prompt` is sent to Claude (`--model`, default `claude-opus-5-5`) to produce the name and
alt text, falling back to a slug of the prompt when the call fails.

## Commands

### convert

```bash
webimg convert ./input/consultorio.png \
  --name limpieza-dental-consultorio-asuncion \
  --alt "Higienista limpiando los dientes de una paciente en un consultorio luminoso" \
  --widths 640,1280 --og \
  --out assets/img --public-path /assets/img \
  --sizes "(min-width: 1024px) 620px, 100vw" [--eager]
```

Prints the alt text, the `<picture>` snippet and (with `--og`) the `og:image` meta tags.
`--ar 21:9` recrops to another ratio (`--position top|centre|attention|entropy`).
A Higgsfield result URL (or any http(s) image URL) works in place of the file: it is
downloaded to a temp file, converted, and the temp file is deleted.

Running the same command twice is free: when the source bytes and the output options are
unchanged and every file exists, webimg skips the encode (`↷ … skipped`) and only refreshes
the alt text / snippet in the manifest. `--force` re-encodes.

### Size budgets (`--max-kb`)

Every output is held under a budget by lowering quality in steps of 4 until it fits, never
below the floor (AVIF 28, WebP 40, JPG 60). Anything still over at the floor is reported
(`⚠ … OVER BUDGET`) and marked `over_budget: true` in the manifest, so nothing is silently
accepted or silently destroyed.

| Width | Default budget |
|---|---|
| 640 | 60 KB |
| 1280 | 120 KB |
| 1920 | 200 KB |
| other widths | interpolated (320 → 35 KB … 2560 → 280 KB) |
| `-og.jpg` | 200 KB |

Syntax: `--max-kb 120` (one number for every width), `--max-kb 640:50,1280:100,og:150`
(per width; the rest interpolated), `--max-kb off`.

### Hygiene

- Input EXIF, GPS, IPTC and XMP are never copied to the outputs.
- Pixels are converted to sRGB using the input's embedded profile and an sRGB profile is
  embedded, so colours match in every browser.
- Transparent PNG/WebP logos keep their alpha in WebP and AVIF. The `-og.jpg` is flattened
  onto `--og-background` (default white) because JPG has no transparency.
- `--copyright "© 2026 Clínica Ejemplo"` and `--creator "Name"` are written fresh as EXIF
  (`Copyright`, `Artist`) and XMP (`dc:rights`, `dc:creator`) on every output file.
- Inputs: `.png .jpg .jpeg .webp .avif .tif .tiff .gif`, plus `.heic/.heif` where the sharp
  build has a HEVC decoder (the prebuilt binaries do not; webimg then says so and asks for a
  JPG/PNG export).

### batch

```bash
webimg batch ./input --manifest ./input/jobs.csv --widths 640,1280 --og --out assets/img
```

CSV columns: `file` (path relative to `<dir>`, or a URL) plus `name`, `alt`, `prompt`,
`ar`, `position` (all optional, per-row values win over flags). JSON manifests take an array
of the same objects or a `{ "file.png": "prompt" }` map. Missing files are skipped; the run
ends with `Done: N converted, N unchanged, N skipped, N failed` and exits 1 only if a row
failed.

### upload

```bash
webimg upload assets/img --to r2 --bucket site-images --prefix dentista/img --dry-run
webimg upload assets/img --to r2 --bucket site-images --prefix dentista/img
webimg upload assets/img --to dir --dest ../dentista.com.py/assets/img
webimg upload assets/img --to sftp --remote-dir /home/u123/domains/x/public_html/assets/img
```

| Target | What it does |
|---|---|
| `r2` | Cloudflare R2 through the S3 API (`@aws-sdk/client-s3`). Every image is sent with `Cache-Control: public, max-age=31536000, immutable` and the right `Content-Type`; `manifest.json` (only with `--include-manifest`) gets `max-age=300`. Objects whose stored sha256 and size already match are skipped (`--force` to resend). |
| `dir` | For git-deployed sites (Hostinger Git deploy, Cloudflare Pages/Workers): copies into the repo's image folder, skipping identical files. Commit and push to deploy. |
| `sftp` | For sites not deployed from git: uploads over SFTP, creating folders as needed. |

Target paths are `--prefix` (key prefix inside the bucket / subfolder inside `--dest`) and
`--remote-dir`. `--name a,b` limits the upload to those image sets (from `manifest.json`).
`--dry-run` prints the full plan (keys, sizes, headers) without connecting.

Credentials come **only** from environment variables and are never printed, logged or
written:

```
R2:   R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET   (optional R2_ENDPOINT)
SFTP: SFTP_HOST  SFTP_USER  SFTP_PASSWORD or SFTP_KEY_PATH   (optional SFTP_PORT, SFTP_KEY_PASSPHRASE)
```

### audit

```bash
webimg audit assets/img                 # a folder: images + any HTML/PHP templates in it
webimg audit .                          # a whole site repo
webimg audit https://dentista.com.py/   # a live page
webimg audit . --strict --json          # exit 1 on problems, machine-readable
```

Reports: `oversized` (over the `--max-kb` budget for its width), `missing-pair`
(a `-640` without AVIF or WebP), `missing-og` (no `<slug>-og.jpg` next to a set, or no
`og:image` meta on a page), `missing-alt` / `empty-alt`, `missing-dimensions` (`<img>`
without `width`/`height`), `no-modern-format` (a plain JPG/PNG `<img>` outside a `<picture>`
with AVIF/WebP sources), `non-seo-name` (`img1`, `hero`, `IMG_1234`, `DSC…`, hashes, single
words) and, for URLs, `broken` image requests.

### serve, zip

```bash
webimg serve --out assets/img --open    # local drag-and-drop UI, downloads one by one or as zip
webimg zip assets/img --out imgs.zip    # bundle an output folder (or --name a,b) for hand-off
```

## Output and manifest

Every command writes into `--out` (default `./assets/img`). `manifest.json` merges across
runs (entries are replaced by `filename_base`):

```json
{
  "generated_at": "2026-10-11T20:00:00.000Z",
  "images": [
    {
      "filename_base": "limpieza-dental-consultorio-asuncion",
      "source": "https://…/result.png",
      "source_hash": "sha256:…",
      "options_hash": "sha256:…",
      "alt_text": "Higienista limpiando los dientes de una paciente en un consultorio luminoso",
      "naming_source": "fallback",
      "aspect_ratio": "source",
      "converted_at": "2026-10-11T20:00:00.000Z",
      "files": [
        { "file": "limpieza-dental-consultorio-asuncion-640.avif", "format": "avif", "width": 640, "height": 360, "bytes": 21504, "kb": 21.0, "quality": 44, "budget_kb": 60 },
        { "file": "limpieza-dental-consultorio-asuncion-og.jpg", "format": "jpg", "width": 1200, "height": 630, "bytes": 98304, "kb": 96.0, "quality": 82, "budget_kb": 200 }
      ],
      "html_snippet": "<picture>…</picture>",
      "og_snippet": "<meta property=\"og:image\" …>"
    }
  ]
}
```

`width`, `height` and `bytes` per file are there so templates can emit `width`/`height`
attributes (no layout shift) and so `audit`/`upload` can skip what is already right.

## Options

| Option | Applies to | Default | Notes |
|---|---|---|---|
| `--name <slug>` | convert | — | SEO slug for the file names (validated: kebab-case, 3–80 chars, not only stopwords) |
| `--alt <text>` | convert | — | alt text for the snippet and manifest |
| `--prompt <text>` | convert, batch rows | — | only needed when `--name`/`--alt` are not given; used for naming (API) or the fallback slug |
| `--ar <ratio>` | convert, batch | source ratio | `21:9`, `21/9` or `2.333` |
| `--widths <list>` | convert, batch | `640,1280,1920` | never upscales; a width above the source keeps its `-<width>` name at source size |
| `--og` | convert, batch | off | also write `<slug>-og.jpg` 1200×630 (mozjpeg, progressive, attention crop) |
| `--og-background <color>` | convert, batch | `#ffffff` | flatten colour for transparent sources in the og JPG |
| `--max-kb <spec>` | convert, batch, audit | defaults above | `120`, `640:60,1280:120,og:200`, or `off` |
| `--quality-avif <n>` / `--quality-webp <n>` | convert, batch | `44` / `60` | starting qualities before the budget step-down |
| `--copyright <text>` / `--creator <text>` | convert, batch | — | written as EXIF + XMP on every output |
| `--force` | convert, batch, upload | off | re-encode / re-upload even when unchanged |
| `--out <dir>` | convert, batch | `./assets/img` | |
| `--public-path <path>` | convert, batch | `--out` relative to cwd | web path in the snippets, e.g. `/assets/img` |
| `--sizes <value>` | convert, batch | — | `sizes` attribute on sources and img |
| `--eager` | convert | off | `fetchpriority="high"` instead of lazy loading (hero/LCP) |
| `--position <pos>` | convert, batch | `attention` | `attention`, `top`, `centre`, `entropy` |
| `--model <id>` | convert, batch, serve | `claude-opus-5-5` | only used with `ANTHROPIC_API_KEY` |
| `--dry-run` | convert, batch, upload | off | names, dimensions, qualities and budgets (or the upload plan), nothing written |
| `--to r2\|dir\|sftp`, `--bucket`, `--prefix`, `--endpoint`, `--dest`, `--remote-dir`, `--name`, `--include-manifest` | upload | | see *upload* |
| `--strict`, `--json` | audit | off | exit 1 on findings / JSON output |

## Privacy

Image bytes stay on the machine running webimg (a URL input is downloaded to a temp file
and deleted). Only the `--prompt` text goes to the Anthropic API, and only when
`ANTHROPIC_API_KEY` is set. `upload` sends files only to the target you name, with
credentials read from env vars that are never echoed.

## Testing and CI

```bash
npm test
```

`node --test`; fixtures are generated with sharp at test time (no binaries committed), the
R2 target is tested against a local fake S3 endpoint, SFTP against a fake client. Tests pass
with `ANTHROPIC_API_KEY` unset. GitHub Actions runs the suite on pull requests only
(one Node 20 job, superseded runs cancelled) to keep Actions minutes low.

## Claude skill

`skill/web-images/` is the Claude skill that drives the whole pipeline: plan one image per
page, generate with Higgsfield (Nano Banana 2.1, thinking High, 2K), convert with webimg
(`--og`, budgets), place per stack, verify, ship. Install it by copying the folder to
`~/.claude/skills/`. On Windows Git Bash, prefix commands that pass `/assets/img`-style
paths with `MSYS_NO_PATHCONV=1`.
