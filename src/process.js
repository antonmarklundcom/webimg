// src/process.js — sharp-based resize/encode pipeline producing AVIF + WebP sets (+ og:image JPG).
//
// Hygiene applied to every output: EXIF/GPS/IPTC from the input are never copied
// (sharp strips metadata unless asked to keep it), pixels are converted to sRGB
// using the input's embedded ICC profile, EXIF orientation is applied, and alpha
// is kept for WebP/AVIF. Optional --copyright/--creator are written as EXIF
// (Copyright/Artist) and XMP (dc:rights/dc:creator) on every output file.

import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

import { encodeWithinBudget } from "./budget.js";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_QUALITY = 82;

function resolvePosition(position) {
  if (position === "attention") return sharp.strategy.attention;
  if (position === "entropy") return sharp.strategy.entropy;
  if (position === "center") return "centre";
  return position; // top | centre | bottom | left | right (as-is)
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Builds the XMP packet for copyright/creator. Returns null when neither is set. */
export function buildXmp({ copyright, creator }) {
  if (!copyright && !creator) return null;
  const rights = copyright
    ? `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(copyright)}</rdf:li></rdf:Alt></dc:rights>`
    : "";
  const creatorXml = creator
    ? `<dc:creator><rdf:Seq><rdf:li>${escapeXml(creator)}</rdf:li></rdf:Seq></dc:creator>`
    : "";
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">${rights}${creatorXml}</rdf:Description>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

/**
 * Applies output metadata policy to a sharp pipeline: no input EXIF/IPTC/XMP,
 * sRGB ICC profile, optional copyright/creator written fresh.
 */
function applyMetadata(pipeline, { copyright, creator }) {
  let p = pipeline.toColourspace("srgb").withIccProfile("srgb");
  if (copyright || creator) {
    const ifd0 = {};
    if (copyright) ifd0.Copyright = String(copyright);
    if (creator) ifd0.Artist = String(creator);
    // withExif() replaces the input EXIF entirely, so GPS and camera tags never leak through.
    p = p.withExif({ IFD0: ifd0 });
    const xmp = buildXmp({ copyright, creator });
    if (xmp) p = p.withXmp(xmp);
  }
  return p;
}

/**
 * Reads the input once and returns what the pipeline needs to know about it.
 * Throws a readable error for formats this sharp build cannot decode (e.g. HEIC without a HEVC decoder).
 */
export async function inspectSource(input) {
  let metadata;
  try {
    metadata = await sharp(input).rotate().metadata();
  } catch (err) {
    const ext = path.extname(String(input)).toLowerCase();
    const reason = err && err.message ? err.message : String(err);
    if (ext === ".heic" || ext === ".heif") {
      throw new Error(`cannot decode ${path.basename(input)}: this sharp build has no HEVC decoder for HEIC (${reason}). Export it as JPG/PNG first.`);
    }
    throw new Error(`cannot read ${path.basename(input)}: ${reason}`);
  }
  // EXIF orientations 5-8 mean the pixel data is rotated 90°, so width/height swap after .rotate().
  const swapped = (metadata.orientation || 1) >= 5;
  return {
    width: swapped ? metadata.height : metadata.width,
    height: swapped ? metadata.width : metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
    format: metadata.format,
    space: metadata.space,
    hasProfile: Boolean(metadata.icc),
    hasExif: Boolean(metadata.exif),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.input
 * @param {string} opts.filenameBase
 * @param {number[]} opts.widths
 * @param {[number, number] | null} opts.ar
 * @param {number} opts.qualityAvif
 * @param {number} opts.qualityWebp
 * @param {string} opts.outDir
 * @param {string} opts.position
 * @param {boolean} opts.dryRun
 * @param {boolean} [opts.og] - also write <filenameBase>-og.jpg (1200×630, mozjpeg, attention crop)
 * @param {string} [opts.ogBackground] - background colour used to flatten alpha for the og JPG
 * @param {{forWidth:(w:number)=>number|null, og:number|null}|null} [opts.budget] - size budgets (null = off)
 * @param {string} [opts.copyright]
 * @param {string} [opts.creator]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<Array<{file: string, path: string, format: string, width: number, height: number, bytes: number, quality: number, budget_kb: number|null, over_budget: boolean}>>}
 */
export async function processImage({
  input,
  filenameBase,
  widths,
  ar,
  qualityAvif,
  qualityWebp,
  outDir,
  position,
  dryRun,
  og = false,
  ogBackground = "#ffffff",
  budget = null,
  copyright,
  creator,
  log = console.log,
}) {
  const src = await inspectSource(input);
  const srcWidth = src.width;
  const srcHeight = src.height;
  const [arW, arH] = ar ? ar : [srcWidth, srcHeight];
  const meta = { copyright, creator };

  const results = [];

  if (!dryRun) {
    await fs.mkdir(outDir, { recursive: true });
  }

  const pos = resolvePosition(position);

  const record = (file, format, info, extra) => {
    const entry = {
      file,
      path: path.join(outDir, file),
      format,
      width: info.width,
      height: info.height,
      bytes: info.size,
      quality: extra.quality,
      budget_kb: extra.budgetKb ?? null,
      over_budget: Boolean(extra.overBudget),
    };
    results.push(entry);
    const budgetNote = entry.budget_kb ? `  (budget ${entry.budget_kb} KB, q${entry.quality})` : `  (q${entry.quality})`;
    const flag = entry.over_budget ? "⚠" : "✓";
    log(`${flag} ${file}  ${info.width}×${info.height}  ${(info.size / 1024).toFixed(1)} KB${budgetNote}${entry.over_budget ? "  OVER BUDGET at quality floor" : ""}`);
    return entry;
  };

  for (const width of widths) {
    // Never upscale: a variant wider than the source is written at the source width.
    // The file keeps its requested label (-1280) so templates can rely on stable names.
    const outWidth = Math.min(width, srcWidth);
    const height = Math.round((outWidth * arH) / arW);
    const budgetKb = budget ? budget.forWidth(outWidth) : null;

    if (width > srcWidth) {
      log(`ℹ ${width} variant capped at source width ${srcWidth}px (no upscaling)`);
    }

    if (dryRun) {
      for (const format of ["avif", "webp"]) {
        results.push({
          file: `${filenameBase}-${width}.${format}`,
          path: path.join(outDir, `${filenameBase}-${width}.${format}`),
          format,
          width: outWidth,
          height,
          bytes: 0,
          quality: format === "avif" ? qualityAvif : qualityWebp,
          budget_kb: budgetKb,
          over_budget: false,
        });
      }
      continue;
    }

    const base = applyMetadata(
      sharp(input).rotate().resize({ width: outWidth, height, fit: "cover", position: pos, withoutEnlargement: false }),
      meta
    );

    const avifFile = `${filenameBase}-${width}.avif`;
    const avifPath = path.join(outDir, avifFile);
    const avif = await encodeWithinBudget({
      format: "avif",
      startQuality: qualityAvif,
      budgetKb,
      encode: (q) => base.clone().avif({ quality: q, effort: 4 }).toFile(avifPath),
    });
    record(avifFile, "avif", avif.info, { quality: avif.quality, budgetKb, overBudget: avif.overBudget });

    const webpFile = `${filenameBase}-${width}.webp`;
    const webpPath = path.join(outDir, webpFile);
    const webp = await encodeWithinBudget({
      format: "webp",
      startQuality: qualityWebp,
      budgetKb,
      encode: (q) => base.clone().webp({ quality: q, effort: 4 }).toFile(webpPath),
    });
    record(webpFile, "webp", webp.info, { quality: webp.quality, budgetKb, overBudget: webp.overBudget });
  }

  if (og) {
    const ogFile = `${filenameBase}-og.jpg`;
    const ogPath = path.join(outDir, ogFile);
    const ogBudget = budget ? budget.og : null;
    if (dryRun) {
      results.push({
        file: ogFile,
        path: ogPath,
        format: "jpg",
        width: OG_WIDTH,
        height: OG_HEIGHT,
        bytes: 0,
        quality: OG_QUALITY,
        budget_kb: ogBudget,
        over_budget: false,
      });
    } else {
      if (srcWidth < OG_WIDTH || srcHeight < OG_HEIGHT) {
        log(`ℹ og:image is upscaled from ${srcWidth}×${srcHeight} (1200×630 is required by the sharing platforms)`);
      }
      if (src.hasAlpha) {
        log(`ℹ og:image: alpha flattened onto ${ogBackground} (JPG has no transparency)`);
      }
      let ogPipeline = sharp(input)
        .rotate()
        .resize({ width: OG_WIDTH, height: OG_HEIGHT, fit: "cover", position: pos, withoutEnlargement: false });
      if (src.hasAlpha) ogPipeline = ogPipeline.flatten({ background: ogBackground });
      ogPipeline = applyMetadata(ogPipeline, meta);
      const jpg = await encodeWithinBudget({
        format: "jpg",
        startQuality: OG_QUALITY,
        budgetKb: ogBudget,
        encode: (q) => ogPipeline.clone().jpeg({ quality: q, mozjpeg: true, progressive: true }).toFile(ogPath),
      });
      record(ogFile, "jpg", jpg.info, { quality: jpg.quality, budgetKb: ogBudget, overBudget: jpg.overBudget });
    }
  }

  return results;
}
