#!/usr/bin/env node
// webimg — convert images into SEO-named AVIF + WebP (+ og:image) sets, with budgets, upload and audit.

import { Command } from "commander";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeManifest } from "./src/manifest.js";
import { loadBatchManifest } from "./src/batch.js";
import { isUrl, parseWidths, parseAr, convertImage, VALID_EXTENSIONS_LABEL } from "./src/convert.js";
import { parseMaxKb, DEFAULT_BUDGET_POINTS, DEFAULT_OG_BUDGET_KB } from "./src/budget.js";
import { DEFAULT_MODEL } from "./src/naming.js";
import { startServer, openInBrowser } from "./src/server.js";
import { zipDirectory } from "./src/zip.js";
import { planUpload, uploadToDir, uploadToR2, uploadToSftp, formatKb } from "./src/upload.js";
import { audit, summarize } from "./src/audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fssync.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const DEFAULT_BUDGET_LABEL = DEFAULT_BUDGET_POINTS.map(([w, kb]) => `${w}:${kb}`).join(",") + `,og:${DEFAULT_OG_BUDGET_KB}`;

function printDryRun(entries, naming) {
  console.log(`ℹ dry run — would write ${entries.length} files for "${naming.filename_base}":`);
  for (const e of entries) {
    const budget = e.budget_kb ? `  budget ≤ ${e.budget_kb} KB` : "";
    console.log(`  ${e.file}  ${e.width}×${e.height}  q${e.quality}${budget}`);
  }
  console.log(`ℹ alt text: ${naming.alt_text}`);
}

function printBudgetMisses(entries) {
  const misses = entries.filter((e) => e.over_budget);
  if (misses.length === 0) return;
  console.log(`⚠ ${misses.length} file(s) still over budget at the quality floor:`);
  for (const e of misses) console.log(`  ${e.file}  ${formatKb(e.bytes)} > ${e.budget_kb} KB (q${e.quality})`);
}

function sharedConvertOptions(opts) {
  return {
    widths: opts.widths,
    qualityAvif: opts.qualityAvif,
    qualityWebp: opts.qualityWebp,
    outDir: opts.out,
    publicPath: opts.publicPath,
    sizes: opts.sizes,
    model: opts.model,
    position: opts.position,
    dryRun: opts.dryRun,
    og: opts.og,
    ogBackground: opts.ogBackground,
    maxKb: parseMaxKb(opts.maxKb),
    copyright: opts.copyright,
    creator: opts.creator,
    force: opts.force,
  };
}

