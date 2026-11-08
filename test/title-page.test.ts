import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { PAGE_UA, READ_CAP, lookupPage } from "../src/title/page";
import { network } from "./network";

const URL_ = "https://example.com/post/hello-world";
const enc = new TextEncoder();

// A body the test serves one chunk per pull, recording what actually left the "server":
// bytes served, chunks served, and whether the reader cancelled it.
function streamed(chunks: string[]) {
  const stats = { served: 0, chunks: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[i++];
        if (next === undefined) {
          controller.close();
          return;
        }
        const bytes = enc.encode(next);
        stats.served += bytes.byteLength;
        stats.chunks += 1;
        controller.enqueue(bytes);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, stats };
}

type Seen = { url: string; headers: Record<string, string | null> };

// Serves `chunks` as a streamed response at URL_ and records each request it sees.
function servePage(
  chunks: string[],
  init: { status?: number; contentType?: string | null } = {},
) {
  const { body, stats } = streamed(chunks);
  const seen: Seen[] = [];
  network.use(
    http.get(URL_, ({ request }) => {
      seen.push({
        url: request.url,
        headers: {
          "user-agent": request.headers.get("user-agent"),
          accept: request.headers.get("accept"),
          "accept-language": request.headers.get("accept-language"),
        },
      });
      const headers = new Headers();
      const contentType = init.contentType === undefined ? "text/html; charset=utf-8" : init.contentType;
      if (contentType !== null) headers.set("content-type", contentType);
      return new HttpResponse(body, { status: init.status ?? 200, headers });
    }),
  );
  return { stats, seen };
}

const live = () => new AbortController().signal;
const KB = 1024;

