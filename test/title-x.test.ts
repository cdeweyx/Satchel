/// <reference types="vite/client" />
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupX } from "../src/title/x";
import { network } from "./network";

// Shapes follow the research 03 probes (2026-11-07): oEmbed JSON with `\u003c`-escaped
// html, 404 "Nothing to see here" HTML for a missing post, 400 JSON `errors[]` for bad
// params, a profile embed with `title: ""`, and x.com's og tags as served to Twitterbot.

const ID = "1002103360646823936";
const OEMBED = "https://publish.x.com/oembed";
const PAGE = `https://x.com/i/status/${ID}`;

type Seen = { method: string; url: string; userAgent: string | null; accept: string | null };

function recorder() {
  const seen: Seen[] = [];
  const record = (request: { method: string; url: string; headers: { get(name: string): string | null } }) => {
    seen.push({
      method: request.method,
      url: request.url,
      userAgent: request.headers.get("user-agent"),
      accept: request.headers.get("accept"),
    });
  };
  return { seen, record };
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

function jsonText(body: string, status = 200) {
  return new HttpResponse(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlText(body: string, status = 200) {
  return new HttpResponse(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// Real oEmbed escapes `<` and `>` as \u003c and \u003e inside the JSON string.
const esc = (html: string) => JSON.stringify(html).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const NAVAL_HTML =
  '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">How to Get Rich (without getting lucky):</p>&mdash; Naval (@naval) <a href="https://twitter.com/naval/status/1002103360646823936?ref_src=twsrc%5Etfw">May 31, 2018</a></blockquote>\n';
const NAVAL_OEMBED = `{"url":"https://x.com/naval/status/1002103360646823936","author_name":"Naval","author_url":"https://twitter.com/naval","html":${esc(NAVAL_HTML)},"width":550,"height":null,"type":"rich","cache_age":"3153600000","provider_name":"Twitter","provider_url":"https://twitter.com","version":"1.0"}`;

const OPENAI_HTML =
  '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">Tom &amp; Jerry&#39;s &quot;guide&quot; &lt;b&gt;not bold&lt;/b&gt; &#x1F680;&#8212;done<br><br>Read more: <a href="https://t.co/sHDm57g3Kr">https://t.co/sHDm57g3Kr</a></p>&mdash; OpenAI (@OpenAI) <a href="https://twitter.com/OpenAI/status/1?ref_src=twsrc%5Etfw">January 1, 2026</a></blockquote>\n';
const OPENAI_OEMBED = `{"url":"https://x.com/OpenAI/status/1002103360646823936","author_name":"OpenAI","author_url":"https://twitter.com/OpenAI","html":${esc(OPENAI_HTML)},"width":550,"height":null,"type":"rich","cache_age":"3153600000","provider_name":"Twitter","provider_url":"https://twitter.com","version":"1.0"}`;

const PROFILE_OEMBED = `{"url":"https://x.com/naval","title":"","html":${esc('<a class="twitter-timeline" data-dnt="true" href="https://twitter.com/naval?ref_src=twsrc%5Etfw">Tweets by naval</a>\n')},"width":550,"height":null,"type":"rich","cache_age":"3153600000","provider_name":"Twitter","provider_url":"https://twitter.com","version":"1.0"}`;

const NOT_FOUND_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Nothing to see here</title></head><body><h1>Nothing to see here</h1><p>Sorry, that page doesn’t exist.</p></body></html>';

const ERRORS_400 = '{"errors":[{"code":357,"message":"url: queryParam is required"}]}';

function xPage(ogTitle: string, ogDescription: string, tail = "") {
  return (
    '<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8"/>' +
    '<meta property="og:site_name" content="X (formerly Twitter)"/>' +
    `<meta property="og:title" content="${ogTitle}"/>` +
    `<meta property="og:description" content="${ogDescription}"/>` +
    `<title>X</title></head><body><div id="react-root"></div>${tail}</body></html>`
  );
}
const NAVAL_PAGE = xPage("Naval (@naval) on X", "How to Get Rich (without getting lucky):");

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lookupX via oEmbed", () => {
  it("200 JSON: author and first <p> text, canonical url, one GET to publish.x.com", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, ({ request }) => {
        record(request);
        return jsonText(NAVAL_OEMBED);
      }),
    );

    const result = await lookupX(ID, signal());

    expect(result).toEqual({
      title: "Naval: How to Get Rich (without getting lucky):",
      url: "https://x.com/naval/status/1002103360646823936",
      description: "How to Get Rich (without getting lucky):",
      author: "Naval",
      handle: "naval",
      source: "x-oembed",
      bytesRead: bytes(NAVAL_OEMBED),
    });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe(OEMBED);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      url: `https://x.com/i/status/${ID}`,
      omit_script: "true",
      dnt: "true",
    });
    expect(seen[0]!.method).toBe("GET");
  });

  it("decodes entities, turns <br> into newlines and keeps t.co anchors as text", async () => {
    network.use(http.get(OEMBED, () => jsonText(OPENAI_OEMBED)));

    const result = await lookupX(ID, signal());

    const text = 'Tom & Jerry\'s "guide" <b>not bold</b> \u{1F680}\u2014done\n\nRead more: https://t.co/sHDm57g3Kr';
    expect(result?.title).toBe(`OpenAI: ${text}`);
    expect(result?.description).toBe(text);
    expect(result?.handle).toBe("OpenAI");
    expect(result?.url).toBe("https://x.com/OpenAI/status/1002103360646823936");
    expect(result?.source).toBe("x-oembed");
  });
});

