// src/manifest.js — writes / merges manifest.json describing generated image sets.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Writes <outDir>/manifest.json, merging with any existing manifest.
 * Entries are matched (and replaced) by filename_base; others are preserved.
 *
 * @param {string} outDir
 * @param {Array<object>} entries - image entries, shape as per spec's manifest.json "images" items
 */
export async function writeManifest(outDir, entries) {
  const manifestPath = path.join(outDir, "manifest.json");

  let existing = { generated_at: null, images: [] };
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    existing = JSON.parse(raw);
    if (!Array.isArray(existing.images)) existing.images = [];
  } catch {
    // no existing manifest, or unreadable/invalid — start fresh
    existing = { generated_at: null, images: [] };
  }

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