async function runConvert(input, opts) {
  if (!opts.prompt && !(opts.name && opts.alt)) {
    throw new Error("give --prompt, or both --name and --alt");
  }
  const { entry, entries, naming, skipped } = await convertImage({
    input,
    prompt: opts.prompt,
    name: opts.name,
    alt: opts.alt,
    ar: opts.ar,
    eager: opts.eager,
    ...sharedConvertOptions(opts),
  });

  if (opts.dryRun) {
    printDryRun(entries, naming);
    return;
  }

  if (!skipped) printBudgetMisses(entries);
  console.log(`\nAlt text: ${naming.alt_text}\n`);
  console.log(entry.html_snippet);
  if (entry.og_snippet) console.log(`\n${entry.og_snippet}`);
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
  parseWidths(opts.widths);
  if (opts.ar) parseAr(opts.ar);
  const shared = sharedConvertOptions(opts);

  let converted = 0;
  let skipped = 0;
  let unchanged = 0;
  let failed = 0;
  const manifestEntries = [];
  const allEntries = [];

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

    try {
      const result = await convertImage({
        input: inputPath,
        prompt: row.prompt,
        name: row.name,
        alt: row.alt,
        ar: row.ar || opts.ar,
        ...shared,
        position: row.position || opts.position,
        writeManifestFile: false,
      });

      if (opts.dryRun) {
        printDryRun(result.entries, result.naming);
        converted++;
        continue;
      }

      manifestEntries.push(result.entry);
      allEntries.push(...result.entries);
      if (result.skipped) unchanged++;
      else converted++;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      console.error(`✗ ${row.file} failed: ${reason}`);
      failed++;
    }
  }

  if (!opts.dryRun && manifestEntries.length > 0) {
    await writeManifest(opts.out, manifestEntries);
    printBudgetMisses(allEntries);
  }

  console.log(`Done: ${converted} converted, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function runUpload(dir, opts) {
  const names = opts.name ? String(opts.name).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const files = await planUpload(dir, { names, includeManifest: opts.includeManifest });
  if (files.length === 0) throw new Error(`nothing to upload in ${dir}`);
  const totalKb = files.reduce((n, f) => n + f.bytes, 0) / 1024;
  console.log(`ℹ ${files.length} files, ${totalKb.toFixed(1)} KB, target: ${opts.to}${opts.dryRun ? " (dry run)" : ""}`);

  let result;
  if (opts.to === "dir") {
    result = await uploadToDir(files, { dest: opts.dest, prefix: opts.prefix || "", dryRun: opts.dryRun });
    console.log(`Done: ${result.copied} ${opts.dryRun ? "to copy" : "copied"}, ${result.skipped} unchanged → ${result.dest}`);
    if (!opts.dryRun && result.copied > 0) console.log(`ℹ git-deployed site: commit and push ${path.relative(process.cwd(), result.dest) || result.dest} to deploy`);
  } else if (opts.to === "r2") {
    result = await uploadToR2(files, { bucket: opts.bucket, prefix: opts.prefix || "", endpoint: opts.endpoint, dryRun: opts.dryRun, force: opts.force });
    if (!opts.dryRun) console.log(`Done: ${result.uploaded} uploaded, ${result.skipped} unchanged → r2://${result.bucket}/${opts.prefix || ""}`);
  } else if (opts.to === "sftp") {
    result = await uploadToSftp(files, { remoteDir: opts.remoteDir, dryRun: opts.dryRun });
    if (!opts.dryRun) console.log(`Done: ${result.uploaded} uploaded → ${opts.remoteDir}`);
  } else {
    throw new Error(`unknown --to "${opts.to}" (use r2, dir or sftp)`);
  }
}

async function runAudit(target, opts) {
  const { findings, counts } = await audit(target, { maxKb: opts.maxKb });
  if (opts.json) {
    console.log(JSON.stringify({ target, counts, findings, summary: summarize(findings) }, null, 2));
  } else {
    const order = ["broken", "oversized", "missing-pair", "no-modern-format", "missing-og", "missing-alt", "empty-alt", "missing-dimensions", "non-seo-name"];
    const sorted = [...findings].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const f of sorted) console.log(`${f.type.padEnd(19)} ${f.where}  ${f.message}`);
    const summary = summarize(findings);
    const parts = Object.entries(summary).map(([k, v]) => `${v} ${k}`);
    const scanned = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(`\n${findings.length === 0 ? "✓ no problems" : `${findings.length} problems: ${parts.join(", ")}`} (scanned ${scanned})`);
  }
  if (opts.strict && findings.length > 0) process.exitCode = 1;
}

function addConvertOptions(cmd) {
  return cmd
    .option("--ar <ratio>", "target aspect ratio, e.g. 21:9 (default: source aspect ratio)")
    .option("--widths <list>", "comma-separated output widths", "640,1280,1920")
    .option("--quality-avif <n>", "starting AVIF quality (0-100)", (v) => Number(v), 44)
    .option("--quality-webp <n>", "starting WebP quality (0-100)", (v) => Number(v), 60)
    .option("--max-kb <spec>", `size budget per width in KB; quality steps down to meet it. "120", "640:60,1280:120,og:200", or "off" (default: ${DEFAULT_BUDGET_LABEL})`)
    .option("--og", "also write <name>-og.jpg, 1200×630 mozjpeg with an attention crop, for og:image", false)
    .option("--og-background <color>", "background used to flatten transparent images for the og JPG", "#ffffff")
    .option("--copyright <text>", "write a copyright notice into EXIF/XMP of every output file")
    .option("--creator <text>", "write the creator/author into EXIF/XMP of every output file")
    .option("--force", "re-encode even when the source and options are unchanged since the last run", false)
    .option("--out <dir>", "output directory", "./assets/img")
    .option("--public-path <path>", "web path used in the HTML snippet, e.g. /assets/img (default: --out relative to cwd)")
    .option("--sizes <value>", "sizes attribute for the snippet, e.g. \"(min-width: 1024px) 620px, 100vw\"")
    .option("--model <model>", "Claude model for naming/alt text (only with ANTHROPIC_API_KEY)", DEFAULT_MODEL)
    .option("--position <pos>", "crop position: attention|top|centre|entropy", "attention")
    .option("--dry-run", "print planned names, dimensions and budgets without writing files", false);
}