describe("lookupX oEmbed failures", () => {
  it("404 HTML: never JSON-parsed or read, falls back to the Twitterbot page", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, ({ request }) => {
        record(request);
        return htmlText(NOT_FOUND_HTML, 404);
      }),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(NAVAL_PAGE);
      }),
    );

    const result = await lookupX(ID, signal());

    expect(result).toEqual({
      title: "Naval: How to Get Rich (without getting lucky):",
      description: "How to Get Rich (without getting lucky):",
      author: "Naval",
      handle: "naval",
      source: "x-twitterbot",
      // Only the x.com page's bytes: the 404 HTML body was never read.
      bytesRead: bytes(NAVAL_PAGE),
    });
    expect(parse.mock.calls.some(([arg]) => String(arg).includes("Nothing to see here"))).toBe(false);
    expect(seen.map((s) => [new URL(s.url).host, s.userAgent])).toEqual([
      ["publish.x.com", null],
      ["x.com", "Twitterbot/1.0"],
    ]);
    expect(seen[1]!.url).toBe(PAGE);
  });

  it("200 with an HTML content type is not parsed as JSON either", async () => {
    const parse = vi.spyOn(JSON, "parse");
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 200)),
      http.get(PAGE, () => new HttpResponse(null, { status: 404 })),
    );

    expect(await lookupX(ID, signal())).toBeNull();
    expect(parse.mock.calls.some(([arg]) => String(arg).includes("Nothing to see here"))).toBe(false);
  });

  it("400 JSON errors array: no title from oEmbed, null when the fallback fails too", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, ({ request }) => {
        record(request);
        return jsonText(ERRORS_400, 400);
      }),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(NOT_FOUND_HTML, 404);
      }),
    );

    expect(await lookupX(ID, signal())).toBeNull();
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["publish.x.com", "x.com"]);
  });

  it("200 JSON carrying an errors array is treated as no title", async () => {
    network.use(
      http.get(OEMBED, () => jsonText(ERRORS_400, 200)),
      http.get(PAGE, () => htmlText(NAVAL_PAGE)),
    );

    const result = await lookupX(ID, signal());

    expect(result?.source).toBe("x-twitterbot");
    expect(result?.bytesRead).toBe(bytes(ERRORS_400) + bytes(NAVAL_PAGE));
  });

  it("profile embed (title \"\", no post paragraph) gives null", async () => {
    network.use(
      http.get(OEMBED, () => jsonText(PROFILE_OEMBED)),
      http.get(PAGE, () => htmlText(NOT_FOUND_HTML, 404)),
    );

    expect(await lookupX(ID, signal())).toBeNull();
  });

  it("network error on oEmbed falls back to Twitterbot", async () => {
    network.use(
      http.get(OEMBED, () => HttpResponse.error()),
      http.get(PAGE, () => htmlText(NAVAL_PAGE)),
    );

    const result = await lookupX(ID, signal());

    expect(result?.title).toBe("Naval: How to Get Rich (without getting lucky):");
    expect(result?.source).toBe("x-twitterbot");
    expect(result?.url).toBeUndefined();
  });
});

