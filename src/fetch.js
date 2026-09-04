// src/fetch.js — downloads an http(s) image URL to a temp file for the sharp pipeline.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const EXT_FROM_PATHNAME = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const EXT_FROM_CONTENT_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function extFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const ext = path.extname(pathname).toLowerCase();
    return EXT_FROM_PATHNAME.has(ext) ? ext : null;
  } catch {
    return null;
  }
}

function extFromContentType(contentType) {
  if (!contentType) return null;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return EXT_FROM_CONTENT_TYPE[type] || null;
}

/**
 * Downloads `url` to a uniquely-named file under the OS temp dir.
 * @param {string} url
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>}
 */
export async function fetchToTemp(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: controller.signal });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    throw new Error(`download failed: ${reason} ${url}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${url}`);
  }

  let ext = extFromUrl(url);
  if (!ext) {
    ext = extFromContentType(res.headers.get("content-type"));
  }
  if (!ext) {
    throw new Error(`unsupported image type for ${url}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const tempPath = path.join(os.tmpdir(), `webimg-${randomUUID()}${ext}`);
  await fs.writeFile(tempPath, buf);

  console.log(`ℹ downloaded ${url} (${(buf.length / 1024).toFixed(1)} KB)`);

  const cleanup = async () => {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore
    }
  };

  return { path: tempPath, cleanup };
}
