# webimg

Converts PNG/JPG source images into SEO-named AVIF + WebP sets for static
sites, generating keyword-rich filenames and Spanish alt text with Claude
(falling back to a slugified prompt when no API key is set).

## Install

### Use from any repo without installing

```bash
npx --yes github:antonmarklundcom/webimg convert <image-or-URL> --prompt "..." --ar 21:9 --out assets/img
```

This works in Claude Code cloud sessions too, since npm clones the repo at
run time and the repo is public — no local install or `npm link` needed.

### Local install

```bash
# copy or git clone this folder, then:
cd webimg
npm install

# optional: put `webimg` on your PATH
npm link
webimg --help

# or just run it directly without linking:
node webimg.mjs --help
```

## Env var

webimg reads `ANTHROPIC_API_KEY` to call Claude for filename/alt-text
generation. If it's unset, naming falls back to a mechanical slug of the
`--prompt` text (or the input filename) — the tool still works fully, just
without LLM-generated names.

PowerShell:

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

Bash:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## Usage

### Convert a single image

```bash
webimg convert ./input/san-lorenzo.png \
  --prompt "san lorenzo zone, residential street" \
  --ar 21:9 \
  --widths 640,1280,1920 \
  --out ./assets/img
```

Skip LLM naming and pick your own filename slug:

```bash
webimg convert ./input/san-lorenzo.png \
  --prompt "san lorenzo zone, residential street" \
  --name calle-residencial-san-lorenzo \
  --out ./assets/img
```

### Using with Higgsfield (or any image URL)

`convert` and `batch` accept an http(s) URL as the image source, not just a
local path. That makes a one-command loop possible from inside a Claude
Code session:

```bash
webimg convert https://.../result.png \
  --prompt "fachada de casa en Luque" \
  --ar 4:3 \
  --out assets/img
```

The loop, in three steps:

1. Generate the image with the Higgsfield MCP and get back a result URL.
2. Run `webimg convert <that URL> --prompt "..."` — webimg downloads
   it to a temp file, converts it to AVIF + WebP, names it, and deletes the
   temp file when done.
3. Paste `alt_text` and `html_snippet` straight out of `manifest.json` (or
   the terminal output) into the page.

This works the same in both local and cloud/sandboxed Claude Code sessions,
since only the URL and the `--prompt` text change hands — no local file
access is required on the Higgsfield side.

URL inputs work in `batch` manifests too: put the URL in the `file` column
(CSV) or field (JSON) instead of a filename, and it will be downloaded
instead of resolved against `<dir>`.

Supported input types (local path or URL): `.png`, `.jpg`, `.jpeg`,
`.webp`. `.webp` covers most Higgsfield output.

### Batch mode

```bash
webimg batch ./input --manifest ./input/batch.csv --ar 21:9 --out ./assets/img
```

CSV manifest (`file,prompt` required; `name,alt,ar,position` optional,
per-row overrides win over CLI flags):

```csv
file,prompt
san-lorenzo.png,"san lorenzo zone, residential street"
luque-office.png,"real estate office facade, Luque",tasacion-de-inmuebles-luque
```

JSON manifest — either an array of row objects:

```json
[
  { "file": "san-lorenzo.png", "prompt": "san lorenzo zone, residential street" },
  { "file": "luque-office.png", "prompt": "real estate office facade, Luque", "ar": "21:9" }
]
```

or a `{ file: prompt }` map (string value, or an object with `prompt`/`name`/`alt`/`ar`/`position`):

```json
{
  "san-lorenzo.png": "san lorenzo zone, residential street",
  "luque-office.png": { "prompt": "real estate office facade, Luque", "ar": "21:9" }
}
```

Missing files are skipped (not fatal); the run ends with a summary line and
exits 1 only if any row actually failed to process.

## Output

Each run writes `<outDir>/manifest.json`, merging with whatever is already
there (entries are matched and replaced by `filename_base`, so repeat runs
and batch runs accumulate instead of clobbering each other):

```json
{
  "generated_at": "2026-09-04T12:00:00.000Z",
  "images": [
    {
      "filename_base": "calle-residencial-san-lorenzo",
      "source": "input/san-lorenzo.png",
      "prompt": "san lorenzo zone, residential street",
      "alt_text": "Calle residencial arbolada en San Lorenzo con casas de una planta",
      "naming_source": "llm",
      "aspect_ratio": "21:9",
      "files": [
        { "file": "calle-residencial-san-lorenzo-640.avif", "format": "avif", "width": 640, "height": 274, "kb": 12.4 },
        { "file": "calle-residencial-san-lorenzo-640.webp", "format": "webp", "width": 640, "height": 274, "kb": 21.0 }
      ],
      "html_snippet": "<picture>...</picture>"
    }
  ]
}
```

The `html_snippet` field is a ready-to-paste `<picture>` element (AVIF +
WebP sources with a `srcset`, a WebP `<img>` fallback at the middle width).
`convert` also prints the alt text and this snippet to the terminal at the
end of the run so you can copy it straight out.

## Options

| Option | Applies to | Default | Notes |
|---|---|---|---|
| `--prompt <text>` | convert | — | required; used for LLM naming/alt and as the fallback slug source |
| `--ar <ratio>` | convert, batch | source aspect ratio | `21:9`, `21/9`, or a decimal like `2.333`; rows can override in batch |
| `--widths <list>` | convert, batch | `640,1280,1920` | comma-separated positive integers |
| `--quality-avif <n>` | convert, batch | `44` | |
| `--quality-webp <n>` | convert, batch | `60` | |
| `--out <dir>` | convert, batch | `./assets/img` | |
| `--model <model>` | convert, batch | `claude-sonnet-5` | |
| `--name <slug>` | convert | — | skips the LLM for naming; still validated |
| `--alt <text>` | convert | — | overrides alt text |
| `--position <pos>` | convert, batch | `attention` | `attention`\|`top`\|`centre`\|`entropy`; rows can override in batch |
| `--dry-run` | convert, batch | off | prints planned names/dimensions, writes nothing |
| `--manifest <file>` | batch | — | required; `.csv` or `.json` |

## Privacy note

webimg runs entirely on your own machine and reads local image files
directly — the image bytes are never sent anywhere. When given a URL
instead of a local path, webimg downloads it to a temp file, processes
it locally, and deletes the temp file when done; the bytes still never go
anywhere but through your own machine. Only the `--prompt` text (a short
description you provide) is sent to the Anthropic API, and
only when `ANTHROPIC_API_KEY` is set.

## Testing

```bash
npm test
```

Tests run with `node --test`, generate their own PNG fixture with `sharp`
at test time (no binary fixtures committed), and pass with
`ANTHROPIC_API_KEY` unset.
