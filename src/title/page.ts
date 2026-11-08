// Page title lookup (D-3, "Rules in full" > Title lookup, pages). Fetches the stored URL
// with a link-preview crawler UA, parses the head with HTMLRewriter, and stops reading at
// `</head>` or 256 KB, whichever comes first (L3: crawler UA wins on Spotify, TikTok, NYT).
// Never throws: any failure (non-2xx, non-HTML, network error, timeout) returns null.
// SAT-48: the same read also picks up the preview image (og:image, else twitter:image).

import { httpsUrl } from "../preview";

export type PageLookup = {
  title: string | null;
  description?: string;
  image?: string;
  source: "page";
  bytesRead: number;
};

export const PAGE_UA =
  "Mozilla/5.0 (compatible; Satchel/0.1; +https://github.com/cdeweyx/Satchel) facebookexternalhit/1.1";
const HEADERS = {
  "User-Agent": PAGE_UA,
  Accept: "text/html,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const TIMEOUT_MS = 4000;
export const READ_CAP = 256 * 1024;
const DESCRIPTION_TITLE_CHARS = 80;

// What the handlers saw. Raw text: lol-html leaves entities encoded in text and attributes.
type Head = {
  title: string;
  titleDone: boolean;
  ogTitle?: string;
  description?: string;
  ogDescription?: string;
  ogImage?: string;
  twitterImage?: string;
  headEnded: boolean;
};

export async function lookupPage(stored: string, signal: AbortSignal): Promise<PageLookup | null> {
  let res: Response;
  try {
    res = await fetch(stored, {
      headers: HEADERS,
      redirect: "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch {
    return null;
  }
  try {
    if (!res.ok || !isHtml(res.headers.get("content-type")) || !res.body) {
      // Release the connection without reading a byte of the body.
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const { head, bytesRead } = await readHead(res);
    // Relative images resolve against where the page ended up after redirects.
    return pick(head, bytesRead, res.url || stored);
  } catch {
    await res.body?.cancel().catch(() => {});
    return null;
  }
}

function isHtml(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.split(";")[0]!.trim().toLowerCase() === "text/html";
}

async function readHead(res: Response): Promise<{ head: Head; bytesRead: number }> {
  const head: Head = { title: "", titleDone: false, headEnded: false };
  const source = res.body!.getReader();
  let bytesRead = 0;
  const enough = () => head.headEnded || bytesRead >= READ_CAP;

  // Pull-driven feed: a source chunk is read only when HTMLRewriter asks for one, so once
  // `</head>` or the cap is reached no further body bytes are pulled off the network.
  const feed = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (enough()) {
          await source.cancel().catch(() => {});
          controller.close();
          return;
        }
        const chunk = await source.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        bytesRead += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return source.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  const rewritten = new HTMLRewriter()
    .on("title", {
      text(text) {
        if (head.titleDone) return;
        head.title += text.text;
        if (text.lastInTextNode) head.titleDone = true;
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        head.ogTitle ??= nonBlank(el.getAttribute("content"));
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        head.description ??= nonBlank(el.getAttribute("content"));
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        head.ogDescription ??= nonBlank(el.getAttribute("content"));
      },
    })
    .on('meta[property="og:image"]', {
      element(el) {
        head.ogImage ??= nonBlank(el.getAttribute("content"));
      },
    })
    .on('meta[name="twitter:image"]', {
      element(el) {
        head.twitterImage ??= nonBlank(el.getAttribute("content"));
      },
    })
    .on('meta[property="twitter:image"]', {
      element(el) {
        head.twitterImage ??= nonBlank(el.getAttribute("content"));
      },
    })
    .on("head", {
      element(el) {
        el.onEndTag(() => {
          head.headEnded = true;
        });
      },
    })
    .transform(
      new Response(feed, { headers: { "content-type": res.headers.get("content-type")! } }),
    );

  // Drive the rewriter by reading its output; HTMLRewriter has no early abort of its own.
  const reader = rewritten.body!.getReader();
  for (;;) {
    if (enough()) {
      await reader.cancel().catch(() => {});
      break;
    }
    const { done } = await reader.read();
    if (done) break;
  }
  // Cancelling the rewriter's output doesn't reach its input, so cancel the network body
  // ourselves (a no-op when it already ended).
  await source.cancel().catch(() => {});
  return { head, bytesRead };
}

function nonBlank(value: string | null): string | undefined {
  return value && value.trim() ? value : undefined;
}

// og:title, then <title>, then the description's first 80 chars, then null. Each candidate is
// entity-decoded and whitespace-collapsed; an all-whitespace one falls through. The image is
// og:image, else twitter:image, entity-decoded, resolved against `base`, https: only.
function pick(head: Head, bytesRead: number, base: string): PageLookup {
  const description = clean(head.ogDescription) ?? clean(head.description);
  const title =
    clean(head.ogTitle) ??
    clean(head.title) ??
    (description ? Array.from(description).slice(0, DESCRIPTION_TITLE_CHARS).join("").trim() : null);
  const image = pageImage(head.ogImage, base) ?? pageImage(head.twitterImage, base);
  return {
    title,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    source: "page",
    bytesRead,
  };
}

function pageImage(raw: string | undefined, base: string): string | null {
  return raw === undefined ? null : httpsUrl(decodeEntities(raw), base);
}

function clean(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return text ? text : null;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

// One pass, so `&amp;lt;` decodes to `&lt;`, not `<`. Unknown names stay as written.
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}
