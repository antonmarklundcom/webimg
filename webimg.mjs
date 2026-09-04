#!/usr/bin/env node
// webimg — convert PNG/JPG into SEO-named AVIF + WebP sets, with LLM naming/alt text.

import { Command } from "commander";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateNaming, validateSlug } from "./src/naming.js";
import { processImage } from "./src/process.js";
import { writeManifest } from "./src/manifest.js";
import { loadBatchManifest } from "./src/batch.js";
import { fetchToTemp } from "./src/fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fssync.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const VALID_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const URL_RE = /^https?:\/\//i;

function isUrl(str) {
  return URL_RE.test(String(str || ""));
}

function parseWidths(str) {
  const parts = String(str)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`invalid --widths value: ${str}`);
  }
  const nums = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`invalid width value: "${p}" (must be a positive integer)`);
    }
    return n;
  });
  return [...new Set(nums)].sort((a, b) => a - b);
}

function parseAr(str) {
  if (str === undefined || str === null || str === "") return null;
  const s = String(str).trim();
  let w, h;
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length !== 2) throw new Error(`invalid --ar value: ${str}`);
    w = Number(parts[0]);
    h = Number(parts[1]);
  } else if (s.includes("/")) {
    const parts = s.split("/");
    if (parts.length !== 2) throw new Error(`invalid --ar value: ${str}`);
    w = Number(parts[0]);
    h = Number(parts[1]);
  } else {
    w = Number(s);
    h = 1;
  }
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`invalid --ar value: ${str}`);
  }
  return [w, h];
}

function formatAr(ar) {
  if (!ar) return "source";
  return `${ar[0]}:${ar[1]}`;
}

