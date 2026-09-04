// src/naming.js — LLM-assisted filename/alt-text generation with a slugify fallback.
// generateNaming() must NEVER throw. Every failure path falls back to a slugified prompt.

import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You name image files for Spanish-language local-business and real-estate websites in Paraguay. Given a short description of an image, return JSON with:
- filename_base: an SEO slug in lowercase kebab-case, ASCII only (strip accents: ñ→n, á→a), 3–8 words, keyword-rich (service or subject + place when a place is given), no stopwords-only slugs, no numbers unless part of a name, no file extension, no width suffix. Example: "tasacion-de-inmuebles-luque", "calle-residencial-san-lorenzo".
- alt_text: a natural descriptive Spanish sentence (8–20 words) describing what is visible in the image for a screen reader, including the place if given. No "imagen de"/"foto de" prefix. Proper Spanish accents are fine here.`;

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "en", "y", "a", "con", "para",
  "por", "un", "una", "the", "of", "in", "and", "on", "at", "to", "for",
]);

/**
 * NFD-normalize, strip combining marks, lowercase, replace non [a-z0-9] runs
 * with "-", trim/collapse dashes, cap at 80 chars (cut on a dash boundary).
 */
export function slugify(text) {
  if (!text) return "";
  let s = String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks (accents)
    .toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  s = s.replace(/-{2,}/g, "-");
  if (s.length > 80) {
    s = s.slice(0, 80);
    const lastDash = s.lastIndexOf("-");
    if (lastDash > 0) s = s.slice(0, lastDash);
    s = s.replace(/-+$/g, "");
  }
  return s;
}

/**
 * Slug must be lowercase kebab-case, length 3–80, and contain at least one
 * token that is not in the stopword list.
 */
export function validateSlug(slug) {
  if (typeof slug !== "string") return false;
  if (slug.length < 3 || slug.length > 80) return false;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return false;
  const tokens = slug.split("-");
  return tokens.some((t) => !STOPWORDS.has(t));
}

function fallbackNaming(prompt, inputBasename) {
  let base = slugify(prompt);
  if (!base || !validateSlug(base)) {
    base = slugify(inputBasename || "");
  }
  if (!base || !validateSlug(base)) {
    base = "imagen";
  }
  return {
    filename_base: base,
    alt_text: (prompt || "").trim() || (inputBasename || "imagen"),
    source: "fallback",
  };
}

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.model
 * @param {string|undefined} opts.apiKey
 * @param {string} [opts.inputBasename] - used as a secondary fallback source for the slug
 * @param {string} [opts.baseURL] - optional override, mainly for tests
 * @returns {Promise<{filename_base: string, alt_text: string, source: 'llm'|'fallback'}>}
 */
export async function generateNaming({ prompt, model, apiKey, inputBasename, baseURL }) {
  if (!apiKey) {
    console.log("ℹ ANTHROPIC_API_KEY not set — using slug fallback");
    return fallbackNaming(prompt, inputBasename);
  }

  try {
    const client = new Anthropic({
      apiKey,
      maxRetries: 2,
      timeout: 30_000,
      ...(baseURL ? { baseURL } : {}),
    });

    const res = await client.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              filename_base: { type: "string" },
              alt_text: { type: "string" },
            },
            required: ["filename_base", "alt_text"],
            additionalProperties: false,
          },
        },
      },
    });

    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("no text block in response");
    const parsed = JSON.parse(textBlock.text);

    let slug = parsed.filename_base;
    if (!validateSlug(slug)) {
      slug = slugify(slug);
      if (!validateSlug(slug)) {
        throw new Error("invalid slug returned by model");
      }
    }

    const altText = typeof parsed.alt_text === "string" && parsed.alt_text.trim()
      ? parsed.alt_text.trim()
      : (prompt || "").trim();

    return { filename_base: slug, alt_text: altText, source: "llm" };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.log(`⚠ naming via API failed (${reason}) — using slug fallback`);
    return fallbackNaming(prompt, inputBasename);
  }
}
