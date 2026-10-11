// src/manifest.js — reads / writes / merges manifest.json describing generated image sets.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Reads <outDir>/manifest.json. Returns an empty manifest when missing or invalid.
 */
export async function readManifest(outDir) {
  const manifestPath = path.join(outDir, "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.images)) parsed.images = [];
    return parsed;
  } catch {
    return { generated_at: null, images: [] };
  }
}

/**
 * Returns the existing manifest entry for `filenameBase`, or null.
 */
export async function findManifestEntry(outDir, filenameBase) {
  const manifest = await readManifest(outDir);
  return manifest.images.find((img) => img.filename_base === filenameBase) || null;
}

/**
 * Writes <outDir>/manifest.json, merging with any existing manifest.
 * Entries are matched (and replaced) by filename_base; others are preserved.
 *
 * @param {string} outDir
 * @param {Array<object>} entries - image entries, shape as per spec's manifest.json "images" items
 */
export async function writeManifest(outDir, entries) {
  const manifestPath = path.join(outDir, "manifest.json");
  const existing = await readManifest(outDir);

  const newBases = new Set(entries.map((e) => e.filename_base));
  const kept = existing.images.filter((img) => !newBases.has(img.filename_base));
  const merged = [...kept, ...entries];

  const manifest = {
    generated_at: new Date().toISOString(),
    images: merged,
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return manifest;
}
