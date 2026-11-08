// X post title lookup (D-3, "Rules in full" > Title lookup, research 03).
// oEmbed at publish.x.com first, then x.com's own page read as Twitterbot. Two sources
// only: when both fail the caller uses the `X post <id>` fallback title. SAT-43: when
// oEmbed's post text is only links (an X Article), the same Twitterbot page supplies it.
// Never throws: any failure (network, abort, timeout, bad status, wrong content type,
// unexpected shape) returns null, because the save path relies on it (SAT-12).

export type XTitle = {
  title: string;
  url?: string;
  description?: string;
  author?: string;
  handle?: string;
  source: "x-oembed" | "x-twitterbot";
  bytesRead: number;
};

const FETCH_TIMEOUT_MS = 4000;
// The x.com page is ~51 KB and its og tags sit in <head>; never read past this.
const PAGE_CAP_BYTES = 256 * 1024;
const TWITTERBOT_UA = "Twitterbot/1.0";

function oembedUrl(id: string): string {
  const u = new URL("https://publish.x.com/oembed");
  u.searchParams.set("url", `https://x.com/i/status/${id}`);
  u.searchParams.set("omit_script", "true");
  u.searchParams.set("dnt", "true");
  return u.toString();
}

function contentType(res: Response): string {
  return (res.headers.get("content-type") ?? "").toLowerCase();
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to free.
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function fromCodePoint(n: number, original: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return original;
  return String.fromCodePoint(n);
}

// Enough for what X emits: the five XML entities, nbsp, and numeric references.
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10), match);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// Inner text of the first <p> in oEmbed's html: <br> becomes a newline, other tags
// (the t.co <a> links) are dropped but their text kept, then entities are decoded.
// Tags go before entities so an escaped `&lt;b&gt;` in the post survives as text.
function firstParagraphText(html: string): string {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!m || m[1] === undefined) return "";
  const text = m[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
  return decodeEntities(text).trim();
}

function handleFromAuthorUrl(authorUrl: unknown): string | undefined {
  if (typeof authorUrl !== "string") return undefined;
  const m = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(authorUrl);
  return m?.[1];
}

// An X post with no text of its own: only media or links (SAT-12, SAT-37). Tested on the
// post text alone (never the `author: ` title, so a real post ending in "...: pic.twitter.com/x"
// keeps its title). A link reads as X shows it: a full URL (t.co or any other, Twitterbot's
// og:description), a pic.twitter.com media link, or a display URL (host plus a path, maybe
// cut with "…"). A display URL needs the path, so "Node.js", "Node.js…" and "box.com" stay text.
const LINK = String.raw`(?:https?:\/\/\S+|pic\.twitter\.com\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*)`;
const NO_POST_TEXT = new RegExp(`^${LINK}(?: ${LINK})*$`, "i");

export function isOnlyLinks(text: string | undefined): boolean {
  return NO_POST_TEXT.test((text ?? "").replace(/\s+/g, " ").trim());
}

type Attempt = { result: XTitle | null; bytesRead: number };