describe("lookupPage", () => {
  it("concatenates a <title> that arrives in three chunks, and sends the crawler UA", async () => {
    const { seen } = servePage([
      "<!doctype html><html><head><meta charset=utf-8><title>How We Built ",
      "a Chunked &amp; Streamed ",
      "Title</title></head><body><p>body</p></body></html>",
    ]);

    const result = await lookupPage(URL_, live());

    expect(result).toEqual({
      title: "How We Built a Chunked & Streamed Title",
      source: "page",
      bytesRead: expect.any(Number),
    });
    expect(seen).toEqual([
      {
        url: URL_,
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; Satchel/0.1; +https://github.com/cdeweyx/Satchel) facebookexternalhit/1.1",
          accept: "text/html,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      },
    ]);
    expect(PAGE_UA).toBe(seen[0]!.headers["user-agent"]);
  });

  it("also joins a <title> whose tag and text are split mid-token across chunks", async () => {
    servePage(["<html><head><ti", "tle>Split Ac", "ross Chunks</ti", "tle></head></html>"]);
    const result = await lookupPage(URL_, live());
    expect(result?.title).toBe("Split Across Chunks");
  });

  it("returns the <title> when no og:title shows up in the first 256 KB, and cancels the read", async () => {
    const chunk = 16 * KB;
    const filler = `<script>${"x".repeat(chunk - "<script></script>".length)}</script>`;
    expect(enc.encode(filler).byteLength).toBe(chunk);
    // 1 MB of head with no </head> and no og:title (YouTube-sized, L3 probe).
    const chunks = [
      "<html><head><title>Big Page Title</title>",
      ...Array.from({ length: 64 }, () => filler),
      '<meta property="og:title" content="Too Late"></head></html>',
    ];
    const total = chunks.reduce((n, c) => n + enc.encode(c).byteLength, 0);
    const { stats } = servePage(chunks);

    const result = await lookupPage(URL_, live());

    expect(result?.title).toBe("Big Page Title");
    expect(result?.bytesRead).toBeGreaterThanOrEqual(READ_CAP);
    expect(result!.bytesRead).toBeLessThanOrEqual(READ_CAP + chunk);
    // What the server actually handed over, not just what we say we read.
    expect(stats.served).toBeLessThanOrEqual(READ_CAP + chunk);
    expect(stats.served).toBeLessThan(total);
    expect(stats.cancelled).toBe(true);
  });

  it("returns a null title when the first 256 KB has no og:title, <title> or description", async () => {
    const chunk = 16 * KB;
    const filler = `<!--${"y".repeat(chunk - 7)}-->`;
    const chunks = ["<html><head>", ...Array.from({ length: 64 }, () => filler), "<title>Late</title>"];
    const { stats } = servePage(chunks);

    const result = await lookupPage(URL_, live());

    expect(result).toEqual({ title: null, source: "page", bytesRead: expect.any(Number) });
    expect(result!.bytesRead).toBeLessThanOrEqual(READ_CAP + chunk);
    expect(stats.served).toBeLessThanOrEqual(READ_CAP + chunk);
    expect(stats.cancelled).toBe(true);
  });

  it("stops reading at </head>", async () => {
    const head = '<html><head><title>Short</title><meta property="og:title" content="Short Head"></head>';
    const body = Array.from({ length: 20 }, () => `<p>${"z".repeat(4 * KB)}</p>`);
    const { stats } = servePage([head, ...body, "</html>"]);

    const result = await lookupPage(URL_, live());

    expect(result?.title).toBe("Short Head");
    // The head chunk plus at most the one chunk the parser had pulled before </head> fired.
    expect(stats.chunks).toBeLessThanOrEqual(2);
    expect(result!.bytesRead).toBe(stats.served);
    expect(stats.cancelled).toBe(true);
  });

  it("returns null for application/pdf without reading the body", async () => {
    const { stats, seen } = servePage(["%PDF-1.7\n", "x".repeat(64 * KB), "%%EOF"], {
      contentType: "application/pdf",
    });

    expect(await lookupPage(URL_, live())).toBeNull();
    expect(seen).toHaveLength(1);
    expect(stats.served).toBe(0);
  });

  it("returns null when there's no content-type at all", async () => {
    const { stats } = servePage(["<html><head><title>Untyped</title></head></html>"], {
      contentType: null,
    });
    expect(await lookupPage(URL_, live())).toBeNull();
    expect(stats.served).toBe(0);
  });

  it("returns null on a 403, even with a <title> in the body", async () => {
    const { seen } = servePage(
      ["<html><head><title>Just a moment...</title></head></html>"],
      { status: 403 },
    );
    expect(await lookupPage(URL_, live())).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("prefers og:title over <title>, and returns the description", async () => {
    servePage([
      "<html><head><title>Site | Page</title>",
      '<meta property="og:title" content="  The Real   Title  ">',
      '<meta name="description" content="Plain description.">',
      '<meta property="og:description" content="OG description &mdash; better.">',
      "</head></html>",
    ]);
    expect(await lookupPage(URL_, live())).toEqual({
      title: "The Real Title",
      description: "OG description — better.",
      source: "page",
      bytesRead: expect.any(Number),
    });
  });

  it("entity-decodes and whitespace-collapses the picked title", async () => {
    servePage([
      "<html><head><title>\n  Tom &amp; Jerry&#39;s\t&lt;Big&gt;   Day &#x2014; Part&nbsp;2\n</title></head></html>",
    ]);
    // &nbsp; decodes to U+00A0, which the collapse turns into a plain space.
    expect((await lookupPage(URL_, live()))?.title).toBe("Tom & Jerry's <Big> Day — Part 2");
  });

  it("decodes once, so &amp;lt; stays &lt;", async () => {
    servePage(["<html><head><title>A &amp;lt; B</title></head></html>"]);
    expect((await lookupPage(URL_, live()))?.title).toBe("A &lt; B");
  });

  it("falls through an all-whitespace og:title and <title> to the description's first 80 chars", async () => {
    const description =
      "A description that runs well past eighty characters so the title has to be cut off somewhere sensible.";
    servePage([
      '<html><head><meta property="og:title" content="   "><title> &nbsp; \n </title>',
      `<meta name="description" content="${description}"></head></html>`,
    ]);
    const result = await lookupPage(URL_, live());
    expect(result?.title).toBe(description.slice(0, 80).trim());
    expect(result?.title?.length).toBeLessThanOrEqual(80);
    expect(result?.description).toBe(description);
  });

  it("returns null on a network error", async () => {
    network.use(http.get(URL_, () => HttpResponse.error()));
    expect(await lookupPage(URL_, live())).toBeNull();
  });

  it("returns null, without throwing, when the caller's signal is already aborted", async () => {
    servePage(["<html><head><title>Never</title></head></html>"]);
    const controller = new AbortController();
    controller.abort();
    expect(await lookupPage(URL_, controller.signal)).toBeNull();
  });
});
