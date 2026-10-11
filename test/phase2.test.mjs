// test/phase2.test.mjs — og:image, size budgets, hygiene, idempotent runs, upload, audit.
// Must pass with ANTHROPIC_API_KEY unset and with no network beyond 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import sharp from "sharp";

import { parseMaxKb, encodeWithinBudget, QUALITY_FLOOR } from "../src/budget.js";
import { convertImage } from "../src/convert.js";
import { planUpload, uploadToDir, uploadToR2, uploadToSftp, IMMUTABLE_CACHE } from "../src/upload.js";
import { auditDir, auditHtml, auditUrl, isNonSeoName } from "../src/audit.js";
import { DEFAULT_MODEL } from "../src/naming.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(__dirname, "tmp-phase2");
const cliPath = path.join(rootDir, "webimg.mjs");
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;

const photoPng = path.join(tmpDir, "photo.png");
const logoPng = path.join(tmpDir, "logo.png");
const exifJpg = path.join(tmpDir, "with-exif.jpg");
const tiffSrc = path.join(tmpDir, "scan.tiff");
const avifSrc = path.join(tmpDir, "source.avif");

function noisyPng(width, height, file) {
  // Random noise compresses badly, which is what we need to exercise the budget step-down.
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  let seed = 12345;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = seed & 0xff;
  }
  return sharp(buf, { raw: { width, height, channels } }).png().toFile(file);
}

