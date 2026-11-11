// SAT-48: the one block a new row's page body gets, so the Notion gallery card shows the
// article's preview image or, failing that, its summary. Pure: lookup result in, block out.
// The background task appends it (enrich.ts).
// SAT-52: an X post with no photo gets its post text instead, links stripped.
// SAT-58: a page whose lookup has no image falls back to what the Chrome extension read from
// the open tab (clientPreviewBlock; the order is bodyBlock's in enrich.ts).

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

// An image URL the body can use: absolute https, at most 2000 characters. Null otherwise.
export function usableImage(raw: string | null | undefined): string | null {
  const image = httpsUrl(raw);
  return image && image.length <= MAX_URL ? image : null;
}

// X's post photos live at pbs.twimg.com/media/…; avatars (profile_images), video thumbs and
// X's default card (abs.twimg.com) don't count.
export function isXPostMedia(url: string | null | undefined): boolean {
  const u = httpsUrl(url);
  if (!u) return false;
  const { hostname, pathname } = new URL(u);
  return hostname === "pbs.twimg.com" && pathname.startsWith("/media/");
}

/**
 * A link as X shows it in post text, as a regex source: a full URL (t.co or any other), a
 * pic.twitter.com media link, or one of `links`, the display URLs X anchored in the oEmbed
 * html (lookupX's `links`, like "box.com/blog/ai-agents-a…"). SAT-55: a display URL is a link
 * only when X anchored it, never from its shape, so "Node.js/Deno" stays text. Each match runs
 * to the end of its token. Shared with isOnlyLinks in title/x.ts (SAT-37).
 */
export function xLinkPattern(links: readonly string[] = []): string {
  const anchored = links.filter((l) => l.trim() !== "").map((l) => `${escapeRegExp(l.trim())}\\S*`);
  return `(?:${[String.raw`https?:\/\/\S+`, String.raw`pic\.twitter\.com\/\S+`, ...anchored].join("|")})`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// SAT-52: an X post's text for its page body: every link (a whole whitespace-separated token,
// see xLinkPattern) removed, whitespace collapsed, trimmed. "" when what's left has no letter
// or digit (only links, or links plus punctuation or emoji, like "— https://t.co/a" or
// "👇 https://t.co/a").
export function xPostText(text: string | null | undefined, links?: readonly string[]): string {
  const token = new RegExp(`(?<!\\S)${xLinkPattern(links)}`, "gi");
  const clean = (text ?? "").replace(token, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : "";
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
 * about 300 characters. SAT-52: an X post with no photo is one paragraph of its post text
 * (`description`, the text Claude titles from; an X Article's title for an Article) with its
 * links (SAT-55: including the display URLs in `links`) stripped, cut the same way. A post that's only links gets nothing. Media oEmbed never
 * gets a paragraph.
 */
export function previewBlock(lookup: LookupResult): BodyBlock | null {
  const image = usableImage(lookup.image);
  if (image) return imageBlock(image);
  const isX = lookup.source === "x-oembed" || lookup.source === "x-twitterbot";
  if (lookup.source !== "page" && !isX) return null;
  const raw = isX ? xPostText(lookup.description, lookup.links) : (lookup.description ?? "");
  const text = raw ? summary(raw) : "";
  return text ? paragraphBlock(text) : null;
}

/**
 * SAT-58: the block from what the Chrome extension read off the open tab (save.ts already
 * cleaned both), for a page whose own lookup has no image. The same rules as a page lookup:
 * an image block for a usable image, else one summary paragraph of the description, else null.
 */
export function clientPreviewBlock(image: string | undefined, description: string | undefined): BodyBlock | null {
  const url = usableImage(image);
  if (url) return imageBlock(url);
  const text = description ? summary(description) : "";
  return text ? paragraphBlock(text) : null;
}
