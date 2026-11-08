// X post title lookup (D-3, "Rules in full" > Title lookup, research 03).
// oEmbed at publish.x.com first, then x.com's own page read as Twitterbot. Two sources
// only: when both fail the caller uses the `X post <id>` fallback title. SAT-43: when
// oEmbed's post text is only links (an X Article), the same Twitterbot page supplies it.
// Never throws: any failure (network, abort, timeout, bad status, wrong content type,
// unexpected shape) returns null, because the save path relies on it (SAT-12).

import { isXPostMedia, xLinkPattern } from "../preview";

export type XTitle = {
  title: string;
  url?: string;
  description?: string;
  author?: string;
  handle?: string;
  source: "x-oembed" | "x-twitterbot";
  // SAT-45: the text is an X Article's title, read from x.com's page because oEmbed's post
  // text was only links (SAT-43). Absent on every other result.
  article?: true;
  // SAT-55: the display URLs ("box.com/blog/x…") X anchored with t.co in oEmbed's post text,
  // so isOnlyLinks and the page-body text strip them as links. Present only when there's one,
  // and only while `description` is that oEmbed text.
  links?: string[];
  // SAT-48: the post's own photo (pbs.twimg.com/media/…) from x.com's og:image, when read.
  image?: string;
  bytesRead: number;
};

const FETCH_TIMEOUT_MS = 4000;
// SAT-48: a post whose oEmbed text shows a photo link reads x.com's page for the photo, but
// only until this long after lookupX started, so the extra read can't push the lookup past
// enrich's 5 s stage cap and cost the post's title.
const IMAGE_READ_BY_MS = 4500;
const MEDIA_LINK = /\bpic\.twitter\.com\//i;
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
  // SAT-55: the typographic ones X leaves named in post text.
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function fromCodePoint(n: number, original: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return original;
  return String.fromCodePoint(n);
}

// Enough for what X emits: the five XML entities, nbsp, the dashes, ellipsis and curly quotes
// (SAT-55), and numeric references. An unknown name stays as written.
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10), match);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// Tags out, then entities decoded. Tags go before entities so an escaped `&lt;b&gt;` in the
// post survives as text.
function htmlText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""));
}

// X wraps every URL in post text in a t.co anchor; hashtags and mentions link to x.com.
const T_CO_ANCHOR = /<a\b[^>]*\bhref=["']https?:\/\/t\.co\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
const SHOWN_AS_URL = new RegExp(`^${xLinkPattern()}$`, "i");

// The first <p> in oEmbed's html. `text` is its inner text: <br> becomes a newline, other
// tags (the t.co <a> links) are dropped but their text kept, entities decoded, trimmed.
// SAT-55: `links` is the text of each t.co anchor that shows a display URL ("box.com/blog/x…")
// rather than a full URL or pic.twitter.com link, which read as links from the text alone.
function firstParagraph(html: string): { text: string; links: string[] } {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!m || m[1] === undefined) return { text: "", links: [] };
  const links: string[] = [];
  for (const a of m[1].matchAll(T_CO_ANCHOR)) {
    const shown = htmlText(a[1] ?? "").trim();
    if (shown && !SHOWN_AS_URL.test(shown) && !links.includes(shown)) links.push(shown);
  }
  return { text: htmlText(m[1]).trim(), links };
}

function handleFromAuthorUrl(authorUrl: unknown): string | undefined {
  if (typeof authorUrl !== "string") return undefined;
  const m = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(authorUrl);
  return m?.[1];
}