before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await noisyPng(1400, 788, photoPng);
  // Transparent logo: a circle on a fully transparent background.
  const svg = `<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg"><circle cx="400" cy="400" r="300" fill="#0f766e"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(logoPng);
  // JPG with EXIF (Artist + GPS) and the sRGB-less Adobe RGB-ish profile left alone.
  await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#e76f51" } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Artist: "Secret Photographer", Copyright: "old notice" }, GPS: { GPSLatitudeRef: "N", GPSLatitude: "25/1 17/1 0/1" } })
    .toFile(exifJpg);
  await sharp({ create: { width: 1300, height: 800, channels: 3, background: "#2a9d8f" } }).tiff().toFile(tiffSrc);
  await sharp({ create: { width: 1300, height: 800, channels: 3, background: "#264653" } }).avif({ quality: 50 }).toFile(avifSrc);
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------- budgets

test("parseMaxKb: defaults, single number, per-width map, off", () => {
  const d = parseMaxKb(undefined);
  assert.equal(d.forWidth(1280), 120);
  assert.equal(d.forWidth(640), 60);
  assert.equal(d.forWidth(1920), 200);
  assert.equal(d.forWidth(1120), 105, "interpolated between 960:90 and 1280:120");
  assert.equal(d.og, 200);
  assert.equal(parseMaxKb("90").forWidth(1280), 90);
  const m = parseMaxKb("640:50,1280:100,og:150");
  assert.equal(m.forWidth(640), 50);
  assert.equal(m.forWidth(1280), 100);
  assert.equal(m.og, 150);
  assert.equal(parseMaxKb("off"), null);
  assert.throws(() => parseMaxKb("abc"));
});

test("encodeWithinBudget steps quality down and stops at the floor", async () => {
  const sizes = [];
  const encode = async (q) => {
    sizes.push(q);
    return { size: q * 1000 }; // 1 KB per quality point
  };
  const ok = await encodeWithinBudget({ encode, startQuality: 44, budgetKb: 30, format: "avif" });
  assert.equal(ok.quality, 28);
  assert.equal(ok.overBudget, false);
  assert.deepEqual(sizes, [44, 40, 36, 32, 28]);
  const miss = await encodeWithinBudget({ encode, startQuality: 60, budgetKb: 10, format: "webp" });
  assert.equal(miss.quality, QUALITY_FLOOR.webp);
  assert.equal(miss.overBudget, true);
});

test("convert: --max-kb lowers quality until the budget is met and records it in the manifest", async () => {
  const outDir = path.join(tmpDir, "out-budget");
  const tight = await convertImage({ input: photoPng, name: "calle-ruidosa-asuncion", alt: "x", widths: "1280", outDir, maxKb: "1280:40", log: () => {} });
  const loose = await convertImage({ input: photoPng, name: "calle-ruidosa-asuncion-b", alt: "x", widths: "1280", outDir, maxKb: "off", log: () => {} });
  const tightAvif = tight.entries.find((e) => e.format === "avif");
  const looseAvif = loose.entries.find((e) => e.format === "avif");
  assert.ok(looseAvif.bytes > 40 * 1024, "noise at q44 must exceed 40 KB for this test to mean anything");
  assert.ok(tightAvif.quality < 44, "quality must have stepped down");
  assert.ok(tightAvif.bytes < looseAvif.bytes);
  assert.equal(tightAvif.budget_kb, 40);
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8"));
  const f = manifest.images.find((i) => i.filename_base === "calle-ruidosa-asuncion").files.find((x) => x.format === "avif");
  assert.equal(f.quality, tightAvif.quality);
  assert.equal(f.bytes, tightAvif.bytes);
  assert.ok(f.width === 1280 && f.height > 0);
});

test("convert: a budget that cannot be met is reported, not silently accepted", async () => {
  const outDir = path.join(tmpDir, "out-miss");
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "convert", photoPng, "--name", "ruido-imposible-luque", "--alt", "x", "--out", outDir, "--max-kb", "640:1", "--widths", "640"], { cwd: rootDir, env });
  assert.match(stdout, /over budget at the quality floor/);
  assert.match(stdout, /OVER BUDGET/);
});

// ---------------------------------------------------------------- og:image

test("convert: --og writes <name>-og.jpg at 1200×630 and an og snippet", async () => {
  const outDir = path.join(tmpDir, "out-og");
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "convert", photoPng, "--name", "fachada-clinica-dental-asuncion", "--alt", "Fachada", "--widths", "640,1280", "--out", outDir, "--public-path", "/assets/img", "--og"], { cwd: rootDir, env });
  const ogPath = path.join(outDir, "fachada-clinica-dental-asuncion-og.jpg");
  assert.ok(fssync.existsSync(ogPath));
  const meta = await sharp(ogPath).metadata();
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
  assert.equal(meta.format, "jpeg");
  assert.ok(meta.isProgressive);
  assert.match(stdout, /<meta property="og:image" content="\/assets\/img\/fachada-clinica-dental-asuncion-og\.jpg">/);
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8"));
  const entry = manifest.images[0];
  assert.ok(entry.files.some((f) => f.file.endsWith("-og.jpg") && f.format === "jpg" && f.width === 1200 && f.height === 630));
  assert.ok(entry.og_snippet.includes('og:image:width" content="1200"'));
  // PHP sites expect {base}-og.jpg next to {base}-640/1280.webp/avif
  for (const f of ["-640.avif", "-640.webp", "-1280.avif", "-1280.webp", "-og.jpg"]) {
    assert.ok(fssync.existsSync(path.join(outDir, `fachada-clinica-dental-asuncion${f}`)), f);
  }
});

test("convert: --og --dry-run lists the og file with its budget and writes nothing", async () => {
  const outDir = path.join(tmpDir, "out-og-dry");
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "convert", photoPng, "--name", "prueba-seca-og", "--alt", "x", "--widths", "640", "--out", outDir, "--og", "--dry-run"], { cwd: rootDir, env });
  assert.match(stdout, /prueba-seca-og-og\.jpg\s+1200×630\s+q82\s+budget ≤ 200 KB/);
  assert.match(stdout, /prueba-seca-og-640\.avif\s+640×360\s+q44\s+budget ≤ 60 KB/);
  assert.ok(!fssync.existsSync(outDir));
});

// ----------------------------------------------------------------- hygiene

test("hygiene: EXIF/GPS are stripped, sRGB profile embedded, --copyright/--creator written fresh", async () => {
  const outDir = path.join(tmpDir, "out-exif");
  const plain = await convertImage({ input: exifJpg, name: "foto-sin-metadatos", alt: "x", widths: "640", outDir, log: () => {} });
  for (const e of plain.entries) {
    const meta = await sharp(e.path).metadata();
    assert.equal(meta.exif, undefined, `${e.file} must carry no EXIF from the input`);
    assert.equal(meta.space, "srgb");
  }
  const tagged = await convertImage({ input: exifJpg, name: "foto-con-credito", alt: "x", widths: "640", outDir, og: true, copyright: "© 2026 Clínica Ejemplo", creator: "webimg test", log: () => {} });
  for (const e of tagged.entries) {
    const meta = await sharp(e.path).metadata();
    assert.ok(meta.exif, `${e.file} should carry the new EXIF block`);
    const exifText = meta.exif.toString("latin1");
    assert.ok(exifText.includes("webimg test"), `${e.file} EXIF Artist`);
    assert.ok(!exifText.includes("Secret Photographer"), `${e.file} must not leak the input Artist`);
    assert.ok(!exifText.includes("GPSLatitude") && !/\x88\x25/.test(exifText.slice(0, 64)) , `${e.file} must not carry GPS`);
    if (meta.xmp) assert.ok(meta.xmp.toString().includes("Clínica Ejemplo"), `${e.file} XMP dc:rights`);
  }
  const withXmp = [];
  for (const e of tagged.entries) {
    const meta = await sharp(e.path).metadata();
    if (meta.xmp) withXmp.push(e.format);
  }
  assert.ok(withXmp.includes("webp") && withXmp.includes("jpg"), `XMP expected at least on WebP and JPG, got ${withXmp.join(",")}`);
});

test("hygiene: transparent PNG keeps alpha in WebP/AVIF; the og JPG is flattened", async () => {
  const outDir = path.join(tmpDir, "out-alpha");
  const { entries } = await convertImage({ input: logoPng, name: "logotipo-clinica-transparente", alt: "x", widths: "400", outDir, og: true, log: () => {} });
  const webp = await sharp(entries.find((e) => e.format === "webp").path).metadata();
  const avif = await sharp(entries.find((e) => e.format === "avif").path).metadata();
  assert.equal(webp.hasAlpha, true);
  assert.equal(avif.hasAlpha, true);
  const corner = await sharp(entries.find((e) => e.format === "webp").path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(corner.data[3], 0, "top-left pixel of the logo must stay transparent");
  const og = await sharp(entries.find((e) => e.format === "jpg").path).metadata();
  assert.equal(og.hasAlpha, false);
  const ogPix = await sharp(entries.find((e) => e.format === "jpg").path).raw().toBuffer();
  assert.ok(ogPix[0] > 240 && ogPix[1] > 240 && ogPix[2] > 240, "flattened og corner is white");
});

test("inputs: .tiff and .avif sources convert; unsupported extensions are rejected with the full list", async () => {
  const outDir = path.join(tmpDir, "out-inputs");
  const t = await convertImage({ input: tiffSrc, name: "escaneo-plano-casa", alt: "x", widths: "640", outDir, log: () => {} });
  const a = await convertImage({ input: avifSrc, name: "origen-avif-prueba", alt: "x", widths: "640", outDir, log: () => {} });
  assert.equal(t.entries.length, 2);
  assert.equal(a.entries.length, 2);
  const bmp = path.join(tmpDir, "x.bmp");
  await fs.writeFile(bmp, "nope");
  await assert.rejects(convertImage({ input: bmp, name: "a-b-c", alt: "x", outDir, log: () => {} }), /\.heic, \.tif/);
});

// --------------------------------------------------------------- idempotent

test("idempotent: a second run with the same source and options is skipped; --force and a changed source re-encode", async () => {
  const outDir = path.join(tmpDir, "out-idem");
  const first = await convertImage({ input: photoPng, name: "misma-fuente-dos-veces", alt: "uno", widths: "640", outDir, log: () => {} });
  assert.equal(first.skipped, false);
  const mtimeBefore = (await fs.stat(first.entries[0].path)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));

  const logs = [];
  const second = await convertImage({ input: photoPng, name: "misma-fuente-dos-veces", alt: "dos (alt cambiado)", widths: "640", outDir, log: (m) => logs.push(m) });
  assert.equal(second.skipped, true);
  assert.ok(logs.some((l) => /skipped/.test(l)));
  assert.equal((await fs.stat(first.entries[0].path)).mtimeMs, mtimeBefore, "files must not be rewritten");
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8"));
  const entry = manifest.images.find((i) => i.filename_base === "misma-fuente-dos-veces");
  assert.equal(entry.alt_text, "dos (alt cambiado)", "alt/snippet still update without re-encoding");
  assert.match(entry.source_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(entry.html_snippet.includes('alt="dos (alt cambiado)"'));

  const third = await convertImage({ input: photoPng, name: "misma-fuente-dos-veces", alt: "tres", widths: "640", outDir, og: true, log: () => {} });
  assert.equal(third.skipped, false, "different options (og) must re-encode");

  const forced = await convertImage({ input: photoPng, name: "misma-fuente-dos-veces", alt: "tres", widths: "640", outDir, og: true, force: true, log: () => {} });
  assert.equal(forced.skipped, false);

  await fs.unlink(path.join(outDir, "misma-fuente-dos-veces-640.webp"));
  const missing = await convertImage({ input: photoPng, name: "misma-fuente-dos-veces", alt: "tres", widths: "640", outDir, og: true, log: () => {} });
  assert.equal(missing.skipped, false, "a missing output file must trigger a re-encode");
  assert.ok(fssync.existsSync(path.join(outDir, "misma-fuente-dos-veces-640.webp")));
});

test("batch: unchanged rows are counted as unchanged on the second run", async () => {
  const outDir = path.join(tmpDir, "out-batch-idem");
  const csv = path.join(tmpDir, "idem.csv");
  await fs.writeFile(csv, `file,name,alt\nphoto.png,lote-repetido-prueba,Alt de prueba\n`, "utf8");
  const run = () => execFileAsync(process.execPath, [cliPath, "batch", tmpDir, "--manifest", csv, "--widths", "640", "--out", outDir], { cwd: rootDir, env });
  const a = await run();
  assert.match(a.stdout, /Done: 1 converted, 0 unchanged, 0 skipped, 0 failed/);
  const b = await run();
  assert.match(b.stdout, /Done: 0 converted, 1 unchanged, 0 skipped, 0 failed/);
});

// ------------------------------------------------------------------ upload

test("upload --to dir copies into a site folder, skips identical files, --dry-run writes nothing", async () => {
  const src = path.join(tmpDir, "up-src");
  await convertImage({ input: photoPng, name: "subida-carpeta-prueba", alt: "x", widths: "640", outDir: src, og: true, log: () => {} });
  const dest = path.join(tmpDir, "site", "assets", "img");

  const dry = await execFileAsync(process.execPath, [cliPath, "upload", src, "--to", "dir", "--dest", dest, "--dry-run"], { cwd: rootDir, env });
  assert.match(dry.stdout, /3 files/);
  assert.ok(!fssync.existsSync(dest));

  const real = await execFileAsync(process.execPath, [cliPath, "upload", src, "--to", "dir", "--dest", dest], { cwd: rootDir, env });
  assert.match(real.stdout, /Done: 3 copied, 0 unchanged/);
  assert.ok(fssync.existsSync(path.join(dest, "subida-carpeta-prueba-og.jpg")));
  assert.ok(!fssync.existsSync(path.join(dest, "manifest.json")), "manifest is not copied unless asked");

  const again = await execFileAsync(process.execPath, [cliPath, "upload", src, "--to", "dir", "--dest", dest, "--include-manifest"], { cwd: rootDir, env });
  assert.match(again.stdout, /Done: 1 copied, 3 unchanged/);
  assert.ok(fssync.existsSync(path.join(dest, "manifest.json")));
});

test("upload --to r2 signs S3 PUTs with the right Content-Type, Cache-Control and sha256 metadata, skips unchanged objects", async () => {
  const src = path.join(tmpDir, "up-r2");
  await convertImage({ input: photoPng, name: "subida-r2-prueba", alt: "x", widths: "640", outDir: src, og: true, log: () => {} });

  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      const key = decodeURIComponent(req.url.split("?")[0]);
      if (req.method === "PUT") {
        objects.set(key, { body, headers: req.headers });
        res.writeHead(200, { etag: '"x"' });
        res.end();
        return;
      }
      if (req.method === "HEAD") {
        const obj = objects.get(key);
        if (!obj) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-length": String(obj.body.length), "x-amz-meta-sha256": obj.headers["x-amz-meta-sha256"], "content-type": obj.headers["content-type"] });
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    const files = await planUpload(src);
    assert.equal(files.length, 3);

    // dry run: no requests, no secrets needed
    const dryLogs = [];
    const dry = await uploadToR2(files, { bucket: "imgs", prefix: "sites/dentista", dryRun: true, log: (m) => dryLogs.push(m) });
    assert.equal(dry.planned, 3);
    assert.equal(requests.length, 0);
    assert.ok(dryLogs.some((l) => l.includes("sites/dentista/subida-r2-prueba-og.jpg") && l.includes("image/jpeg") && l.includes(IMMUTABLE_CACHE)));

    const prevEnv = { ...process.env };
    process.env.R2_ACCESS_KEY_ID = "test-key-id";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_ENDPOINT = endpoint;
    delete process.env.R2_ACCOUNT_ID;
    const logs = [];
    try {
      const r = await uploadToR2(files, { bucket: "imgs", prefix: "sites/dentista", log: (m) => logs.push(m) });
      assert.equal(r.uploaded, 3);
      const put = objects.get("/imgs/sites/dentista/subida-r2-prueba-640.avif");
      assert.ok(put, `expected a PUT for the avif, got ${[...objects.keys()].join(", ")}`);
      assert.equal(put.headers["content-type"], "image/avif");
      assert.equal(put.headers["cache-control"], IMMUTABLE_CACHE);
      assert.match(put.headers["x-amz-meta-sha256"], /^[a-f0-9]{64}$/);
      assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-key-id\//);
      assert.equal(objects.get("/imgs/sites/dentista/subida-r2-prueba-og.jpg").headers["content-type"], "image/jpeg");

      const r2 = await uploadToR2(files, { bucket: "imgs", prefix: "sites/dentista", log: (m) => logs.push(m) });
      assert.equal(r2.uploaded, 0);
      assert.equal(r2.skipped, 3);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
      Object.assign(process.env, prevEnv);
    }
    const joined = logs.join("\n");
    assert.ok(!joined.includes("test-secret"), "secret must never be logged");

    // missing credentials → clear error naming the env vars, never the values
    const noEnv = { ...process.env };
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ENDPOINT;
    try {
      await assert.rejects(uploadToR2(files, { bucket: "imgs", log: () => {} }), /R2_ACCESS_KEY_ID/);
    } finally {
      Object.assign(process.env, noEnv);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("upload --to sftp: dry run needs no credentials; a fake client receives mkdir + put per file", async () => {
  const src = path.join(tmpDir, "up-sftp");
  await convertImage({ input: photoPng, name: "subida-sftp-prueba", alt: "x", widths: "640", outDir: src, log: () => {} });
  const files = await planUpload(src);
  const logs = [];
  const dry = await uploadToSftp(files, { remoteDir: "/home/u1/domains/x/public_html/assets/img", dryRun: true, log: (m) => logs.push(m) });
  assert.equal(dry.planned, 2);
  assert.ok(logs.some((l) => l.includes("/public_html/assets/img/subida-sftp-prueba-640.webp")));

  const calls = [];
  const fake = {
    mkdir: async (p, rec) => calls.push(["mkdir", p, rec]),
    put: async (local, remote) => calls.push(["put", path.basename(local), remote]),
    end: async () => calls.push(["end"]),
  };
  const prev = { ...process.env };
  process.env.SFTP_HOST = "example.invalid";
  process.env.SFTP_USER = "u1";
  process.env.SFTP_PASSWORD = "pw-not-logged";
  try {
    const r = await uploadToSftp(files, { remoteDir: "/home/u1/public_html/assets/img", clientOverride: fake, log: (m) => logs.push(m) });
    assert.equal(r.uploaded, 2);
    assert.deepEqual(calls.filter((c) => c[0] === "put").map((c) => c[2]).sort(), [
      "/home/u1/public_html/assets/img/subida-sftp-prueba-640.avif",
      "/home/u1/public_html/assets/img/subida-sftp-prueba-640.webp",
    ]);
    assert.ok(calls.some((c) => c[0] === "mkdir" && c[1] === "/home/u1/public_html/assets/img" && c[2] === true));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
  assert.ok(!logs.join("\n").includes("pw-not-logged"));
});

// ------------------------------------------------------------------- audit

test("audit: non-SEO names are detected, descriptive slugs pass", () => {
  for (const bad of ["img1.jpg", "hero.webp", "IMG_1234.jpg", "DSC00123.JPG", "banner-1280.avif", "photo.png", "a1b2c3d4e5f6a7b8c9d0.webp", "logo.png", "Screenshot 2026-10-11.png"]) {
    assert.equal(isNonSeoName(bad), true, bad);
  }
  for (const good of ["limpieza-dental-consultorio-asuncion-1280.avif", "takbyte-villa-umea-og.jpg", "tasacion-casa-luque.webp"]) {
    assert.equal(isNonSeoName(good), false, good);
  }
});

test("audit <dir>: oversized files, missing pairs, missing -og.jpg, img without alt/width/height", async () => {
  const dir = path.join(tmpDir, "audit-dir");
  const img = path.join(dir, "assets", "img");
  await convertImage({ input: photoPng, name: "sala-espera-clinica-asuncion", alt: "x", widths: "640,1280", outDir: img, og: true, log: () => {} });
  await convertImage({ input: photoPng, name: "recepcion-dental-luque", alt: "x", widths: "640", outDir: img, log: () => {} }); // no og
  await fs.unlink(path.join(img, "recepcion-dental-luque-640.avif")); // broken pair
  await fs.copyFile(photoPng, path.join(img, "IMG_4521.png")); // big + non-seo
  await fs.writeFile(path.join(dir, "index.php"), `<!doctype html><html><head><meta property="og:image" content="/assets/img/sala-espera-clinica-asuncion-og.jpg"></head><body>