describe("lookupX Twitterbot fallback", () => {
  it("decodes entities in og:title and og:description", async () => {
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)),
      http.get(PAGE, () =>
        htmlText(xPage("Tom &amp; Jerry (@tomjerry) on X", "It&#39;s &quot;here&quot; &amp; live &#x1F680;")),
      ),
    );

    const result = await lookupX(ID, signal());

    expect(result).toMatchObject({
      title: 'Tom & Jerry: It\'s "here" & live \u{1F680}',
      author: "Tom & Jerry",
      handle: "tomjerry",
      description: 'It\'s "here" & live \u{1F680}',
      source: "x-twitterbot",
    });
  });

  it("stops reading after </head>", async () => {
    const head = NAVAL_PAGE.slice(0, NAVAL_PAGE.indexOf("<body>"));
    const filler = `<div>${"x".repeat(16 * 1024)}</div>`;
    const chunks = [head, "<body>", ...Array.from({ length: 32 }, () => filler), "</body></html>"];
    const total = chunks.reduce((n, c) => n + bytes(c), 0);
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)),
      http.get(PAGE, () => {
        const enc = new TextEncoder();
        let i = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            const c = chunks[i++];
            if (c === undefined) controller.close();
            else controller.enqueue(enc.encode(c));
          },
        });
        return new HttpResponse(stream, { headers: { "content-type": "text/html; charset=utf-8" } });
      }),
    );

    const result = await lookupX(ID, signal());

    expect(result?.title).toBe("Naval: How to Get Rich (without getting lucky):");
    expect(result!.bytesRead).toBeGreaterThanOrEqual(bytes(head));
    expect(result!.bytesRead).toBeLessThan(total / 2);
  });

  it("a login-wall page without the author pattern gives null", async () => {
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)),
      http.get(PAGE, () => htmlText(xPage("X", "From breaking news and entertainment to sports and politics"))),
    );

    expect(await lookupX(ID, signal())).toBeNull();
  });

  it("non-HTML content type on the page gives null", async () => {
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)),
      http.get(PAGE, () => HttpResponse.json({ og: "nope" })),
    );

    expect(await lookupX(ID, signal())).toBeNull();
  });
});

describe("lookupX never throws", () => {
  it("returns null when the caller's signal aborts mid-fetch, without a second call", async () => {
    const { seen, record } = recorder();
    const controller = new AbortController();
    network.use(
      http.get(OEMBED, async ({ request }) => {
        record(request);
        controller.abort();
        await new Promise((r) => setTimeout(r, 50));
        return jsonText(NAVAL_OEMBED);
      }),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(NAVAL_PAGE);
      }),
    );

    await expect(lookupX(ID, controller.signal)).resolves.toBeNull();
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["publish.x.com"]);
  });

  it("returns null without any request for an already-aborted signal or a non-numeric id", async () => {
    const { seen, record } = recorder();
    network.use(
      http.all("*", ({ request }) => {
        record(request);
        return HttpResponse.error();
      }),
    );

    await expect(lookupX(ID, AbortSignal.abort())).resolves.toBeNull();
    await expect(lookupX("../oembed", signal())).resolves.toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("no fxtwitter", () => {
  it("when both sources fail, only publish.x.com and x.com are called", async () => {
    const { seen, record } = recorder();
    network.use(
      http.all("*", ({ request }) => {
        record(request);
        return HttpResponse.error();
      }),
    );

    expect(await lookupX(ID, signal())).toBeNull();
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["publish.x.com", "x.com"]);
  });

  it("no source file calls fxtwitter", () => {
    const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
    const x = sources["../src/title/x.ts"];
    expect(x).toBeDefined();
    expect(x).not.toMatch(/fxtwitter/i);
    for (const [path, text] of Object.entries(sources)) {
      expect({ path, hit: /api\.fxtwitter|https?:\/\/(?:[a-z.]*\.)?fxtwitter\.com/i.test(text) }).toEqual({
        path,
        hit: false,
      });
    }
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });
});
