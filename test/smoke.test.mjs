// test/smoke.test.mjs — end-to-end smoke tests. Must pass with ANTHROPIC_API_KEY unset.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import sharp from "sharp";

import { slugify, validateSlug, generateNaming } from "../src/naming.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(__dirname, "tmp");
const samplePng = path.join(tmpDir, "sample.png");
const cliPath = path.join(rootDir, "webimg.mjs");

let server;
let serverPort;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/img/sample.png") {
      fssync.readFile(samplePng, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "image/png" });
        res.end(data);
      });
      return;
    }
    if (req.url === "/img/missing.png") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = server.address().port;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

before(async () => {
  // Clean and recreate test/tmp/
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  // Generate a 1600x900 fixture with a gradient / coloured rectangles.
  const width = 1600;
  const height = 900;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e3a5f"/>
          <stop offset="100%" stop-color="#f4a261"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect x="100" y="100" width="400" height="300" fill="#2a9d8f"/>
      <rect x="900" y="400" width="500" height="350" fill="#e76f51"/>
      <circle cx="800" cy="450" r="150" fill="#e9c46a"/>
    </svg>
  `;
  await sharp(Buffer.from(svg)).png().toFile(samplePng);
});

test("slugify() strips accents, punctuation, and collapses dashes", () => {
  const result = slugify("Tasación de inmuebles — Luque, Paraguay");
  assert.equal(result, "tasacion-de-inmuebles-luque-paraguay");
});

test("validateSlug() enforces format and stopword rules", () => {
  assert.equal(validateSlug("de-la-en"), false);
  assert.equal(validateSlug("calle-residencial-san-lorenzo"), true);
  assert.equal(validateSlug("Bad Slug"), false);
});

test("generateNaming() falls back to slugified prompt when no API key is set", async () => {
  const result = await generateNaming({
    prompt: "san lorenzo zone, residential street",
    model: "claude-sonnet-5",
    apiKey: undefined,
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.filename_base, "san-lorenzo-zone-residential-street");
});

test("generateNaming() falls back without throwing when the API call fails", async () => {
  const result = await generateNaming({
    prompt: "san lorenzo zone, residential street",
    model: "claude-sonnet-5",
    apiKey: "sk-ant-invalid",
    baseURL: "http://127.0.0.1:9",
  });
  assert.equal(result.source, "fallback");
  assert.ok(result.filename_base.length > 0);
});

test("convert: end-to-end CLI run produces AVIF+WebP set and manifest", async () => {
  const outDir = path.join(tmpDir, "out");
  await fs.rm(outDir, { recursive: true, force: true });

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "convert",
      samplePng,
      "--prompt",
      "san lorenzo zone, residential street",
      "--ar",
      "21:9",
      "--widths",
      "640,1280",
      "--out",
      outDir,
    ],
    { cwd: rootDir, env }
  );

  assert.ok(stdout.length > 0);

  const expectedBase = "san-lorenzo-zone-residential-street";
  const expectedFiles = [
    `${expectedBase}-640.avif`,
    `${expectedBase}-640.webp`,
    `${expectedBase}-1280.avif`,
    `${expectedBase}-1280.webp`,
  ];

  for (const file of expectedFiles) {
    const filePath = path.join(outDir, file);
    assert.ok(fssync.existsSync(filePath), `expected ${file} to exist`);

    const width = file.includes("-640.") ? 640 : 1280;
    const expectedHeight = Math.round((width * 9) / 21);

    const meta = await sharp(filePath).metadata();
    assert.equal(meta.width, width);
    assert.equal(meta.height, expectedHeight);
  }

  const manifestPath = path.join(outDir, "manifest.json");
  assert.ok(fssync.existsSync(manifestPath));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.images.length, 1);
  const image = manifest.images[0];
  assert.equal(image.files.length, 4);
  assert.ok(image.alt_text && image.alt_text.length > 0);
  for (const f of image.files) {
    assert.ok(f.kb > 0);
  }
});

test("batch: skips missing files, converts the rest, exits 0", async () => {
  const outDir2 = path.join(tmpDir, "out2");
  await fs.rm(outDir2, { recursive: true, force: true });

  const csvPath = path.join(tmpDir, "batch.csv");
  const csvContent = [
    "file,prompt",
    `sample.png,"san lorenzo zone, residential street"`,
    "missing-file.png,\"a file that does not exist\"",
  ].join("\n");
  await fs.writeFile(csvPath, csvContent, "utf8");

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const { stdout, code } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, "batch", tmpDir, "--manifest", csvPath, "--widths", "640", "--out", outDir2],
      { cwd: rootDir, env },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error ? error.code : 0 });
      }
    );
  });

  assert.equal(code, 0);
  assert.match(stdout, /Done: 1 converted, 1 skipped, 0 failed/);

  const expectedBase = "san-lorenzo-zone-residential-street";
  assert.ok(fssync.existsSync(path.join(outDir2, `${expectedBase}-640.avif`)));
  assert.ok(fssync.existsSync(path.join(outDir2, `${expectedBase}-640.webp`)));

  const manifestPath = path.join(outDir2, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.images.length, 1);
});

test("convert: rejects a .txt input with exit code 1", async () => {
  const txtPath = path.join(tmpDir, "not-an-image.txt");
  await fs.writeFile(txtPath, "hello", "utf8");

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const code = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, "convert", txtPath, "--prompt", "irrelevant"],
      { cwd: rootDir, env },
      (error) => {
        resolve(error ? error.code : 0);
      }
    );
  });

  assert.equal(code, 1);
});

test("convert: accepts an http(s) URL as input, cleans up its temp file", async () => {
  const outDir = path.join(tmpDir, "out-url");
  await fs.rm(outDir, { recursive: true, force: true });

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const url = `http://127.0.0.1:${serverPort}/img/sample.png`;

  const tmpBefore = await fs.readdir(os.tmpdir());
  const forgeTmpBefore = tmpBefore.filter((f) => f.startsWith("webimg-"));

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "convert",
      url,
      "--prompt",
      "vista aerea de asuncion",
      "--widths",
      "640",
      "--out",
      outDir,
    ],
    { cwd: rootDir, env }
  );

  assert.ok(stdout.length > 0);

  const expectedBase = "vista-aerea-de-asuncion";
  const expectedFiles = [`${expectedBase}-640.avif`, `${expectedBase}-640.webp`];
  for (const file of expectedFiles) {
    assert.ok(fssync.existsSync(path.join(outDir, file)), `expected ${file} to exist`);
  }

  const manifestPath = path.join(outDir, "manifest.json");
  assert.ok(fssync.existsSync(manifestPath));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const image = manifest.images.find((img) => img.filename_base === expectedBase);
  assert.ok(image, "expected manifest entry for the URL-sourced image");
  assert.equal(image.source, url);
  assert.equal(image.filename_base, expectedBase);

  const tmpAfter = await fs.readdir(os.tmpdir());
  const forgeTmpAfter = tmpAfter.filter((f) => f.startsWith("webimg-"));
  assert.deepEqual(forgeTmpAfter, forgeTmpBefore, "expected no leftover webimg-* temp files");
});

test("convert: a URL returning 404 exits 1", async () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const url = `http://127.0.0.1:${serverPort}/img/missing.png`;

  const code = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, "convert", url, "--prompt", "irrelevant"],
      { cwd: rootDir, env },
      (error) => {
        resolve(error ? error.code : 0);
      }
    );
  });

  assert.equal(code, 1);
});
