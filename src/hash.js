// src/hash.js — content hashes used to skip unchanged inputs between runs.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export async function hashFile(filePath) {
  const buf = await fs.readFile(filePath);
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

export function hashBuffer(buf) {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/**
 * Stable hash of the conversion options that change the output files.
 * Naming (alt/prompt) is deliberately excluded: changing alt text rewrites the
 * manifest + snippet without re-encoding.
 */
export function hashOptions(opts) {
  const ordered = Object.keys(opts)
    .sort()
    .reduce((acc, k) => {
      acc[k] = opts[k] === undefined ? null : opts[k];
      return acc;
    }, {});
  return "sha256:" + createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
}
