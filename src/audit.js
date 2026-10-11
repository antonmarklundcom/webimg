// src/audit.js — find image problems in a folder or on a live page:
// oversized files, missing AVIF/WebP pairs, missing -og.jpg, <img> without alt or
// width/height, and non-SEO file names (img1, hero, IMG_1234 …).

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import { parseMaxKb } from "./budget.js";
import { isUrl } from "./convert.js";

const IMAGE_EXT = new Set([".avif", ".webp", ".jpg", ".jpeg", ".png", ".gif"]);
const HTML_EXT = new Set([".html", ".htm", ".php", ".ejs", ".njk", ".hbs", ".twig"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", ".next", "dist", "build", ".cache"]);

/** Names that say nothing about the subject: img1, hero, banner, IMG_1234, DSC0001, screenshot… */
const NON_SEO_PATTERNS = [
  /^(img|image|imagen|bild|photo|foto|pic|picture)[-_]?\d*$/i,
  /^(hero|banner|header|bg|background|cover|thumb|thumbnail|placeholder|untitled|final|new|test|sample)[-_]?\d*$/i,
  /^(img|dsc|dscn|dcim|pxl|mvimg|screenshot|screen shot|captura|skärmbild)[-_ ]?\d+/i,
  /^\d+$/,
  /^[a-f0-9]{16,}$/i, // hashes / uuids
  /^[a-z0-9]{1,2}$/i,
];

export function stripVariantSuffix(base) {
  return base.replace(/-(\d{2,4}|og|\d{2,4}w|@\dx)$/i, "");
}

export function isNonSeoName(fileName) {
  const base = stripVariantSuffix(path.basename(fileName, path.extname(fileName)));
  if (NON_SEO_PATTERNS.some((re) => re.test(base))) return true;
  const words = base.split(/[-_ ]+/).filter(Boolean);
  if (words.length < 2) return true; // one word says nothing about subject + place
  return false;
}

/** Width from a webimg-style name: slug-1280.avif → 1280, slug-og.jpg → "og". */
export function widthFromName(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  const m = base.match(/-(\d{2,4})$/);
  if (m) return Number(m[1]);
  if (/-og$/.test(base)) return "og";
  return null;
}

// ------------------------------------------------------------ HTML scanning

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const PICTURE_RE = /<picture\b[\s\S]*?<\/picture>/gi;
const SOURCE_RE = /<source\b[^>]*>/gi;
const META_OG_RE = /<meta\b[^>]*property=["']og:image["'][^>]*>/i;

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/**
 * Scans HTML text for <img> problems. Returns findings with line numbers.
 */
export function auditHtml(html, { label = "page" } = {}) {
  const findings = [];
  const lineOf = (index) => html.slice(0, index).split("\n").length;

  // Which <img> live inside a <picture> that has an AVIF and a WebP source?
  const pictureInfo = new Map();
  for (const m of html.matchAll(PICTURE_RE)) {
    const block = m[0];
    const types = [...block.matchAll(SOURCE_RE)].map((s) => (attr(s[0], "type") || "").toLowerCase());
    const srcsets = [...block.matchAll(SOURCE_RE)].map((s) => attr(s[0], "srcset") || "");
    const hasAvif = types.includes("image/avif") || srcsets.some((s) => /\.avif/i.test(s));
    const hasWebp = types.includes("image/webp") || srcsets.some((s) => /\.webp/i.test(s));
    for (const img of block.matchAll(IMG_TAG_RE)) {
      pictureInfo.set(m.index + img.index, { hasAvif, hasWebp });
    }
  }

  const images = [];
  for (const m of html.matchAll(IMG_TAG_RE)) {
    const tag = m[0];
    const src = attr(tag, "src") || attr(tag, "data-src") || "";
    if (/^data:/i.test(src)) continue;
    const line = lineOf(m.index);
    const where = `${label}:${line}`;
    const alt = attr(tag, "alt");
    const width = attr(tag, "width");
    const height = attr(tag, "height");
    const role = attr(tag, "role");
    const inPicture = pictureInfo.get(m.index);
    const fileName = src.split("?")[0].split("#")[0].split("/").pop() || src;

    images.push({ src, fileName, line });

    if (alt === null) findings.push({ type: "missing-alt", where, src, message: `<img> without alt attribute` });
    else if (alt.trim() === "" && role !== "presentation") {
      findings.push({ type: "empty-alt", where, src, message: `<img> with empty alt (fine only for decorative images)` });
    }
    if (!width || !height) findings.push({ type: "missing-dimensions", where, src, message: `<img> without width/height (layout shift)` });
    if (!inPicture && /\.(jpe?g|png)$/i.test(fileName)) {
      findings.push({ type: "no-modern-format", where, src, message: `plain <img> ${fileName} with no <picture> AVIF/WebP sources` });
    } else if (inPicture && (!inPicture.hasAvif || !inPicture.hasWebp)) {
      findings.push({ type: "missing-pair", where, src, message: `<picture> is missing ${!inPicture.hasAvif ? "AVIF" : "WebP"} source` });
    }
    if (fileName && isNonSeoName(fileName)) {
      findings.push({ type: "non-seo-name", where, src, message: `file name says nothing about the subject: ${fileName}` });
    }
  }

  if (!META_OG_RE.test(html)) {
    findings.push({ type: "missing-og", where: label, message: `no <meta property="og:image"> on the page` });
  }

  return { findings, images };
}

// ------------------------------------------------------------- dir audit

export async function auditDir(dir, { maxKb, log } = {}) {
  const absDir = path.resolve(dir);
  if (!fssync.existsSync(absDir)) throw new Error(`${dir} does not exist`);
  const budget = parseMaxKb(maxKb);
  const findings = [];
  const imageFiles = [];
  const htmlFiles = [];

  const walk = async (current) => {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) await walk(path.join(current, item.name));
        continue;
      }
      const ext = path.extname(item.name).toLowerCase();
      const full = path.join(current, item.name);
      if (IMAGE_EXT.has(ext)) imageFiles.push(full);
      else if (HTML_EXT.has(ext)) htmlFiles.push(full);
    }
  };
  await walk(absDir);

  const rel = (p) => path.relative(absDir, p).replace(/\\/g, "/");

  // Group variants by base name within their folder.
  const sets = new Map(); // dirname + base → { widths: Map<width, Set<ext>>, og: bool, files: [] }
  for (const file of imageFiles) {
    const ext = path.extname(file).toLowerCase();
    const nameNoExt = path.basename(file, ext);
    const width = widthFromName(file);
    const base = stripVariantSuffix(nameNoExt);
    const key = path.join(path.dirname(file), base);
    if (!sets.has(key)) sets.set(key, { base, dir: path.dirname(file), widths: new Map(), og: false, files: [] });
    const set = sets.get(key);
    set.files.push(file);
    if (width === "og") set.og = true;
    else if (width) {
      if (!set.widths.has(width)) set.widths.set(width, new Set());
      set.widths.get(width).add(ext);
    }

    const stat = await fs.stat(file);
    const kb = stat.size / 1024;
    let limit = null;
    if (budget) {
      if (width === "og") limit = budget.og;
      else if (typeof width === "number") limit = budget.forWidth(width);
      else limit = budget.forWidth(1280); // unknown width: hold it to the 1280 budget
    }
    if (limit && kb > limit) {
      findings.push({ type: "oversized", where: rel(file), message: `${kb.toFixed(1)} KB > ${limit} KB budget` });
    }
    if (isNonSeoName(file)) {
      findings.push({ type: "non-seo-name", where: rel(file), message: `file name says nothing about the subject` });
    }
  }

  for (const set of sets.values()) {
    if (set.widths.size === 0) continue; // not a webimg-style set (single file), judged above only
    for (const [w, exts] of set.widths) {
      if (!exts.has(".avif")) findings.push({ type: "missing-pair", where: rel(path.join(set.dir, `${set.base}-${w}.avif`)), message: `missing AVIF for ${set.base}-${w}` });
      if (!exts.has(".webp")) findings.push({ type: "missing-pair", where: rel(path.join(set.dir, `${set.base}-${w}.webp`)), message: `missing WebP for ${set.base}-${w}` });
    }
    if (!set.og) findings.push({ type: "missing-og", where: rel(path.join(set.dir, `${set.base}-og.jpg`)), message: `no ${set.base}-og.jpg (1200×630) next to the set` });
  }

  for (const file of htmlFiles) {
    const html = await fs.readFile(file, "utf8");
    const { findings: f } = auditHtml(html, { label: rel(file) });
    // In a folder of templates, og:image is usually set in a layout file, so only report it per page when there are <img> tags.
    findings.push(...f.filter((x) => x.type !== "missing-og" || /<img\b/i.test(html)));
  }

  return { findings, counts: { images: imageFiles.length, html: htmlFiles.length, sets: sets.size } };
}

