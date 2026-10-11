// src/upload.js — push a converted image folder to where the site serves it from.
//
// Targets:
//   r2    Cloudflare R2 through the S3 API (@aws-sdk/client-s3). Credentials only from env.
//   dir   A folder inside a git-deployed site repo (Hostinger git deploys): copy, then commit.
//   sftp  Hostinger (or any) SFTP account for sites that are not deployed from git.
//
// Secrets are never printed, logged or written anywhere; only their presence is reported.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import { hashFile } from "./hash.js";
import { readManifest } from "./manifest.js";

export const CONTENT_TYPES = {
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const MANIFEST_CACHE = "public, max-age=300, must-revalidate";

export const R2_ENV = {
  accountId: "R2_ACCOUNT_ID",
  accessKeyId: "R2_ACCESS_KEY_ID",
  secretAccessKey: "R2_SECRET_ACCESS_KEY",
  bucket: "R2_BUCKET",
  endpoint: "R2_ENDPOINT",
};

export const SFTP_ENV = {
  host: "SFTP_HOST",
  port: "SFTP_PORT",
  user: "SFTP_USER",
  password: "SFTP_PASSWORD",
  keyPath: "SFTP_KEY_PATH",
  passphrase: "SFTP_KEY_PASSPHRASE",
};

function joinPosix(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => String(p).replace(/\\/g, "/"))
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/$/, "");
}

/**
 * Lists the files to upload from `dir`: images (and manifest.json when asked),
 * optionally limited to the sets named in --name (looked up in manifest.json).
 * @returns {Promise<Array<{ local: string, name: string, bytes: number, contentType: string, cacheControl: string }>>}
 */
export async function planUpload(dir, { names, includeManifest = false } = {}) {
  const absDir = path.resolve(dir);
  if (!fssync.existsSync(absDir)) throw new Error(`${dir} does not exist`);

  let only = null;
  if (names && names.length) {
    const manifest = await readManifest(absDir);
    only = new Set();
    for (const base of names) {
      const entry = manifest.images.find((e) => e.filename_base === base);
      if (!entry) throw new Error(`no image set named "${base}" in ${path.join(dir, "manifest.json")}`);
      for (const f of entry.files || []) only.add(f.file);
    }
  }

  const files = [];
  const walk = async (current, rel) => {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const relName = joinPosix(rel, item.name);
      if (item.isDirectory()) {
        await walk(path.join(current, item.name), relName);
        continue;
      }
      const ext = path.extname(item.name).toLowerCase();
      const isManifest = item.name === "manifest.json";
      if (isManifest && !includeManifest) continue;
      if (!isManifest && !CONTENT_TYPES[ext]) continue;
      if (!isManifest && ext === ".json") continue;
      if (only && !isManifest && !only.has(item.name)) continue;
      const stat = await fs.stat(path.join(current, item.name));
      files.push({
        local: path.join(current, item.name),
        name: relName,
        bytes: stat.size,
        contentType: CONTENT_TYPES[ext],
        cacheControl: isManifest ? MANIFEST_CACHE : IMMUTABLE_CACHE,
      });
    }
  };
  await walk(absDir, "");
  return files;
}

/** Reports which env vars are set without revealing their values. */
export function describeEnv(map) {
  const out = {};
  for (const [key, envName] of Object.entries(map)) {
    out[key] = { env: envName, set: Boolean(process.env[envName] && String(process.env[envName]).length > 0) };
  }
  return out;
}

export function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------- dir target

/**
 * Copies the planned files into `dest` (e.g. <site repo>/assets/img). Skips identical files.
 */