<picture><source type="image/avif" srcset="/assets/img/sala-espera-clinica-asuncion-640.avif 640w"><source type="image/webp" srcset="/assets/img/sala-espera-clinica-asuncion-640.webp 640w"><img src="/assets/img/sala-espera-clinica-asuncion-640.webp" alt="Sala de espera" width="640" height="360" loading="lazy"></picture>
<img src="/assets/img/IMG_4521.png">
<img src="/assets/img/recepcion-dental-luque-640.webp" alt="Recepción">
</body></html>`, "utf8");

  const { findings } = await auditDir(dir, {});
  const types = (t) => findings.filter((f) => f.type === t);
  assert.ok(types("oversized").some((f) => f.where.endsWith("IMG_4521.png")), "IMG_4521.png is far over 120 KB");
  assert.ok(types("missing-pair").some((f) => f.where.endsWith("recepcion-dental-luque-640.avif")));
  assert.ok(types("missing-og").some((f) => f.where.endsWith("recepcion-dental-luque-og.jpg")));
  assert.ok(!types("missing-og").some((f) => f.where.endsWith("sala-espera-clinica-asuncion-og.jpg")));
  assert.ok(types("non-seo-name").some((f) => f.where.endsWith("IMG_4521.png")));
  assert.ok(types("missing-alt").some((f) => f.src === "/assets/img/IMG_4521.png"));
  assert.ok(types("missing-dimensions").some((f) => f.src === "/assets/img/recepcion-dental-luque-640.webp"));
  assert.ok(types("no-modern-format").some((f) => f.src === "/assets/img/IMG_4521.png"));
  assert.ok(!findings.some((f) => f.src === "/assets/img/sala-espera-clinica-asuncion-640.webp"), "the correct <picture> produces no findings");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "audit", dir], { cwd: rootDir, env });
  assert.match(stdout, /problems:/);
  assert.match(stdout, /non-seo-name/);
  await assert.rejects(execFileAsync(process.execPath, [cliPath, "audit", dir, "--strict"], { cwd: rootDir, env }), (e) => e.code === 1);
  const clean = await execFileAsync(process.execPath, [cliPath, "audit", dir, "--json"], { cwd: rootDir, env });
  const parsed = JSON.parse(clean.stdout);
  assert.ok(parsed.summary.oversized >= 1);
});

test("audit <url>: fetches the page, checks img tags and measures image sizes", async () => {
  const dir = path.join(tmpDir, "audit-url");
  await convertImage({ input: photoPng, name: "consultorio-moderno-asuncion", alt: "x", widths: "640", outDir: dir, og: true, log: () => {} });
  const html = `<html><head></head><body>