async function viaOembed(id: string, signal: AbortSignal): Promise<Attempt> {
  let bytesRead = 0;
  try {
    const res = await fetch(oembedUrl(id), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    // Missing or deleted posts come back as a 404 HTML page, bad params as 400 JSON.
    // Only a 2xx JSON body is ever read, so HTML never reaches JSON.parse.
    if (!res.ok || !contentType(res).includes("application/json")) {
      await discard(res);
      return { result: null, bytesRead };
    }
    const buf = await res.arrayBuffer();
    bytesRead = buf.byteLength;
    const data: unknown = JSON.parse(new TextDecoder().decode(buf));
    if (typeof data !== "object" || data === null || "errors" in data) return { result: null, bytesRead };
    const body = data as Record<string, unknown>;
    const author = typeof body.author_name === "string" ? body.author_name.trim() : "";
    const text = typeof body.html === "string" ? firstParagraphText(body.html) : "";
    // A profile or timeline embed has `title: ""` and no post paragraph: no title.
    if (!author || !text) return { result: null, bytesRead };
    const url = typeof body.url === "string" && body.url.startsWith("https://") ? body.url : undefined;
    const handle = handleFromAuthorUrl(body.author_url);
    return {
      result: {
        title: `${author}: ${text}`,
        ...(url ? { url } : {}),
        description: text,
        author,
        ...(handle ? { handle } : {}),
        source: "x-oembed",
        bytesRead,
      },
      bytesRead,
    };
  } catch {
    return { result: null, bytesRead };
  }
}

// og:title reads "Naval (@naval) on X": display name before " (@", handle inside.
const OG_TITLE = /^(.*?) \(@([A-Za-z0-9_]{1,15})\) on X$/s;
// An X Article's post page (SAT-43 probe, 2026-11-08) reads
// `Aaron Levie on X: "The never-ending last mile of work" / X`: the article title, quoted.
const OG_TITLE_QUOTED = /^.+? on X: "(.*)" \/ X$/s;
// X's logged-out page: its og:description when the page describes no post.
const GENERIC_DESCRIPTION = /^From breaking news and entertainment to sports and politics\b/i;

type Page = { ok: true; ogTitle: string; ogDescription: string; bytesRead: number } | { ok: false; bytesRead: number };

// x.com's post page as Twitterbot, read up to </head> or 256 KB: og:title and og:description
// entity-decoded and trimmed ("" when absent). `ok: false` on any failure (network, abort,
// timeout, bad status, non-HTML). Never throws.
async function readPage(id: string, signal: AbortSignal): Promise<Page> {
  let bytesRead = 0;
  try {
    const res = await fetch(`https://x.com/i/status/${id}`, {
      headers: { "User-Agent": TWITTERBOT_UA, Accept: "text/html" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (!res.ok || !contentType(res).includes("text/html") || !res.body) {
      await discard(res);
      return { ok: false, bytesRead };
    }

    let ogTitle: string | null = null;
    let ogDescription: string | null = null;
    let headDone = false;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const rewritten = new HTMLRewriter()
      .on('meta[property="og:title"]', {
        element(el) {
          ogTitle ??= el.getAttribute("content");
        },
      })
      .on('meta[property="og:description"]', {
        element(el) {
          ogDescription ??= el.getAttribute("content");
        },
      })
      .on("head", {
        element(el) {
          el.onEndTag(() => {
            headDone = true;
          });
        },
      })
      .transform(new Response(res.body.pipeThrough(counter), { headers: res.headers }));

    const reader = rewritten.body!.getReader();
    try {
      while (!headDone && bytesRead < PAGE_CAP_BYTES) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    // HTMLRewriter hands back attribute values with entities still encoded.
    return {
      ok: true,
      ogTitle: decodeEntities(ogTitle ?? "").trim(),
      ogDescription: decodeEntities(ogDescription ?? "").trim(),
      bytesRead,
    };
  } catch {
    return { ok: false, bytesRead };
  }
}

// Fallback 1: the post read from x.com's page alone, author from og:title.
async function viaTwitterbot(id: string, signal: AbortSignal): Promise<Attempt> {
  const page = await readPage(id, signal);
  if (!page.ok) return { result: null, bytesRead: page.bytesRead };
  const m = OG_TITLE.exec(page.ogTitle);
  const description = page.ogDescription;
  const author = m?.[1]?.trim() ?? "";
  if (!m || !author || !description) return { result: null, bytesRead: page.bytesRead };
  return {
    result: {
      title: `${author}: ${description}`,
      description,
      author,
      handle: m[2],
      source: "x-twitterbot",
      bytesRead: page.bytesRead,
    },
    bytesRead: page.bytesRead,
  };
}

/**
 * SAT-43: the post text x.com's page gives a post whose oEmbed text is only links (an X
 * Article). og:description with a trailing "…" stripped, or the quoted part of og:title when
 * og:description is a cut of it. Null when the page describes no post: og:title isn't a
 * post's, or og:description is empty, only links, or X's generic text.
 */
export function pageText(ogTitle: string, ogDescription: string): string | null {
  const quoted = OG_TITLE_QUOTED.exec(ogTitle)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (!quoted && !OG_TITLE.test(ogTitle)) return null;
  const description = ogDescription.replace(/\s+/g, " ").replace(/\s*…$/, "").trim();
  if (!description || GENERIC_DESCRIPTION.test(description)) return null;
  const text = quoted && quoted.startsWith(description) ? quoted : description;
  return isOnlyLinks(text) ? null : text;
}

/**
 * Raw title for an X post id: `${author}: ${post text}`. oEmbed first (its `url` is the
 * canonical `x.com/<user>/status/<id>`), then the Twitterbot read of x.com. When oEmbed's
 * post text is only links (SAT-43), the Twitterbot page is read for the text, oEmbed keeps
 * the rest; a page that fails or describes no post leaves oEmbed's result as it was. Each
 * fetch gets 4 s on top of the caller's signal. `bytesRead` is every body byte read across
 * both fetches. Null on any failure; never throws.
 */
export async function lookupX(id: string, signal: AbortSignal): Promise<XTitle | null> {
  try {
    if (!/^\d{1,25}$/.test(id) || signal.aborted) return null;
    const first = await viaOembed(id, signal);
    if (first.result) {
      if (!isOnlyLinks(first.result.description) || signal.aborted) return first.result;
      const page = await readPage(id, signal);
      const bytesRead = first.bytesRead + page.bytesRead;
      const text = page.ok ? pageText(page.ogTitle, page.ogDescription) : null;
      if (!text) return { ...first.result, bytesRead };
      return { ...first.result, title: `${first.result.author}: ${text}`, description: text, bytesRead };
    }
    if (signal.aborted) return null;
    const second = await viaTwitterbot(id, signal);
    if (!second.result) return null;
    return { ...second.result, bytesRead: first.bytesRead + second.bytesRead };
  } catch {
    return null;
  }
}
