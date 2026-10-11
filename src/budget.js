// src/budget.js — per-width file-size budgets and the quality step-down used to meet them.

/**
 * Default budgets in KB per output width, applied to both AVIF and WebP.
 * Between the listed widths the budget is interpolated linearly; outside, clamped.
 * 1280w ≤ 120 KB is the number Anton's sites are tuned for (AVIF usually lands at 20–60 KB).
 */
export const DEFAULT_BUDGET_POINTS = [
  [320, 35],
  [640, 60],
  [960, 90],
  [1280, 120],
  [1600, 160],
  [1920, 200],
  [2560, 280],
];

export const DEFAULT_OG_BUDGET_KB = 200;

/** Lowest quality the step-down may reach; below this the image is visibly worse than a few extra KB. */
export const QUALITY_FLOOR = { avif: 28, webp: 40, jpg: 60 };
export const QUALITY_STEP = 4;

function interpolate(points, width) {
  if (width <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (width >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [w0, kb0] = points[i - 1];
    const [w1, kb1] = points[i];
    if (width <= w1) {
      const t = (width - w0) / (w1 - w0);
      return Math.round(kb0 + t * (kb1 - kb0));
    }
  }
  return last[1];
}

/**
 * Parses --max-kb.
 *   undefined / "" / "default" → defaults
 *   "off" / "0" / "none"       → null (no budgets)
 *   "120"                      → 120 KB for every width
 *   "640:60,1280:120,og:200"   → per-width map, unknown widths interpolated from the defaults
 * @returns {{ forWidth: (w:number)=>number|null, og: number|null, label: string } | null}
 */
export function parseMaxKb(value) {
  if (value === undefined || value === null || value === "" || value === "default") {
    return {
      forWidth: (w) => interpolate(DEFAULT_BUDGET_POINTS, w),
      og: DEFAULT_OG_BUDGET_KB,
      label: "default",
    };
  }
  const s = String(value).trim().toLowerCase();
  if (s === "off" || s === "none" || s === "0") return null;

  if (/^\d+(\.\d+)?$/.test(s)) {
    const kb = Number(s);
    return { forWidth: () => kb, og: kb, label: `${kb} KB` };
  }

  const map = new Map();
  let og = DEFAULT_OG_BUDGET_KB;
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(og|\d+)\s*[:=]\s*(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`invalid --max-kb entry "${part}" (use 120, 640:60,1280:120, og:200, or off)`);
    if (m[1] === "og") og = Number(m[2]);
    else map.set(Number(m[1]), Number(m[2]));
  }
  if (map.size === 0 && og === DEFAULT_OG_BUDGET_KB) {
    throw new Error(`invalid --max-kb value "${value}"`);
  }
  const custom = [...map.entries()].sort((a, b) => a[0] - b[0]);
  return {
    forWidth: (w) => (map.has(w) ? map.get(w) : interpolate(custom.length ? custom : DEFAULT_BUDGET_POINTS, w)),
    og,
    label: String(value),
  };
}

/**
 * Encodes with `encode(quality)` repeatedly, lowering quality by QUALITY_STEP until the
 * result is within `budgetKb` or the floor is reached. Returns the last attempt.
 *
 * @param {object} opts
 * @param {(quality:number)=>Promise<{size:number}&Record<string,any>>} opts.encode
 * @param {number} opts.startQuality
 * @param {number|null} opts.budgetKb - null disables the loop
 * @param {"avif"|"webp"|"jpg"} opts.format
 * @returns {Promise<{ info: object, quality: number, overBudget: boolean, attempts: number }>}
 */
export async function encodeWithinBudget({ encode, startQuality, budgetKb, format }) {
  const floor = QUALITY_FLOOR[format] ?? 30;
  let quality = startQuality;
  let attempts = 0;
  let info = await encode(quality);
  attempts++;
  if (budgetKb === null || budgetKb === undefined) {
    return { info, quality, overBudget: false, attempts };
  }
  const limit = budgetKb * 1024;
  while (info.size > limit && quality - QUALITY_STEP >= floor) {
    quality -= QUALITY_STEP;
    info = await encode(quality);
    attempts++;
  }
  return { info, quality, overBudget: info.size > limit, attempts };
}
