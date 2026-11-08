// SAT-48: the one block a new row's page body gets, so the Notion gallery card shows the
// article's preview image or, failing that, its summary. Pure: lookup result in, block out.
// The background task appends it (enrich.ts); SAT-49's backfill imports it unchanged.

import { type BodyBlock, imageBlock, paragraphBlock } from "./notion";
import type { LookupResult } from "./title";

const MAX_URL = 2000; // Notion's URL limit; a longer image URL is no image
export const SUMMARY_CHARS = 300;

// `raw` resolved against `base` (when given) to an absolute URL, kept only when it's https:.
// Callers pass `raw` already entity-decoded. Null for anything else.
export function httpsUrl(raw: string | null | undefined, base?: string): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text, base);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// X's post photos live at pbs.twimg.com/media/…; avatars (profile_images), video thumbs and
// X's default card (abs.twimg.com) don't count.
export function isXPostMedia(url: string | null | undefined): boolean {
  const u = httpsUrl(url);
  if (!u) return false;
  const { hostname, pathname } = new URL(u);
  return hostname === "pbs.twimg.com" && pathname.startsWith("/media/");
}

// Whitespace collapsed; past `max` code points, cut at the last word boundary and end in "…".
export function summary(text: string, max = SUMMARY_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max + 1).join("");
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : chars.slice(0, max).join("");
  return `${cut.replace(/[\s,;:.–—-]+$/, "")}…`;
}

/**
 * The block for a lookup, or null when there's nothing to add. An https image (og:image,
 * twitter:image, oEmbed thumbnail_url, or an X post's own photo) is an external image block.
 * Else a page's description (og:description, else meta description) is one paragraph, cut to
 * about 300 characters. X posts never get a paragraph: no photo, no block.
 */
export function previewBlock(lookup: LookupResult): BodyBlock | null {
  const image = httpsUrl(lookup.image);
  if (image && image.length <= MAX_URL) return imageBlock(image);
  if (lookup.source !== "page") return null;
  const text = lookup.description ? summary(lookup.description) : "";
  return text ? paragraphBlock(text) : null;
}