async function main() {
  const program = new Command();

  program
    .name("webimg")
    .description("Convert images into SEO-named AVIF + WebP (+ og:image) sets for websites, within size budgets, then upload or audit them.")
    .version(pkg.version);

  addConvertOptions(
    program
      .command("convert")
      .description("Convert a single image into an SEO-named AVIF + WebP set (optionally + og:image)")
      .argument("<input>", `path to an image (${VALID_EXTENSIONS_LABEL}) or an http(s) URL to one`)
      .option("--prompt <text>", "short description used for naming/alt text (optional when --name and --alt are given)")
      .option("--name <slug>", "use this SEO slug as the file name (validated)")
      .option("--alt <text>", "alt text for the snippet and manifest")
      .option("--eager", "hero/LCP image: fetchpriority=high instead of lazy loading in the snippet", false)
  ).action(async (input, opts) => {
    await runConvert(input, opts);
  });

  addConvertOptions(
    program
      .command("batch")
      .description("Convert a batch of images described by a CSV or JSON manifest")
      .argument("<dir>", "directory containing the source images")
      .requiredOption("--manifest <file>", "path to a .csv or .json batch manifest")
  ).action(async (dir, opts) => {
    await runBatch(dir, opts);
  });

  program
    .command("upload")
    .description("Upload a converted folder: Cloudflare R2 (S3 API), a git-deployed site folder, or SFTP")
    .argument("[dir]", "folder with converted images (and manifest.json)", "./assets/img")
    .requiredOption("--to <target>", "r2 | dir | sftp")
    .option("--bucket <name>", "R2 bucket (or env R2_BUCKET)")
    .option("--prefix <path>", "key/path prefix inside the target, e.g. img or sites/dentista/img", "")
    .option("--endpoint <url>", "R2 S3 endpoint override (default: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com)")
    .option("--dest <folder>", "dir target: the site repo's image folder, e.g. ../dentista/assets/img")
    .option("--remote-dir <path>", "sftp target: absolute remote folder, e.g. /home/u1/domains/x/public_html/assets/img")
    .option("--name <bases>", "comma-separated filename_base values to upload (default: everything)")
    .option("--include-manifest", "also upload manifest.json", false)
    .option("--force", "upload even when the object already matches", false)
    .option("--dry-run", "print the plan (files, keys, headers) without connecting", false)
    .addHelpText("after", `
Credentials come only from environment variables; webimg never prints or stores them.
  R2:   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (optional R2_ENDPOINT)
  SFTP: SFTP_HOST, SFTP_USER, SFTP_PASSWORD or SFTP_KEY_PATH (optional SFTP_PORT, SFTP_KEY_PASSPHRASE)
Images are sent with Cache-Control: ${"public, max-age=31536000, immutable"} and the right Content-Type.`)
    .action(async (dir, opts) => {
      await runUpload(dir, opts);
    });

  program
    .command("audit")
    .description("List image problems in a folder or on a live page: oversized files, missing AVIF/WebP pairs, missing -og.jpg, <img> without alt/width/height, non-SEO names")
    .argument("<target>", "a folder (images and HTML/PHP templates are scanned) or an http(s) page URL")
    .option("--max-kb <spec>", "size budget per width, same syntax as convert (default: webimg defaults)")
    .option("--json", "machine-readable output", false)
    .option("--strict", "exit 1 when any problem is found", false)
    .action(async (target, opts) => {
      await runAudit(target, opts);
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
    .option("--model <model>", "Claude model for naming/alt text", DEFAULT_MODEL)
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
