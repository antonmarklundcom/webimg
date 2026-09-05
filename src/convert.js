// src/convert.js — shared single-image conversion core used by the CLI and the local server.

import path from "node:path";

import { generateNaming, validateSlug } from "./naming.js";
import { processImage } from "./process.js";
import { writeManifest } from "./manifest.js";
import { fetchToTemp } from "./fetch.js";

export const VALID_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
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

export function normalizeOutPrefix(outDir) {
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

export function buildHtmlSnippet({ outPrefix, filenameBase, widths, altText, entries }) {
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

export function buildFilesForManifest(entries) {
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
 * Converts one image (local path or URL) into an AVIF + WebP set and returns
 * the manifest entry. Writes/merges <outDir>/manifest.json unless dryRun or
 * writeManifestFile === false.
 *
 * @returns {Promise<{ entry: object, entries: Array<object>, naming: object }>}
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
  model = "claude-sonnet-5",
  position = "attention",
  dryRun = false,
  writeManifestFile = true,
  sourceLabel,
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
      throw new Error(`unsupported input type "${ext}" — expected .png, .jpg, .jpeg, or .webp`);
    }

    const widthList = Array.isArray(widths) ? widths : parseWidths(widths);
    const arPair = Array.isArray(ar) ? ar : parseAr(ar);
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
    });

    const outPrefix = normalizeOutPrefix(outDir);
    const htmlSnippet = buildHtmlSnippet({
      outPrefix,
      filenameBase: naming.filename_base,
      widths: widthList,
      altText: naming.alt_text,
      entries,
    });

    let source;
    if (sourceLabel) source = sourceLabel;
    else if (inputIsUrl) source = input;
    else source = path.relative(process.cwd(), input).replace(/\\/g, "/");

    const entry = {
      filename_base: naming.filename_base,
      source,
      prompt: prompt || "",
      alt_text: naming.alt_text,
      naming_source: naming.source,
      aspect_ratio: formatAr(arPair),
      files: buildFilesForManifest(entries),
      html_snippet: htmlSnippet,
    };

    if (!dryRun && writeManifestFile) {
      await writeManifest(outDir, [entry]);
    }

    return { entry, entries, naming };
  } finally {
    if (cleanup) await cleanup();
  }
}
