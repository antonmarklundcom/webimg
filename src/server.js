// src/server.js — local drag-and-drop web UI: upload → convert → download one by one or as a zip.
// Binds to localhost only; nothing leaves the machine except the optional --prompt text (see naming.js).

import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { convertImage, VALID_EXTENSIONS, parseWidths, parseAr } from "./convert.js";
import { zipDirectory, createZip } from "./zip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, "ui.html");

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const MIME = {
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`upload larger than ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeBasename(name) {
  const base = path.basename(String(name || ""));
  if (!base || base === "." || base === ".." || base.includes("\0")) return null;
  return base;
}

function attachmentHeaders(filename, contentType) {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "_")}"`,
  };
}

async function readManifest(outDir) {
  try {
    const raw = await fs.readFile(path.join(outDir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.images)) parsed.images = [];
    return parsed;
  } catch {
    return { generated_at: null, images: [] };
  }
}

function entryFilePaths(outDir, entry) {
  return (entry.files || [])
    .map((f) => safeBasename(f.file))
    .filter(Boolean)
    .map((file) => ({ name: file, path: path.join(outDir, file) }))
    .filter((f) => fssync.existsSync(f.path));
}

export function openInBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best effort only
  }
}

/**
 * Starts the local server. Resolves with { server, port, url, close }.
 */
