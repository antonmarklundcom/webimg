// test/serve.test.mjs — zip writer + local server tests. Must pass with ANTHROPIC_API_KEY unset.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import sharp from "sharp";

import { createZip, crc32, zipDirectory } from "../src/zip.js";
import { startServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(__dirname, "tmp-serve");
const outDir = path.join(tmpDir, "out");
const samplePng = path.join(tmpDir, "sample.png");
const cliPath = path.join(rootDir, "webimg.mjs");

let srv;

before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await sharp({ create: { width: 800, height: 450, channels: 3, background: "#2a9d8f" } })
    .png()
    .toFile(samplePng);
  srv = await startServer({ outDir, port: 0, log: () => {} });
});

after(async () => {
  if (srv) await srv.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Minimal zip reader: parses the central directory and inflates each entry. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "EOCD record present");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    const payload = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(crc32(data), crc, `crc matches for ${name}`);
    entries[name] = data;
    off += 46 + nlen;
  }
  return entries;
}

test("createZip round-trips deflated and stored entries", () => {
  const text = Buffer.from("hello hello hello hello hello hello");
  const bin = Buffer.from([1, 2, 3]);
  const zip = createZip([
    { name: "a.txt", data: text },
    { name: "sub/b.bin", data: bin },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(Object.keys(entries).sort(), ["a.txt", "sub/b.bin"]);
  assert.equal(entries["a.txt"].toString(), text.toString());
  assert.deepEqual([...entries["sub/b.bin"]], [1, 2, 3]);
});

test("POST /api/convert writes an image set and the batch zip contains it", async () => {
  const body = await fs.readFile(samplePng);
  const q = new URLSearchParams({
    filename: "sample.png",
    prompt: "fachada de casa en Luque",
    ar: "4:3",
    widths: "320,640",
    batch: "b1",
  });
  const res = await fetch(`${srv.url}api/convert?${q}`, { method: "POST", body });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.batch, "b1");
  assert.equal(json.entry.filename_base, "fachada-de-casa-en-luque");
  assert.equal(json.entry.source, "sample.png");
  assert.equal(json.entry.files.length, 4);
  assert.equal(json.entry.files[0].height, 240);
  await fs.access(path.join(outDir, "fachada-de-casa-en-luque-640.avif"));

  // explicit slug + alt, same batch
  const q2 = new URLSearchParams({ filename: "sample.png", name: "oficina-luque", alt: "Oficina", widths: "320", batch: "b1" });
  const res2 = await fetch(`${srv.url}api/convert?${q2}`, { method: "POST", body });
  assert.equal(res2.status, 200);
  const json2 = await res2.json();
  assert.equal(json2.entry.alt_text, "Oficina");

  const manifest = await fetch(`${srv.url}api/manifest`).then((r) => r.json());
  assert.equal(manifest.images.length, 2);

  const zipRes = await fetch(`${srv.url}api/batch/b1.zip`);
  assert.equal(zipRes.status, 200);
  assert.match(zipRes.headers.get("content-disposition"), /webimg-b1\.zip/);
  const entries = readZip(Buffer.from(await zipRes.arrayBuffer()));
  const names = Object.keys(entries).sort();
  assert.deepEqual(names, [
    "fachada-de-casa-en-luque-320.avif",
    "fachada-de-casa-en-luque-320.webp",
    "fachada-de-casa-en-luque-640.avif",
    "fachada-de-casa-en-luque-640.webp",
    "manifest.json",
    "oficina-luque-320.avif",
    "oficina-luque-320.webp",
  ]);
  const zipManifest = JSON.parse(entries["manifest.json"].toString());
  assert.equal(zipManifest.images.length, 2);

  const setRes = await fetch(`${srv.url}api/set/oficina-luque.zip`);
  assert.equal(setRes.status, 200);
  const setEntries = readZip(Buffer.from(await setRes.arrayBuffer()));
  assert.deepEqual(Object.keys(setEntries).sort(), ["manifest.json", "oficina-luque-320.avif", "oficina-luque-320.webp"]);

  const allRes = await fetch(`${srv.url}api/all.zip`);
  assert.equal(allRes.status, 200);
  assert.ok(Object.keys(readZip(Buffer.from(await allRes.arrayBuffer()))).includes("manifest.json"));
});

test("GET /files serves converted files and refuses traversal", async () => {
  const ok = await fetch(`${srv.url}files/oficina-luque-320.webp?download`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/webp");
  assert.match(ok.headers.get("content-disposition"), /attachment/);

  const bad = await fetch(`${srv.url}files/..%2Fpackage.json`);
  assert.equal(bad.status, 404);
  const bad2 = await fetch(`${srv.url}files/manifest.txt`);
  assert.equal(bad2.status, 404);
});

test("POST /api/convert rejects unsupported types and missing prompt", async () => {
  const body = await fs.readFile(samplePng);
  const gif = await fetch(`${srv.url}api/convert?filename=x.gif&prompt=x`, { method: "POST", body });
  assert.equal(gif.status, 400);
  const noPrompt = await fetch(`${srv.url}api/convert?filename=x.png`, { method: "POST", body });
  assert.equal(noPrompt.status, 400);
  const unknownBatch = await fetch(`${srv.url}api/batch/nope.zip`);
  assert.equal(unknownBatch.status, 404);
});

test("GET / serves the UI", async () => {
  const res = await fetch(srv.url);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Drop images here/);
});

test("webimg zip CLI zips a directory and selected sets", async () => {
  const all = path.join(tmpDir, "all.zip");
  await execFileAsync("node", [cliPath, "zip", outDir, "--out", all]);
  const entries = readZip(await fs.readFile(all));
  assert.ok(Object.keys(entries).includes("manifest.json"));
  assert.ok(Object.keys(entries).includes("oficina-luque-320.avif"));

  const one = path.join(tmpDir, "one.zip");
  await execFileAsync("node", [cliPath, "zip", outDir, "--name", "oficina-luque", "--out", one]);
  assert.deepEqual(Object.keys(readZip(await fs.readFile(one))).sort(), ["oficina-luque-320.avif", "oficina-luque-320.webp"]);

  await assert.rejects(execFileAsync("node", [cliPath, "zip", outDir, "--name", "nope", "--out", path.join(tmpDir, "x.zip")]), /no image set named/);

  const { count } = await zipDirectory(outDir);
  assert.ok(count >= 7);
});
