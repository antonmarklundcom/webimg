// src/process.js — sharp-based resize/encode pipeline producing AVIF + WebP sets.

import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

function resolvePosition(position) {
  if (position === "attention") return sharp.strategy.attention;
  if (position === "entropy") return sharp.strategy.entropy;
  if (position === "center") return "centre";
  return position; // top | centre | bottom | left | right (as-is)
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
 * @returns {Promise<Array<{file: string, path: string, format: string, width: number, height: number, bytes: number}>>}
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
}) {
  const src = sharp(input);
  const metadata = await src.rotate().metadata();
  // EXIF orientations 5-8 mean the pixel data is rotated 90°, so width/height swap after .rotate().
  const swapped = (metadata.orientation || 1) >= 5;
  const srcWidth = swapped ? metadata.height : metadata.width;
  const srcHeight = swapped ? metadata.width : metadata.height;

  const [arW, arH] = ar ? ar : [srcWidth, srcHeight];

  const results = [];

  if (!dryRun) {
    await fs.mkdir(outDir, { recursive: true });
  }

  const pos = resolvePosition(position);

  for (const width of widths) {
    const height = Math.round((width * arH) / arW);

    if (width > srcWidth) {
      console.log(`⚠ upscaling ${width} from source ${srcWidth}px`);
    }

    if (dryRun) {
      results.push({
        file: `${filenameBase}-${width}.avif`,
        path: path.join(outDir, `${filenameBase}-${width}.avif`),
        format: "avif",
        width,
        height,
        bytes: 0,
      });
      results.push({
        file: `${filenameBase}-${width}.webp`,
        path: path.join(outDir, `${filenameBase}-${width}.webp`),
        format: "webp",
        width,
        height,
        bytes: 0,
      });
      continue;
    }

    const base = sharp(input)
      .rotate()
      .resize({ width, height, fit: "cover", position: pos, withoutEnlargement: false });

    const avifPath = path.join(outDir, `${filenameBase}-${width}.avif`);
    const webpPath = path.join(outDir, `${filenameBase}-${width}.webp`);

    const avifInfo = await base
      .clone()
      .avif({ quality: qualityAvif, effort: 4 })
      .toFile(avifPath);
    console.log(
      `✓ ${filenameBase}-${width}.avif  ${avifInfo.width}×${avifInfo.height}  ${(avifInfo.size / 1024).toFixed(1)} KB`
    );
    results.push({
      file: `${filenameBase}-${width}.avif`,
      path: avifPath,
      format: "avif",
      width: avifInfo.width,
      height: avifInfo.height,
      bytes: avifInfo.size,
    });

    const webpInfo = await base
      .clone()
      .webp({ quality: qualityWebp, effort: 4 })
      .toFile(webpPath);
    console.log(
      `✓ ${filenameBase}-${width}.webp  ${webpInfo.width}×${webpInfo.height}  ${(webpInfo.size / 1024).toFixed(1)} KB`
    );
    results.push({
      file: `${filenameBase}-${width}.webp`,
      path: webpPath,
      format: "webp",
      width: webpInfo.width,
      height: webpInfo.height,
      bytes: webpInfo.size,
    });
  }

  return results;
}