export async function uploadToDir(files, { dest, prefix = "", dryRun = false, log = console.log }) {
  if (!dest) throw new Error("--dest <folder> is required for --to dir");
  const absDest = path.resolve(dest);
  let copied = 0;
  let skipped = 0;
  for (const f of files) {
    const target = path.join(absDest, prefix, f.name);
    let same = false;
    if (fssync.existsSync(target)) {
      const [a, b] = await Promise.all([hashFile(f.local), hashFile(target)]);
      same = a === b;
    }
    if (same) {
      skipped++;
      log(`= ${path.relative(process.cwd(), target) || target}  unchanged`);
      continue;
    }
    if (dryRun) {
      log(`→ ${path.relative(process.cwd(), target) || target}  ${formatKb(f.bytes)}  (dry run)`);
      copied++;
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(f.local, target);
    copied++;
    log(`✓ ${path.relative(process.cwd(), target) || target}  ${formatKb(f.bytes)}`);
  }
  return { copied, skipped, dest: absDest };
}

// ----------------------------------------------------------------- r2 target

/**
 * Creates the S3 client for R2 from env vars. Never returns or logs the secret.
 */
export async function createR2Client({ endpoint } = {}) {
  const accountId = process.env[R2_ENV.accountId];
  const accessKeyId = process.env[R2_ENV.accessKeyId];
  const secretAccessKey = process.env[R2_ENV.secretAccessKey];
  const resolvedEndpoint = endpoint || process.env[R2_ENV.endpoint] || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  const missing = [];
  if (!accessKeyId) missing.push(R2_ENV.accessKeyId);
  if (!secretAccessKey) missing.push(R2_ENV.secretAccessKey);
  if (!resolvedEndpoint) missing.push(`${R2_ENV.accountId} (or ${R2_ENV.endpoint})`);
  if (missing.length) {
    throw new Error(`R2 credentials missing from the environment: ${missing.join(", ")}. Set them as env vars; webimg never reads them from files or flags.`);
  }
  let mod;
  try {
    mod = await import("@aws-sdk/client-s3");
  } catch {
    throw new Error("@aws-sdk/client-s3 is not installed; run npm install in the webimg folder");
  }
  const { S3Client } = mod;
  const client = new S3Client({
    region: "auto",
    endpoint: resolvedEndpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, mod, endpointHost: new URL(resolvedEndpoint).host };
}

/**
 * Uploads the planned files to R2. Objects already present with the same sha256
 * (stored as x-amz-meta-sha256) are skipped; `force` re-uploads everything.
 */
export async function uploadToR2(files, { bucket, prefix = "", endpoint, dryRun = false, force = false, log = console.log, clientOverride } = {}) {
  const resolvedBucket = bucket || process.env[R2_ENV.bucket];
  if (!resolvedBucket) throw new Error(`--bucket <name> (or ${R2_ENV.bucket}) is required for --to r2`);

  const keys = files.map((f) => ({ ...f, key: joinPosix(prefix, f.name) }));

  if (dryRun) {
    const env = describeEnv(R2_ENV);
    const have = Object.values(env).filter((e) => e.set).map((e) => e.env);
    log(`ℹ dry run: ${keys.length} files → r2://${resolvedBucket}/${prefix ? prefix + "/" : ""}  (env set: ${have.length ? have.join(", ") : "none"})`);
    for (const f of keys) {
      log(`→ ${f.key}  ${formatKb(f.bytes)}  ${f.contentType}  Cache-Control: ${f.cacheControl}`);
    }
    return { uploaded: 0, skipped: 0, planned: keys.length, bucket: resolvedBucket };
  }

  const { client, mod } = clientOverride || (await createR2Client({ endpoint }));
  const { PutObjectCommand, HeadObjectCommand } = mod;

  let uploaded = 0;
  let skipped = 0;
  for (const f of keys) {
    const sha = (await hashFile(f.local)).replace(/^sha256:/, "");
    if (!force) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: resolvedBucket, Key: f.key }));
        const remoteSha = head.Metadata && (head.Metadata.sha256 || head.Metadata["sha256"]);
        if (remoteSha === sha && Number(head.ContentLength) === f.bytes) {
          skipped++;
          log(`= ${f.key}  unchanged`);
          continue;
        }
      } catch (err) {
        const status = err && err.$metadata && err.$metadata.httpStatusCode;
        if (status && status !== 404 && status !== 403) throw err;
        // 404 = not there yet; 403 = no HEAD permission, just upload.
      }
    }
    const body = await fs.readFile(f.local);
    await client.send(
      new PutObjectCommand({
        Bucket: resolvedBucket,
        Key: f.key,
        Body: body,
        ContentType: f.contentType,
        CacheControl: f.cacheControl,
        Metadata: { sha256: sha },
      })
    );
    uploaded++;
    log(`✓ ${f.key}  ${formatKb(f.bytes)}  ${f.contentType}`);
  }
  return { uploaded, skipped, planned: keys.length, bucket: resolvedBucket };
}

// --------------------------------------------------------------- sftp target

/**
 * Uploads the planned files over SFTP. Host/user/password or key come from env only.
 */
export async function uploadToSftp(files, { remoteDir, dryRun = false, log = console.log, clientOverride } = {}) {
  if (!remoteDir) throw new Error("--remote-dir </home/u123/domains/site/public_html/assets/img> is required for --to sftp");
  const host = process.env[SFTP_ENV.host];
  const user = process.env[SFTP_ENV.user];
  const password = process.env[SFTP_ENV.password];
  const keyPath = process.env[SFTP_ENV.keyPath];
  const port = Number(process.env[SFTP_ENV.port] || 22);
  const remote = remoteDir.replace(/\\/g, "/").replace(/\/$/, "");

  if (dryRun) {
    const env = describeEnv(SFTP_ENV);
    const have = Object.values(env).filter((e) => e.set).map((e) => e.env);
    log(`ℹ dry run: ${files.length} files → sftp://${user ? "<user>@" : ""}${host || "<" + SFTP_ENV.host + ">"}:${port}${remote}  (env set: ${have.length ? have.join(", ") : "none"})`);
    for (const f of files) log(`→ ${remote}/${f.name}  ${formatKb(f.bytes)}`);
    return { uploaded: 0, planned: files.length };
  }

  const missing = [];
  if (!host) missing.push(SFTP_ENV.host);
  if (!user) missing.push(SFTP_ENV.user);
  if (!password && !keyPath) missing.push(`${SFTP_ENV.password} or ${SFTP_ENV.keyPath}`);
  if (missing.length) throw new Error(`SFTP credentials missing from the environment: ${missing.join(", ")}`);

  let client = clientOverride;
  if (!client) {
    let mod;
    try {
      mod = await import("ssh2-sftp-client");
    } catch {
      throw new Error("ssh2-sftp-client is not installed; run npm install in the webimg folder");
    }
    const Client = mod.default || mod;
    client = new Client();
    const connect = { host, port, username: user };
    if (keyPath) {
      connect.privateKey = await fs.readFile(keyPath);
      if (process.env[SFTP_ENV.passphrase]) connect.passphrase = process.env[SFTP_ENV.passphrase];
    } else {
      connect.password = password;
    }
    await client.connect(connect);
  }

  let uploaded = 0;
  try {
    const dirs = new Set();
    for (const f of files) {
      const remotePath = `${remote}/${f.name}`;
      const parent = remotePath.slice(0, remotePath.lastIndexOf("/"));
      if (!dirs.has(parent)) {
        await client.mkdir(parent, true).catch(() => {});
        dirs.add(parent);
      }
      await client.put(f.local, remotePath);
      uploaded++;
      log(`✓ ${remotePath}  ${formatKb(f.bytes)}`);
    }
  } finally {
    if (!clientOverride && client && client.end) await client.end().catch(() => {});
  }
  return { uploaded, planned: files.length };
}