// An X post with no text of its own: only media or links (SAT-12, SAT-37). Tested on the
// post text alone (never the `author: ` title, so a real post ending in "...: pic.twitter.com/x"
// keeps its title). A link reads as X shows it (xLinkPattern in preview.ts, shared with
// SAT-52's page-body text): a full URL (t.co or any other, Twitterbot's og:description), a
// pic.twitter.com media link, or one of `links`, the display URLs X anchored (lookupX's
// `links`). SAT-55: a display URL without its anchor is text, so "Node.js/Deno" stays text.
export function isOnlyLinks(text: string | undefined, links?: readonly string[]): boolean {
  const link = xLinkPattern(links);
  return new RegExp(`^${link}(?: ${link})*$`, "i").test((text ?? "").replace(/\s+/g, " ").trim());
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
    const { text, links } = typeof body.html === "string" ? firstParagraph(body.html) : { text: "", links: [] };
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
        ...(links.length > 0 ? { links } : {}),
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

type Page =
  | { ok: true; ogTitle: string; ogDescription: string; image?: string; bytesRead: number }
  | { ok: false; bytesRead: number };

// x.com's post page as Twitterbot, read up to </head> or 256 KB: og:title and og:description
// entity-decoded and trimmed ("" when absent). `image` is og:image, entity-decoded, kept only
// when it's the post's own photo (SAT-48), never an avatar or X's default card. `ok: false`
// on any failure (network, abort, timeout, bad status, non-HTML). Never throws.
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
    let ogImage: string | null = null;
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
      .on('meta[property="og:image"]', {
        element(el) {
          ogImage ??= el.getAttribute("content");
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
    const image = decodeEntities(ogImage ?? "").trim();
    return {
      ok: true,
      ogTitle: decodeEntities(ogTitle ?? "").trim(),
      ogDescription: decodeEntities(ogDescription ?? "").trim(),
      ...(isXPostMedia(image) ? { image } : {}),
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
      ...(page.image ? { image: page.image } : {}),
      source: "x-twitterbot",
      bytesRead: page.bytesRead,
    },
    bytesRead: page.bytesRead,
  };
}

/**
 * SAT-43: the post text x.com's page gives a post whose oEmbed text is only links (an X
 * Article). The quoted part of og:title when there is one (SAT-45: that's the article's title,
 * whatever og:description says), else og:description with a trailing "…" stripped. Null when
 * the page describes no post: og:title isn't a post's, or og:description is empty or X's
 * generic text, or the text is only links.
 */
export function pageText(ogTitle: string, ogDescription: string): string | null {
  const quoted = OG_TITLE_QUOTED.exec(ogTitle)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (!quoted && !OG_TITLE.test(ogTitle)) return null;
  const description = ogDescription.replace(/\s+/g, " ").replace(/\s*…$/, "").trim();
  if (!description || GENERIC_DESCRIPTION.test(description)) return null;
  const text = quoted || description;
  return isOnlyLinks(text) ? null : text;
}

/**
 * Raw title for an X post id: `${author}: ${post text}`. oEmbed first (its `url` is the
 * canonical `x.com/<user>/status/<id>`), then the Twitterbot read of x.com. When oEmbed's
 * post text is only links (SAT-43), the Twitterbot page is read for the text, oEmbed keeps
 * the rest and the result is marked `article: true` (SAT-45); a page that fails or describes
 * no post leaves oEmbed's result as it was. SAT-48: a post whose text shows a pic.twitter.com
 * link also reads the page, for its photo only; any page read sets `image` when og:image is
 * the post's own photo. Each fetch gets 4 s on top of the caller's
 * signal. `bytesRead` is every body byte read across both fetches. Null on any failure;
 * never throws.
 */
export async function lookupX(id: string, signal: AbortSignal): Promise<XTitle | null> {
  try {
    if (!/^\d{1,25}$/.test(id) || signal.aborted) return null;
    const started = Date.now();
    const first = await viaOembed(id, signal);
    if (first.result) {
      const onlyLinks = isOnlyLinks(first.result.description, first.result.links);
      const photoLink = MEDIA_LINK.test(first.result.description ?? "");
      if ((!onlyLinks && !photoLink) || signal.aborted) return first.result;
      if (!onlyLinks) {
        // SAT-48: a post with its own text and a photo link. The page is read for the photo
        // alone, inside IMAGE_READ_BY_MS; any failure keeps oEmbed's result as it was.
        const left = IMAGE_READ_BY_MS - (Date.now() - started);
        if (left <= 0) return first.result;
        const page = await readPage(id, AbortSignal.any([signal, AbortSignal.timeout(left)]));
        const image = page.ok && page.image ? { image: page.image } : {};
        return { ...first.result, ...image, bytesRead: first.bytesRead + page.bytesRead };
      }
      const page = await readPage(id, signal);
      const bytesRead = first.bytesRead + page.bytesRead;
      const image = page.ok && page.image ? { image: page.image } : {};
      const text = page.ok ? pageText(page.ogTitle, page.ogDescription) : null;
      if (!text) return { ...first.result, ...image, bytesRead };
      // The page's text replaces oEmbed's, so oEmbed's anchored links no longer apply.
      const { links: _oembedLinks, ...rest } = first.result;
      return {
        ...rest,
        title: `${first.result.author}: ${text}`,
        description: text,
        article: true,
        ...image,
        bytesRead,
      };
    }
    if (signal.aborted) return null;
    const second = await viaTwitterbot(id, signal);
    if (!second.result) return null;
    return { ...second.result, bytesRead: first.bytesRead + second.bytesRead };
  } catch {
    return null;
  }
}