export async function startServer({
  outDir = "./assets/img",
  port = 8787,
  host = "127.0.0.1",
  widths = "640,1280,1920",
  qualityAvif = 44,
  qualityWebp = 60,
  model = "claude-sonnet-5",
  position = "attention",
  log = console.log,
} = {}) {
  const defaults = { widths, qualityAvif, qualityWebp, model, position };
  const absOut = path.resolve(outDir);
  await fs.mkdir(absOut, { recursive: true });

  // batchId -> { id, created_at, bases: string[] } (in-memory; "all.zip" covers restarts)
  const batches = new Map();
  let ui = null;

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      if (!ui || process.env.WEBIMG_DEV === "1") ui = await fs.readFile(UI_PATH, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ui);
      return;
    }

    if (req.method === "GET" && pathname === "/api/config") {
      sendJson(res, 200, {
        outDir: absOut,
        outDirRelative: path.relative(process.cwd(), absOut) || ".",
        defaults,
        namingWithLlm: Boolean(process.env.ANTHROPIC_API_KEY),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/manifest") {
      sendJson(res, 200, await readManifest(absOut));
      return;
    }

    if (req.method === "GET" && pathname === "/api/batches") {
      sendJson(res, 200, { batches: [...batches.values()] });
      return;
    }

    if (req.method === "POST" && pathname === "/api/convert") {
      const q = url.searchParams;
      const originalName = safeBasename(decodeURIComponent(q.get("filename") || "upload.png"));
      const ext = path.extname(originalName || "").toLowerCase();
      if (!originalName || !VALID_EXTENSIONS.has(ext)) {
        sendError(res, 400, `unsupported input type "${ext}" — expected .png, .jpg, .jpeg, or .webp`);
        return;
      }
      const prompt = (q.get("prompt") || "").trim();
      const name = (q.get("name") || "").trim() || undefined;
      const alt = (q.get("alt") || "").trim() || undefined;
      const ar = (q.get("ar") || "").trim() || undefined;
      const widthsParam = (q.get("widths") || "").trim() || defaults.widths;
      const pos = (q.get("position") || "").trim() || defaults.position;
      const batchId = (q.get("batch") || "").trim() || new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

      if (!prompt && !name) {
        sendError(res, 400, "a prompt (description) or an explicit name is required");
        return;
      }

      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        sendError(res, 413, err.message);
        return;
      }
      if (body.length === 0) {
        sendError(res, 400, "empty upload");
        return;
      }

      const tempPath = path.join(os.tmpdir(), `webimg-upload-${randomUUID()}${ext}`);
      try {
        parseWidths(widthsParam);
        parseAr(ar);
        await fs.writeFile(tempPath, body);
        const { entry } = await convertImage({
          input: tempPath,
          sourceLabel: originalName,
          prompt,
          name,
          alt,
          ar,
          widths: widthsParam,
          qualityAvif: defaults.qualityAvif,
          qualityWebp: defaults.qualityWebp,
          outDir, // as given on the CLI, so html_snippet paths match `webimg convert --out`
          model: defaults.model,
          position: pos,
        });

        let batch = batches.get(batchId);
        if (!batch) {
          batch = { id: batchId, created_at: new Date().toISOString(), bases: [] };
          batches.set(batchId, batch);
        }
        if (!batch.bases.includes(entry.filename_base)) batch.bases.push(entry.filename_base);

        log(`✓ ${originalName} → ${entry.filename_base} (${entry.files.length} files, batch ${batchId})`);
        sendJson(res, 200, { batch: batchId, entry });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        log(`✗ ${originalName} failed: ${message}`);
        sendError(res, 400, message);
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
      return;
    }

    // Single converted file
    let m;
    if (req.method === "GET" && (m = pathname.match(/^\/files\/([^/]+)$/))) {
      const file = safeBasename(decodeURIComponent(m[1]));
      const ext = file ? path.extname(file).toLowerCase() : "";
      if (!file || !MIME[ext]) {
        sendError(res, 404, "not found");
        return;
      }
      const filePath = path.join(absOut, file);
      try {
        const data = await fs.readFile(filePath);
        const headers = url.searchParams.has("download")
          ? attachmentHeaders(file, MIME[ext])
          : { "content-type": MIME[ext] };
        res.writeHead(200, headers);
        res.end(data);
      } catch {
        sendError(res, 404, "not found");
      }
      return;
    }

    // One image set (all widths/formats for one filename_base) as a zip
    if (req.method === "GET" && (m = pathname.match(/^\/api\/set\/([^/]+)\.zip$/))) {
      const base = decodeURIComponent(m[1]);
      const manifest = await readManifest(absOut);
      const entry = manifest.images.find((e) => e.filename_base === base);
      if (!entry) {
        sendError(res, 404, `no image set named "${base}"`);
        return;
      }
      const files = [];
      for (const item of entryFilePaths(absOut, entry)) {
        files.push({ name: item.name, data: await fs.readFile(item.path) });
      }
      files.push({
        name: "manifest.json",
        data: Buffer.from(JSON.stringify({ generated_at: manifest.generated_at, images: [entry] }, null, 2) + "\n"),
      });
      res.writeHead(200, attachmentHeaders(`${base}.zip`, "application/zip"));
      res.end(createZip(files));
      return;
    }

    // Everything converted in one upload/drop as a zip
    if (req.method === "GET" && (m = pathname.match(/^\/api\/batch\/([^/]+)\.zip$/))) {
      const id = decodeURIComponent(m[1]);
      const batch = batches.get(id);
      if (!batch) {
        sendError(res, 404, `unknown batch "${id}" (batches live in memory until the server stops — use all.zip)`);
        return;
      }
      const manifest = await readManifest(absOut);
      const entries = manifest.images.filter((e) => batch.bases.includes(e.filename_base));
      const files = [];
      for (const entry of entries) {
        for (const item of entryFilePaths(absOut, entry)) {
          files.push({ name: item.name, data: await fs.readFile(item.path) });
        }
      }
      files.push({
        name: "manifest.json",
        data: Buffer.from(JSON.stringify({ generated_at: manifest.generated_at, images: entries }, null, 2) + "\n"),
      });
      res.writeHead(200, attachmentHeaders(`webimg-${id}.zip`, "application/zip"));
      res.end(createZip(files));
      return;
    }

    // Whole output directory as a zip
    if (req.method === "GET" && pathname === "/api/all.zip") {
      const { buffer } = await zipDirectory(absOut);
      res.writeHead(200, attachmentHeaders(`${path.basename(absOut) || "webimg"}.zip`, "application/zip"));
      res.end(buffer);
      return;
    }

    sendError(res, 404, "not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = err && err.message ? err.message : String(err);
      if (!res.headersSent) sendError(res, 500, message);
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const urlStr = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/`;

  return {
    server,
    port: actualPort,
    url: urlStr,
    outDir: absOut,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
