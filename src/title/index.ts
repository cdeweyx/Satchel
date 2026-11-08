// Title lookup dispatch (D-3, "Rules in full" > Title lookup). Picks the lookup by link
// kind: X by post id, media by oEmbed then the page (lead ruling R1: TikTok's oEmbed no
// longer returns a title, so a null from oEmbed falls through to the crawler-UA page read),
// pages by HTMLRewriter. Returns the raw result; title hygiene happens in enrich (R2).
// Never throws, and never outlives `signal`: an abort resolves as a fallback result even
// when a fetch underneath ignores it.

import type { LinkKind } from "../fallback-title";
import { lookupMedia } from "./media";
import { lookupPage } from "./page";
import { lookupX } from "./x";

export type LookupResult = {
  title: string | null;
  description?: string;
  author?: string;
  handle?: string;
  url?: string;
  source: "client" | "x-oembed" | "x-twitterbot" | "media-oembed" | "page" | "fallback";
  article?: true; // SAT-45: an X Article's title, from lookupX (see XTitle)
  bytesRead: number;
};

const FALLBACK: LookupResult = { title: null, source: "fallback", bytesRead: 0 };

// The stored X form from canonicalize(): https://x.com/i/status/<id>.
const X_STORED = /^https:\/\/x\.com\/i\/status\/(\d+)$/;

async function dispatch(stored: string, kind: LinkKind, signal: AbortSignal): Promise<LookupResult> {
  if (kind === "x") {
    const id = X_STORED.exec(stored)?.[1];
    if (!id) return FALLBACK;
    const x = await lookupX(id, signal);
    return x ?? FALLBACK;
  }
  if (kind === "media") {
    const media = await lookupMedia(stored, signal);
    if (media) return media;
    if (signal.aborted) return FALLBACK;
  }
  const page = await lookupPage(stored, signal);
  return page ?? FALLBACK;
}

export async function lookupTitle(
  storedUrl: string,
  kind: LinkKind,
  signal: AbortSignal,
): Promise<LookupResult> {
  if (signal.aborted) return FALLBACK;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<LookupResult>((resolve) => {
    onAbort = () => resolve(FALLBACK);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([dispatch(storedUrl, kind, signal).catch(() => FALLBACK), aborted]);
  } catch {
    return FALLBACK;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
