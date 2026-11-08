// Fallback title and missing-title test (D-3, "Rules in full" > Title lookup).
// Pure and synchronous: no network lookup ever happens here.

export type LinkKind = "x" | "media" | "page";

// Same path shape as the X normalizer (L3): i/web/status, i/status, or <user>/status(es).
// `i` and `i/web` are X's own prefixes, not usernames.
const X_STATUS = /^\/(?:(i\/web|i)|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d+)(?:\/|$)/;

// A trailing token that's an id rather than a word: all digits, or a hex run of 6+ chars
// with at least one digit (Medium's `cfd6e3b6cc7d`), so words like "cafe" survive.
function isIdToken(token: string): boolean {
  if (/^\d+$/.test(token)) return true;
  return /^[0-9a-f]{6,}$/i.test(token) && /\d/.test(token);
}

function displayHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, "");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Page extensions say nothing about the page (lead ruling on PR #6).
const PAGE_EXTENSION = /\.(?:html?|shtml|php|aspx?|jsp)$/i;

function deslug(segment: string): string {
  const tokens = safeDecode(segment)
    .replace(PAGE_EXTENSION, "")
    .split(/[-_\s]+/)
    .filter((t) => t.length > 0);
  const last = tokens[tokens.length - 1];
  if (last !== undefined && isIdToken(last)) tokens.pop();
  const text = tokens.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function xTitle(url: URL): string | null {
  const m = X_STATUS.exec(url.pathname);
  if (!m) return null;
  const user = m[2];
  const id = m[3];
  return user ? `@${user} on X` : `X post ${id}`;
}

/**
 * The title a row gets when the client sent none and lookup failed. Never empty.
 * Takes the raw URL, since the canonical X form (`x.com/i/status/<id>`) drops the username.
 */
export function fallbackTitle(raw: string, kind: LinkKind): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim() || "Untitled";
  }
  const host = displayHost(url);
  if (!host) return raw.trim() || "Untitled";

  if (kind === "x") {
    const x = xTitle(url);
    if (x) return x;
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    const title = deslug(last);
    if (title) return `${title} · ${host}`;
  }
  return host;
}

function sameUrl(a: string, b: string): boolean {
  const strip = (s: string) => s.trim().replace(/\/$/, "");
  return strip(a) === strip(b);
}

/**
 * True when the client's title carries nothing: empty, whitespace, or the raw or stored
 * URL itself (the iOS share sheet from X and Mail names the item with its URL).
 */
export function isMissingTitle(title: string | undefined, raw: string, stored: string): boolean {
  const t = (title ?? "").trim();
  if (!t) return true;
  return sameUrl(t, raw) || sameUrl(t, stored);
}