// ------------------------------------------------------------- url audit

async function headSize(url, fetchImpl) {
  try {
    let res = await fetchImpl(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok || !res.headers.get("content-length")) {
      res = await fetchImpl(url, { method: "GET", redirect: "follow" });
      if (!res.ok) return { status: res.status, bytes: null, type: res.headers.get("content-type") };
      const buf = await res.arrayBuffer();
      return { status: res.status, bytes: buf.byteLength, type: res.headers.get("content-type") };
    }
    return { status: res.status, bytes: Number(res.headers.get("content-length")), type: res.headers.get("content-type") };
  } catch (err) {
    return { status: 0, bytes: null, error: err && err.message ? err.message : String(err) };
  }
}

export async function auditUrl(pageUrl, { maxKb, fetchImpl = fetch } = {}) {
  const budget = parseMaxKb(maxKb);
  const res = await fetchImpl(pageUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`${pageUrl} returned ${res.status}`);
  const html = await res.text();
  const { findings, images } = auditHtml(html, { label: pageUrl });

  const seen = new Set();
  for (const img of images) {
    if (!img.src || seen.has(img.src)) continue;
    seen.add(img.src);
    let abs;
    try {
      abs = new URL(img.src, pageUrl).toString();
    } catch {
      continue;
    }
    const info = await headSize(abs, fetchImpl);
    if (info.status === 0 || info.status >= 400) {
      findings.push({ type: "broken", where: `${pageUrl}:${img.line}`, src: img.src, message: `image request failed (${info.error || info.status})` });
      continue;
    }
    if (info.bytes !== null && budget) {
      const width = widthFromName(img.fileName);
      const limit = width === "og" ? budget.og : budget.forWidth(typeof width === "number" ? width : 1280);
      const kb = info.bytes / 1024;
      if (kb > limit) findings.push({ type: "oversized", where: `${pageUrl}:${img.line}`, src: img.src, message: `${kb.toFixed(1)} KB > ${limit} KB budget` });
    }
  }
  return { findings, counts: { images: images.length } };
}

export async function audit(target, opts = {}) {
  return isUrl(target) ? auditUrl(target, opts) : auditDir(target, opts);
}

export function summarize(findings) {
  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
  return byType;
}
