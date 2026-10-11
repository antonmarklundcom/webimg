// src/convert.js — shared single-image conversion core used by the CLI and the local server.

import path from "node:path";
import fssync from "node:fs";

import { generateNaming, validateSlug, DEFAULT_MODEL } from "./naming.js";
import { processImage } from "./process.js";
import { writeManifest, findManifestEntry } from "./manifest.js";
import { fetchToTemp } from "./fetch.js";
import { parseMaxKb } from "./budget.js";
import { hashFile, hashOptions } from "./hash.js";

export const VALID_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp",
  ".avif", ".heic", ".heif", ".tif", ".tiff", ".gif",
]);
export const VALID_EXTENSIONS_LABEL = ".png, .jpg, .jpeg, .webp, .avif, .heic, .tif/.tiff or .gif";
const URL_RE = /^https?:\/\//i;

export function isUrl(str) {
  return URL_RE.test(String(str || ""));
}

export function parseWidths(str) {
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

export function parseAr(str) {
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

export function formatAr(ar) {
  if (!ar) return "source";
  return `${ar[0]}:${ar[1]}`;
}

export function normalizeOutPrefix(outDir, publicPath) {
  if (publicPath) return publicPath.replace(/\\/g, "/").replace(/\/+$/, "");
  let p = outDir;
  if (path.isAbsolute(p) && !p.startsWith("/")) {
    // Windows absolute path: use it relative to cwd when possible so the snippet works on a site.
    const rel = path.relative(process.cwd(), p);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) p = rel;
  }
  p = p.replace(/\\/g, "/");
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

export function buildHtmlSnippet({ outPrefix, filenameBase, widths, altText, entries, sizes, eager = false }) {
  const sortedWidths = [...widths].sort((a, b) => a - b);
  // Describe each file by its real pixel width (a capped variant is narrower than its label).
  const realW = (w, fmt) => (entries.find((e) => e.file === `${filenameBase}-${w}.${fmt}`) || {}).width || w;
  const avifSrcset = sortedWidths
    .map((w) => `${outPrefix}/${filenameBase}-${w}.avif ${realW(w, "avif")}w`)
    .join(", ");
  const webpSrcset = sortedWidths
    .map((w) => `${outPrefix}/${filenameBase}-${w}.webp ${realW(w, "webp")}w`)
    .join(", ");

  const midWidth = pickMidWidth(sortedWidths);
  // Match by file name: a capped variant's real width differs from its label.
  const midEntry = entries.find((e) => e.file === `${filenameBase}-${midWidth}.webp`) ||
    entries.find((e) => e.format === "webp");
  const imgSrc = `${outPrefix}/${filenameBase}-${midWidth}.webp`;
  const imgWidth = midEntry ? midEntry.width : midWidth;
  const imgHeight = midEntry ? midEntry.height : Math.round(midWidth);

  const sizesAttr = sizes ? ` sizes="${escapeAttr(sizes)}"` : "";
  // eager = the page's LCP image (hero): load it first instead of lazily.
  const loadAttrs = eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"';

  return [
    "<picture>",
    `  <source type="image/avif" srcset="${avifSrcset}"${sizesAttr}>`,
    `  <source type="image/webp" srcset="${webpSrcset}"${sizesAttr}>`,
    `  <img src="${imgSrc}" alt="${escapeAttr(altText)}" width="${imgWidth}" height="${imgHeight}"${sizesAttr} ${loadAttrs}>`,
    "</picture>",
  ].join("\n");
}

/** The og:image meta tag for a set converted with --og (null when there is no og file). */
export function buildOgSnippet({ outPrefix, filenameBase, entries }) {
  const ogEntry = entries.find((e) => e.file === `${filenameBase}-og.jpg`);
  if (!ogEntry) return null;
  return `<meta property="og:image" content="${outPrefix}/${filenameBase}-og.jpg">\n<meta property="og:image:width" content="${ogEntry.width}">\n<meta property="og:image:height" content="${ogEntry.height}">`;
}

export function buildFilesForManifest(entries) {
  return entries.map((e) => ({
    file: e.file,
    format: e.format,
    width: e.width,
    height: e.height,
    bytes: e.bytes,
    kb: Math.round((e.bytes / 1024) * 10) / 10,
    quality: e.quality,
    ...(e.budget_kb ? { budget_kb: e.budget_kb } : {}),
    ...(e.over_budget ? { over_budget: true } : {}),
  }));
}

/**
 * Resolves filename_base + alt_text, honoring --name/--alt overrides.
 * Never throws for API failures (generateNaming already falls back);
 * throws only if an explicit --name slug fails validation.
 */
export async function resolveNaming({ nameOpt, altOpt, prompt, apiKey, model, inputBasename }) {
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

/**
 * Converts one image (local path or URL) into an AVIF + WebP set (+ og:image) and returns
 * the manifest entry. Writes/merges <outDir>/manifest.json unless dryRun or
 * writeManifestFile === false.
 *
 * Idempotent: when the manifest already has an entry for the same filename_base with the
 * same source hash and the same output options, and every listed file exists, nothing is
 * re-encoded (`skipped: true`). Pass `force: true` to re-encode anyway.
 *
 * @returns {Promise<{ entry: object, entries: Array<object>, naming: object, skipped: boolean }>}
 */
export async function convertImage({
  input,
  prompt,
  name,
  alt,
  ar,
  widths = "640,1280,1920",
  qualityAvif = 44,
  qualityWebp = 60,
  outDir = "./assets/img",
  publicPath,
  sizes,
  eager = false,
  model = DEFAULT_MODEL,
  position = "attention",
  dryRun = false,
  writeManifestFile = true,
  sourceLabel,
  og = false,
  ogBackground = "#ffffff",
  maxKb,
  copyright,
  creator,
  force = false,
  log = console.log,
}) {
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
      throw new Error(`unsupported input type "${ext}" — expected ${VALID_EXTENSIONS_LABEL}`);
    }

    const widthList = Array.isArray(widths) ? widths : parseWidths(widths);
    const arPair = Array.isArray(ar) ? ar : parseAr(ar);
    const budget = typeof maxKb === "object" && maxKb !== null && "forWidth" in maxKb ? maxKb : parseMaxKb(maxKb);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const inputBasename = inputIsUrl
      ? undefined
      : path.basename(sourceLabel || resolvedInput, path.extname(sourceLabel || resolvedInput));

    const naming = await resolveNaming({
      nameOpt: name,
      altOpt: alt,
      prompt,
      apiKey,
      model,
      inputBasename,
    });

    const sourceHash = await hashFile(resolvedInput);
    const optionsHash = hashOptions({
      widths: widthList,
      ar: arPair,
      qualityAvif,
      qualityWebp,
      position,
      og: Boolean(og),
      ogBackground: og ? ogBackground : null,
      budget: budget ? budget.label : "off",
      copyright: copyright || null,
      creator: creator || null,
    });

    const outPrefix = normalizeOutPrefix(outDir, publicPath);

    let source;
    if (sourceLabel) source = sourceLabel;
    else if (inputIsUrl) source = input;
    else source = path.relative(process.cwd(), input).replace(/\\/g, "/");

    // Idempotent skip: same source bytes, same output options, all files present.
    if (!force && !dryRun) {
      const previous = await findManifestEntry(outDir, naming.filename_base);
      if (
        previous &&
        previous.source_hash === sourceHash &&
        previous.options_hash === optionsHash &&
        Array.isArray(previous.files) &&
        previous.files.length > 0 &&
        previous.files.every((f) => fssync.existsSync(path.join(outDir, f.file)))
      ) {
        const entries = previous.files.map((f) => ({
          file: f.file,
          path: path.join(outDir, f.file),
          format: f.format,
          width: f.width,
          height: f.height,
          bytes: f.bytes ?? Math.round((f.kb || 0) * 1024),
          quality: f.quality,
          budget_kb: f.budget_kb ?? null,
          over_budget: Boolean(f.over_budget),
        }));
        const htmlSnippet = buildHtmlSnippet({
          outPrefix,
          filenameBase: naming.filename_base,
          widths: widthList,
          altText: naming.alt_text,
          entries,
          sizes,
          eager,
        });
        const entry = {
          ...previous,
          source,
          prompt: prompt || previous.prompt || "",
          alt_text: naming.alt_text,
          naming_source: naming.source,
          html_snippet: htmlSnippet,
          og_snippet: buildOgSnippet({ outPrefix, filenameBase: naming.filename_base, entries }),
        };
        log(`↷ ${naming.filename_base}: unchanged source and options, ${entries.length} files already present — skipped (use --force to re-encode)`);
        if (writeManifestFile) await writeManifest(outDir, [entry]);
        return { entry, entries, naming, skipped: true };
      }
    }

    const entries = await processImage({
      input: resolvedInput,
      filenameBase: naming.filename_base,
      widths: widthList,
      ar: arPair,
      qualityAvif,
      qualityWebp,
      outDir,
      position,
      dryRun,
      og,
      ogBackground,
      budget,
      copyright,
      creator,
      log,
    });

    const htmlSnippet = buildHtmlSnippet({
      outPrefix,
      filenameBase: naming.filename_base,
      widths: widthList,
      altText: naming.alt_text,
      entries,
      sizes,
      eager,
    });

    const entry = {
      filename_base: naming.filename_base,
      source,
      source_hash: sourceHash,
      options_hash: optionsHash,
      prompt: prompt || "",
      alt_text: naming.alt_text,
      naming_source: naming.source,
      aspect_ratio: formatAr(arPair),
      converted_at: new Date().toISOString(),
      files: buildFilesForManifest(entries),
      html_snippet: htmlSnippet,
      og_snippet: buildOgSnippet({ outPrefix, filenameBase: naming.filename_base, entries }),
    };
    if (!entry.og_snippet) delete entry.og_snippet;

    if (!dryRun && writeManifestFile) {
      await writeManifest(outDir, [entry]);
    }

    return { entry, entries, naming, skipped: false };
  } finally {
    if (cleanup) await cleanup();
  }
}
