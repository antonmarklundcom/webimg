// src/batch.js — CSV/JSON manifest parsing for batch mode.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Minimal CSV parser: header row required, handles double-quoted fields
 * (commas inside quotes, "" escapes). Trims cells. Skips blank lines and
 * lines starting with #.
 * @param {string} text
 * @returns {string[][]} rows including the header row
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // final field/row (if the file doesn't end with a newline)
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => !(r.length === 1 && r[0] === ""));
}

function rowsToObjects(rows) {
  // Skip blank lines and comment lines before the header is found.
  const filtered = rows.filter((r) => {
    const joined = r.join(",");
    if (joined.trim() === "") return false;
    if (joined.trim().startsWith("#")) return false;
    return true;
  });
  if (filtered.length === 0) return [];

  const header = filtered[0].map((h) => h.trim());
  const dataRows = filtered.slice(1);

  return dataRows.map((r) => {
    const obj = {};
    header.forEach((key, idx) => {
      const val = r[idx] !== undefined ? r[idx] : "";
      if (val !== "") obj[key] = val;
    });
    return obj;
  });
}

function normalizeRow(raw) {
  return {
    file: raw.file,
    prompt: raw.prompt,
    name: raw.name || undefined,
    alt: raw.alt || undefined,
    ar: raw.ar || undefined,
    position: raw.position || undefined,
  };
}

/**
 * @param {string} file - path to a .csv or .json manifest file
 * @returns {Promise<Array<{file: string, prompt: string, name?: string, alt?: string, ar?: string, position?: string}>>}
 */
export async function loadBatchManifest(file) {
  const ext = path.extname(file).toLowerCase();
  const raw = await fs.readFile(file, "utf8");

  if (ext === ".json") {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data.map((item) => normalizeRow(item));
    }
    // object map: { "file.png": "prompt text" } or { "file.png": { prompt, name, alt, ar, position } }
    return Object.entries(data).map(([fileName, value]) => {
      if (typeof value === "string") {
        return normalizeRow({ file: fileName, prompt: value });
      }
      return normalizeRow({ file: fileName, ...value });
    });
  }

  if (ext === ".csv") {
    const rows = parseCsv(raw);
    const objects = rowsToObjects(rows);
    return objects.map((o) => normalizeRow(o));
  }

  throw new Error(`unsupported manifest type: ${ext}`);
}
