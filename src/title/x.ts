// X post title lookup (D-3, "Rules in full" > Title lookup, research 03).
// oEmbed at publish.x.com first, then x.com's own page read as Twitterbot. Two sources
// only: when both fail the caller uses the `X post <id>` fallback title.
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

async function viaTwitterbot(id: string, signal: AbortSignal): Promise<Attempt> {
  let bytesRead = 0;
  try {
    const res = await fetch(`https://x.com/i/status/${id}`, {
      headers: { "User-Agent": TWITTERBOT_UA, Accept: "text/html" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (!res.ok || !contentType(res).includes("text/html") || !res.body) {
      await discard(res);
      return { result: null, bytesRead };
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
    const m = OG_TITLE.exec(decodeEntities(ogTitle ?? "").trim());
    const description = decodeEntities(ogDescription ?? "").trim();
    const author = m?.[1]?.trim() ?? "";
    if (!m || !author || !description) return { result: null, bytesRead };
    return {
      result: {
        title: `${author}: ${description}`,
        description,
        author,
        handle: m[2],
        source: "x-twitterbot",
        bytesRead,
      },
      bytesRead,
    };
  } catch {
    return { result: null, bytesRead };
  }
}

/**
 * Raw title for an X post id: `${author}: ${post text}`. oEmbed first (its `url` is the
 * canonical `x.com/<user>/status/<id>`), then the Twitterbot read of x.com. Each fetch gets
 * 4 s on top of the caller's signal. `bytesRead` is every body byte read across both
 * attempts. Null on any failure; never throws.
 */
export async function lookupX(id: string, signal: AbortSignal): Promise<XTitle | null> {
  try {
    if (!/^\d{1,25}$/.test(id) || signal.aborted) return null;
    const first = await viaOembed(id, signal);
    if (first.result) return first.result;
    if (signal.aborted) return null;
    const second = await viaTwitterbot(id, signal);
    if (!second.result) return null;
    return { ...second.result, bytesRead: first.bytesRead + second.bytesRead };
  } catch {
    return null;
  }
}