<picture><source type="image/avif" srcset="/consultorio-moderno-asuncion-640.avif 640w"><source type="image/webp" srcset="/consultorio-moderno-asuncion-640.webp 640w"><img src="/consultorio-moderno-asuncion-640.webp" alt="Consultorio" width="640" height="360"></picture>
<img src="/hero.jpg" alt="">
<img src="/missing.jpg" alt="x" width="1" height="1">
</body></html>`;
  await fs.writeFile(path.join(dir, "hero.jpg"), await sharp(photoPng).jpeg({ quality: 100 }).toBuffer());
  const server = http.createServer((req, res) => {
    const p = req.url === "/" ? null : path.join(dir, decodeURIComponent(req.url));
    if (!p) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    if (!fssync.existsSync(p)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const data = fssync.readFileSync(p);
    res.writeHead(200, { "content-length": String(data.length), "content-type": "image/jpeg" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { findings } = await auditUrl(base, {});
    const has = (type, src) => findings.some((f) => f.type === type && (src === undefined || f.src === src));
    assert.ok(has("missing-og"));
    assert.ok(has("empty-alt", "/hero.jpg"));
    assert.ok(has("missing-dimensions", "/hero.jpg"));
    assert.ok(has("non-seo-name", "/hero.jpg"));
    assert.ok(has("no-modern-format", "/hero.jpg"));
    assert.ok(has("oversized", "/hero.jpg"));
    assert.ok(has("broken", "/missing.jpg"));
    assert.ok(!findings.some((f) => f.src === "/consultorio-moderno-asuncion-640.webp"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ------------------------------------------------------------- maintenance

test("maintenance: the SDK is pinned and the default naming model is a current Claude id", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  assert.match(pkg.dependencies["@anthropic-ai/sdk"], /^\d+\.\d+\.\d+$/, "pinned to an exact version, not latest");
  assert.equal(DEFAULT_MODEL, "claude-opus-5-5");
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "convert", "--help"], { cwd: rootDir, env });
  assert.match(stdout, /--og\b/);
  assert.match(stdout, /--max-kb/);
  assert.match(stdout, /--copyright/);
  assert.match(stdout, /claude-opus-5-5/);
  const top = await execFileAsync(process.execPath, [cliPath, "--help"], { cwd: rootDir, env });
  assert.match(top.stdout, /upload/);
  assert.match(top.stdout, /audit/);
});