function normalizeOutPrefix(outDir) {
  let p = outDir.replace(/\\/g, "/");
  p = p.replace(/^\.\//, "");
  p = p.replace(/\/+$/, "");
  return p;
}

function pickMidWidth(widths) {
  const sorted = [...widths].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = Math.floor((sorted.length - 1) / 2);
  return sorted[idx];
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildHtmlSnippet({ outPrefix, filenameBase, widths, altText, entries }) {
  const sortedWidths = [...widths].sort((a, b) => a - b);
  const avifSrcset = sortedWidths
    .map((w) => `${outPrefix}/${filenameBase}-${w}.avif ${w}w`)
    .join(", ");
  const webpSrcset = sortedWidths
    .map((w) => `${outPrefix}/${filenameBase}-${w}.webp ${w}w`)
    .join(", ");

  const midWidth = pickMidWidth(sortedWidths);
  const midEntry = entries.find((e) => e.format === "webp" && e.width === midWidth) ||
    entries.find((e) => e.format === "webp");
  const imgSrc = `${outPrefix}/${filenameBase}-${midWidth}.webp`;
  const imgWidth = midEntry ? midEntry.width : midWidth;
  const imgHeight = midEntry ? midEntry.height : Math.round(midWidth);

  return [
    "<picture>",
    `  <source type="image/avif" srcset="${avifSrcset}">`,
    `  <source type="image/webp" srcset="${webpSrcset}">`,
    `  <img src="${imgSrc}" alt="${escapeAttr(altText)}" width="${imgWidth}" height="${imgHeight}" loading="lazy" decoding="async">`,
    "</picture>",
  ].join("\n");
}

function buildFilesForManifest(entries) {
  return entries.map((e) => ({
    file: e.file,
    format: e.format,
    width: e.width,
    height: e.height,
    kb: Math.round((e.bytes / 1024) * 10) / 10,
  }));
}

/**
 * Resolves filename_base + alt_text, honoring --name/--alt overrides.
 * Never throws for API failures (generateNaming already falls back);
 * throws only if an explicit --name slug fails validation.
 */
async function resolveNaming({ nameOpt, altOpt, prompt, apiKey, model, inputBasename }) {
  if (nameOpt) {
    if (!validateSlug(nameOpt)) {
      throw new Error(`invalid --name slug: "${nameOpt}"`);
    }
    if (altOpt) {
      return { filename_base: nameOpt, alt_text: altOpt, source: "fallback" };
    }
    if (apiKey) {
      const result = await generateNaming({ prompt, model, apiKey });
      return { filename_base: nameOpt, alt_text: result.alt_text, source: result.source };
    }
    return { filename_base: nameOpt, alt_text: (prompt || "").trim(), source: "fallback" };
  }

  const result = await generateNaming({ prompt, model, apiKey, inputBasename });
  const altText = altOpt || result.alt_text;
  return { filename_base: result.filename_base, alt_text: altText, source: result.source };
}

async function runConvert(input, opts) {
  const inputIsUrl = isUrl(input);
  let resolvedInput = input;
  let cleanup = null;

  try {
    if (inputIsUrl) {
      const downloaded = await fetchToTemp(input);
      resolvedInput = downloaded.path;
      cleanup = downloaded.cleanup;
    }

    const ext = path.extname(resolvedInput).toLowerCase();
    if (!VALID_EXTENSIONS.has(ext)) {
      throw new Error(`unsupported input type "${ext}" — expected .png, .jpg, .jpeg, or .webp`);
    }

    const widths = parseWidths(opts.widths);
    const ar = opts.ar ? parseAr(opts.ar) : null;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const inputBasename = inputIsUrl
      ? undefined
      : path.basename(resolvedInput, path.extname(resolvedInput));

    const naming = await resolveNaming({
      nameOpt: opts.name,
      altOpt: opts.alt,
      prompt: opts.prompt,
      apiKey,
      model: opts.model,
      inputBasename,
    });

    const outDir = opts.out;
    const entries = await processImage({
      input: resolvedInput,
      filenameBase: naming.filename_base,
      widths,
      ar,
      qualityAvif: opts.qualityAvif,
      qualityWebp: opts.qualityWebp,
      outDir,
      position: opts.position,
      dryRun: opts.dryRun,
    });

    if (opts.dryRun) {
      console.log(`ℹ dry run — would generate ${entries.length} files for "${naming.filename_base}":`);
      for (const e of entries) {
        console.log(`  ${e.file}  ${e.width}×${e.height}`);
      }
      console.log(`ℹ alt text: ${naming.alt_text}`);
      return;
    }

    const outPrefix = normalizeOutPrefix(outDir);
    const htmlSnippet = buildHtmlSnippet({
      outPrefix,
      filenameBase: naming.filename_base,
      widths,
      altText: naming.alt_text,
      entries,
    });

    const manifestEntry = {
      filename_base: naming.filename_base,
      source: inputIsUrl ? input : path.relative(process.cwd(), input).replace(/\\/g, "/"),
      prompt: opts.prompt || "",
      alt_text: naming.alt_text,
      naming_source: naming.source,
      aspect_ratio: formatAr(ar),
      files: buildFilesForManifest(entries),
      html_snippet: htmlSnippet,
    };

    await writeManifest(outDir, [manifestEntry]);

    console.log(`\nAlt text: ${naming.alt_text}\n`);
    console.log(htmlSnippet);
  } finally {
    if (cleanup) await cleanup();
  }
}

async function runBatch(dir, opts) {
  const manifestFile = opts.manifest;
  if (!manifestFile) {
    throw new Error("--manifest <file.csv|file.json> is required");
  }

  const rows = await loadBatchManifest(manifestFile);
  const widthsDefault = parseWidths(opts.widths);
  const arDefault = opts.ar ? parseAr(opts.ar) : null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const outDir = opts.out;
  const outPrefix = normalizeOutPrefix(outDir);

  let converted = 0;
  let skipped = 0;
  let failed = 0;
  const manifestEntries = [];

  for (const row of rows) {
    if (!row.file) {
      console.error(`✗ batch row missing "file", skipping`);
      skipped++;
      continue;
    }

    const rowIsUrl = isUrl(row.file);
    const inputPath = rowIsUrl ? row.file : path.join(dir, row.file);
    if (!rowIsUrl && !fssync.existsSync(inputPath)) {
      console.error(`✗ ${row.file} not found, skipping`);
      skipped++;
      continue;
    }

    let resolvedInput = inputPath;
    let cleanup = null;

    try {
      if (rowIsUrl) {
        const downloaded = await fetchToTemp(inputPath);
        resolvedInput = downloaded.path;
        cleanup = downloaded.cleanup;
      }

      const ext = path.extname(resolvedInput).toLowerCase();
      if (!VALID_EXTENSIONS.has(ext)) {
        throw new Error(`unsupported input type "${ext}"`);
      }

      const rowAr = row.ar ? parseAr(row.ar) : arDefault;
      const rowPosition = row.position || opts.position;

      const inputBasename = rowIsUrl
        ? undefined
        : path.basename(resolvedInput, path.extname(resolvedInput));

      const naming = await resolveNaming({
        nameOpt: row.name,
        altOpt: row.alt,
        prompt: row.prompt,
        apiKey,
        model: opts.model,
        inputBasename,
      });

      const entries = await processImage({
        input: resolvedInput,
        filenameBase: naming.filename_base,
        widths: widthsDefault,
        ar: rowAr,
        qualityAvif: opts.qualityAvif,
        qualityWebp: opts.qualityWebp,
        outDir,
        position: rowPosition,
        dryRun: opts.dryRun,
      });

      if (opts.dryRun) {
        console.log(`ℹ dry run — would generate ${entries.length} files for "${naming.filename_base}":`);
        for (const e of entries) {
          console.log(`  ${e.file}  ${e.width}×${e.height}`);
        }
        converted++;
        continue;
      }

      const htmlSnippet = buildHtmlSnippet({
        outPrefix,
        filenameBase: naming.filename_base,
        widths: widthsDefault,
        altText: naming.alt_text,
        entries,
      });

      manifestEntries.push({
        filename_base: naming.filename_base,
        source: rowIsUrl ? row.file : path.relative(process.cwd(), inputPath).replace(/\\/g, "/"),
        prompt: row.prompt || "",
        alt_text: naming.alt_text,
        naming_source: naming.source,
        aspect_ratio: formatAr(rowAr),
        files: buildFilesForManifest(entries),
        html_snippet: htmlSnippet,
      });

      converted++;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      console.error(`✗ ${row.file} failed: ${reason}`);
      failed++;
    } finally {
      if (cleanup) await cleanup();
    }
  }

  if (!opts.dryRun && manifestEntries.length > 0) {
    await writeManifest(outDir, manifestEntries);
  }

  console.log(`Done: ${converted} converted, ${skipped} skipped, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const program = new Command();

  program
    .name("webimg")
    .description("Convert PNG/JPG into SEO-named AVIF + WebP sets for static sites, with LLM-generated filenames and alt text.")
    .version(pkg.version);

  program
    .command("convert")
    .description("Convert a single image into an SEO-named AVIF + WebP set")
    .argument("<input>", "path to a .png, .jpg, .jpeg, or .webp source image, or an http(s) URL to one")
    .requiredOption("--prompt <text>", "short description used for LLM naming/alt text")
    .option("--ar <ratio>", "target aspect ratio, e.g. 21:9 (default: source aspect ratio)")
    .option("--widths <list>", "comma-separated output widths", "640,1280,1920")
    .option("--quality-avif <n>", "AVIF quality (0-100)", (v) => Number(v), 44)
    .option("--quality-webp <n>", "WebP quality (0-100)", (v) => Number(v), 60)
    .option("--out <dir>", "output directory", "./assets/img")
    .option("--model <model>", "Claude model for naming/alt text", "claude-sonnet-5")
    .option("--name <slug>", "skip LLM naming and use this slug (still validated)")
    .option("--alt <text>", "override alt text")
    .option("--position <pos>", "crop position: attention|top|centre|entropy", "attention")
    .option("--dry-run", "print planned output without writing files", false)
    .action(async (input, opts) => {
      await runConvert(input, opts);
    });

  program
    .command("batch")
    .description("Convert a batch of images described by a CSV or JSON manifest")
    .argument("<dir>", "directory containing the source images")
    .requiredOption("--manifest <file>", "path to a .csv or .json batch manifest")
    .option("--ar <ratio>", "default target aspect ratio (rows may override)")
    .option("--widths <list>", "comma-separated output widths", "640,1280,1920")
    .option("--quality-avif <n>", "AVIF quality (0-100)", (v) => Number(v), 44)
    .option("--quality-webp <n>", "WebP quality (0-100)", (v) => Number(v), 60)
    .option("--out <dir>", "output directory", "./assets/img")
    .option("--model <model>", "Claude model for naming/alt text", "claude-sonnet-5")
    .option("--position <pos>", "default crop position: attention|top|centre|entropy (rows may override)", "attention")
    .option("--dry-run", "print planned output without writing files", false)
    .action(async (dir, opts) => {
      await runBatch(dir, opts);
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(`✗ ${message}`);
  if (process.env.DEBUG === "1" && err && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
