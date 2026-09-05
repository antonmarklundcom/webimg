#!/usr/bin/env node
// webimg — convert PNG/JPG into SEO-named AVIF + WebP sets, with LLM naming/alt text.

import { Command } from "commander";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { processImage } from "./src/process.js";
import { writeManifest } from "./src/manifest.js";
import { loadBatchManifest } from "./src/batch.js";
import { fetchToTemp } from "./src/fetch.js";
import {
  VALID_EXTENSIONS,
  isUrl,
  parseWidths,
  parseAr,
  formatAr,
  normalizeOutPrefix,
  buildHtmlSnippet,
  buildFilesForManifest,
  resolveNaming,
  convertImage,
} from "./src/convert.js";
import { startServer, openInBrowser } from "./src/server.js";
import { zipDirectory } from "./src/zip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fssync.readFileSync(path.join(__dirname, "package.json"), "utf8"));

async function runConvert(input, opts) {
  const { entry, entries, naming } = await convertImage({
    input,
    prompt: opts.prompt,
    name: opts.name,
    alt: opts.alt,
    ar: opts.ar,
    widths: opts.widths,
    qualityAvif: opts.qualityAvif,
    qualityWebp: opts.qualityWebp,
    outDir: opts.out,
    model: opts.model,
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

  console.log(`\nAlt text: ${naming.alt_text}\n`);
  console.log(entry.html_snippet);
}

async function runServe(opts) {
  const { url, outDir } = await startServer({
    outDir: opts.out,
    port: Number(opts.port),
    host: opts.host,
    widths: opts.widths,
    qualityAvif: opts.qualityAvif,
    qualityWebp: opts.qualityWebp,
    model: opts.model,
    position: opts.position,
  });
  console.log(`webimg is running at ${url}`);
  console.log(`Converted files are written to ${outDir}`);
  console.log(`Drop images in the browser, then download them one by one or as a zip. Ctrl+C to stop.`);
  if (opts.open) openInBrowser(url);
  await new Promise(() => {});
}

async function runZip(dir, opts) {
  const only = opts.name
    ? await (async () => {
        const bases = String(opts.name).split(",").map((s) => s.trim()).filter(Boolean);
        let manifest = { images: [] };
        try {
          manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
        } catch {
          throw new Error(`--name needs ${path.join(dir, "manifest.json")} to look up the image sets`);
        }
        const set = new Set();
        for (const base of bases) {
          const entry = (manifest.images || []).find((e) => e.filename_base === base);
          if (!entry) throw new Error(`no image set named "${base}" in ${dir}`);
          for (const f of entry.files || []) set.add(f.file);
        }
        return set;
      })()
    : null;

  const { buffer, count, names } = await zipDirectory(dir, { only });
  if (count === 0) throw new Error(`nothing to zip in ${dir}`);
  const outFile = opts.out || `${path.basename(path.resolve(dir))}.zip`;
  await fs.writeFile(outFile, buffer);
  for (const n of names) console.log(`  + ${n}`);
  console.log(`✓ ${outFile}  ${count} files  ${(buffer.length / 1024).toFixed(1)} KB`);
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

  program
    .command("serve")
    .description("Start a local drag-and-drop web UI: upload images, convert, download one by one or as a zip")
    .option("--out <dir>", "output directory", "./assets/img")
    .option("--port <n>", "port to listen on (0 = random)", "8787")
    .option("--host <host>", "address to bind (keep it local)", "127.0.0.1")
    .option("--open", "open the UI in your browser", false)
    .option("--widths <list>", "default comma-separated output widths", "640,1280,1920")
    .option("--quality-avif <n>", "AVIF quality (0-100)", (v) => Number(v), 44)
    .option("--quality-webp <n>", "WebP quality (0-100)", (v) => Number(v), 60)
    .option("--model <model>", "Claude model for naming/alt text", "claude-sonnet-5")
    .option("--position <pos>", "default crop position: attention|top|centre|entropy", "attention")
    .action(async (opts) => {
      await runServe(opts);
    });

  program
    .command("zip")
    .description("Zip an output directory (or selected image sets) for hand-off to a project, Claude, or GitHub")
    .argument("[dir]", "directory with converted images", "./assets/img")
    .option("--out <file>", "zip file to write (default: <dir name>.zip)")
    .option("--name <bases>", "comma-separated filename_base values to include (default: everything)")
    .action(async (dir, opts) => {
      await runZip(dir, opts);
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
