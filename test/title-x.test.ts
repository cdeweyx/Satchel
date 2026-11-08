/// <reference types="vite/client" />
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupTitle } from "../src/title";
import { isOnlyLinks, lookupX, pageText } from "../src/title/x";
import articleText from "./fixtures/x-article.json?raw";
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

// SAT-43: an X Article post. oEmbed's text is only a t.co link; x.com's page (as Twitterbot)
// names the article in og:title and og:description. Fixture from the lead's live probe.
const ARTICLE = JSON.parse(articleText) as {
  id: string;
  canonicalUrl: string;
  oembed: Record<string, unknown>;
  page: { ogTitle: string; ogDescription: string };
  articleUrlPage: { title: string };
};
const ARTICLE_OEMBED = JSON.stringify(ARTICLE.oembed).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const ARTICLE_PAGE_URL = `https://x.com/i/status/${ARTICLE.id}`;
const ARTICLE_PAGE = xPage(ARTICLE.page.ogTitle, ARTICLE.page.ogDescription);
const LINK_ONLY = "https://t.co/Lv1eB0x";

describe("SAT-43: an X Article gets its text from the Twitterbot page", () => {
  it("oEmbed text only a link: one more GET, as Twitterbot; the article title becomes the post text", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, ({ request }) => {
        record(request);
        return jsonText(ARTICLE_OEMBED);
      }),
      http.get(ARTICLE_PAGE_URL, ({ request }) => {
        record(request);
        return htmlText(ARTICLE_PAGE);
      }),
    );

    const result = await lookupX(ARTICLE.id, signal());

    expect(result).toEqual({
      title: "Aaron Levie: The never-ending last mile of work",
      url: ARTICLE.canonicalUrl,
      description: "The never-ending last mile of work",
      author: "Aaron Levie",
      handle: "levie",
      source: "x-oembed",
      article: true, // SAT-45: added to this SAT-43 assertion
      bytesRead: bytes(ARTICLE_OEMBED) + bytes(ARTICLE_PAGE),
    });
    expect(seen.map((s) => [s.url.split("?")[0], s.userAgent])).toEqual([
      [OEMBED, null],
      [ARTICLE_PAGE_URL, "Twitterbot/1.0"],
    ]);
  });

  it("a post with text of its own never reads the page", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, ({ request }) => {
        record(request);
        return jsonText(OPENAI_OEMBED);
      }),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(ARTICLE_PAGE);
      }),
    );

    const result = await lookupX(ID, signal());

    expect(result?.description).toMatch(/^Tom & Jerry/);
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["publish.x.com"]);
  });

  const unchanged = (pageBytes: number) => ({
    title: `Aaron Levie: ${LINK_ONLY}`,
    url: ARTICLE.canonicalUrl,
    description: LINK_ONLY,
    author: "Aaron Levie",
    handle: "levie",
    source: "x-oembed",
    bytesRead: bytes(ARTICLE_OEMBED) + pageBytes,
  });

  it.each([
    ["og:description empty", xPage(ARTICLE.page.ogTitle, "")],
    ["og:description only a URL", xPage("Aaron Levie on X: &quot;https://t.co/Lv1eB0x&quot; / X", LINK_ONLY)],
    ["og:description only a pic.twitter.com link", xPage("Aaron Levie (@levie) on X", "pic.twitter.com/AbC123")],
    [
      "X's generic logged-out page",
      xPage("X", "From breaking news and entertainment to sports and politics, get the full story with all the live commentary."),
    ],
    [
      "X's generic text under a post title",
      xPage("Aaron Levie on X: &quot;x&quot; / X", "From breaking news and entertainment to sports and politics, get the full story."),
    ],
    ["the article URL's own page (generic og:title)", xPage(ARTICLE.articleUrlPage.title, ARTICLE.page.ogDescription)],
  ])("a page with no post text (%s) leaves oEmbed's link-only result as it was", async (_label, html) => {
    network.use(
      http.get(OEMBED, () => jsonText(ARTICLE_OEMBED)),
      http.get(ARTICLE_PAGE_URL, () => htmlText(html)),
    );

    expect(await lookupX(ARTICLE.id, signal())).toEqual(unchanged(bytes(html)));
  });

  it.each([
    ["404", () => htmlText(NOT_FOUND_HTML, 404)],
    ["network error", () => HttpResponse.error()],
    ["non-HTML", () => HttpResponse.json({ og: "nope" })],
  ])("a failed page read (%s) leaves oEmbed's link-only result as it was", async (_label, answer) => {
    network.use(
      http.get(OEMBED, () => jsonText(ARTICLE_OEMBED)),
      http.get(ARTICLE_PAGE_URL, answer),
    );

    expect(await lookupX(ARTICLE.id, signal())).toEqual(unchanged(0));
  });

  it("the caller's signal aborting mid-page ends the read; oEmbed's result comes back, no throw", async () => {
    const controller = new AbortController();
    network.use(
      http.get(OEMBED, () => jsonText(ARTICLE_OEMBED)),
      http.get(ARTICLE_PAGE_URL, async () => {
        controller.abort();
        return new Promise<Response>(() => {});
      }),
    );

    const start = performance.now();
    const result = await lookupX(ARTICLE.id, controller.signal);

    expect(performance.now() - start).toBeLessThan(1000);
    expect(result).toEqual(unchanged(0));
  });
});

// SAT-45: lookupX marks the Article page path `article: true` so enrich sends Claude the titled
// shape. Nothing else carries the flag.
describe("SAT-45: only the Article page path is marked article", () => {
  it("the Levie Article: article true, with the article title as the post text", async () => {
    network.use(
      http.get(OEMBED, () => jsonText(ARTICLE_OEMBED)),
      http.get(ARTICLE_PAGE_URL, () => htmlText(ARTICLE_PAGE)),
    );

    const result = await lookupX(ARTICLE.id, signal());

    expect(result).toMatchObject({ article: true, description: "The never-ending last mile of work" });
  });

  it.each([
    ["a post with text of its own (oEmbed)", () => [http.get(OEMBED, () => jsonText(NAVAL_OEMBED))], ID],
    [
      "the Twitterbot fallback",
      () => [http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)), http.get(PAGE, () => htmlText(NAVAL_PAGE))],
      ID,
    ],
    [
      "a link-only post the page doesn't describe",
      () => [
        http.get(OEMBED, () => jsonText(ARTICLE_OEMBED)),
        http.get(ARTICLE_PAGE_URL, () => htmlText(xPage(ARTICLE.page.ogTitle, ""))),
      ],
      ARTICLE.id,
    ],
  ])("%s: no article flag", async (_label, handlers, id) => {
    network.use(...handlers());

    const result = await lookupX(id, signal());

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("article");
  });
});

describe("SAT-43: pageText", () => {
  it("prefers og:title's quoted part when og:description is a cut of it (trailing … stripped)", () => {
    const title = 'Aaron Levie on X: "The never-ending last mile of work" / X';
    expect(pageText(title, "The never-ending last mile of work…")).toBe("The never-ending last mile of work");
    expect(pageText(title, "The never-ending last…")).toBe("The never-ending last mile of work");
  });

  // SAT-45 changed this SAT-43 test: a quoted og:title now wins over a different og:description.
  it("SAT-45: the quoted og:title wins even when og:description is a different summary", () => {
    expect(pageText('Aaron Levie on X: "Short" / X', "A longer summary of the article…")).toBe("Short");
  });

  it("uses og:description, ellipsis stripped, when og:title has no quoted part", () => {
    expect(pageText("Aaron Levie (@levie) on X", "The never-ending last mile of work…")).toBe(
      "The never-ending last mile of work",
    );
  });

  it("collapses whitespace in both before comparing", () => {
    expect(pageText('A on X: "One  two\nthree" / X', "One two…")).toBe("One two three");
  });

  it.each([
    ["no og:title", "", "The never-ending last mile of work"],
    ["a generic og:title", "X - The Everything App", "The never-ending last mile of work"],
    ["an empty og:description", 'A on X: "The never-ending last mile of work" / X', ""],
    ["only an ellipsis", 'A on X: "Title" / X', "…"],
    ["only links", "A (@a) on X", "https://t.co/a pic.twitter.com/b"],
    ["the quoted title only a link", 'A on X: "https://t.co/a" / X', "https://t.co/a…"],
  ])("null for %s", (_label, title, description) => {
    expect(pageText(title, description)).toBeNull();
  });
});

describe("SAT-48: an X post's own photo", () => {
  const PHOTO_HTML =
    '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">Sunset <a href="https://t.co/AbC123">pic.twitter.com/AbC123</a></p>&mdash; Naval (@naval) <a href="https://twitter.com/naval/status/1002103360646823936">May 31, 2018</a></blockquote>\n';
  const PHOTO_OEMBED = `{"url":"https://x.com/naval/status/${ID}","author_name":"Naval","author_url":"https://twitter.com/naval","html":${esc(PHOTO_HTML)},"type":"rich","version":"1.0"}`;
  const photoPage = (image: string) =>
    xPage("Naval (@naval) on X", "Sunset https://t.co/AbC123").replace(
      "<title>",
      `<meta property="og:image" content="${image}"/><title>`,
    );

  it("a post with a pic.twitter.com link reads the page as Twitterbot; its pbs.twimg.com/media og:image is the image", async () => {
    const { seen, record } = recorder();
    const page = photoPage("https://pbs.twimg.com/media/GaBc.jpg?format=jpg&amp;name=large");
    network.use(
      http.get(OEMBED, ({ request }) => {
        record(request);
        return jsonText(PHOTO_OEMBED);
      }),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(page);
      }),
    );

    const result = await lookupX(ID, signal());

    expect(result).toEqual({
      title: "Naval: Sunset pic.twitter.com/AbC123",
      url: `https://x.com/naval/status/${ID}`,
      description: "Sunset pic.twitter.com/AbC123",
      author: "Naval",
      handle: "naval",
      source: "x-oembed",
      image: "https://pbs.twimg.com/media/GaBc.jpg?format=jpg&name=large",
      bytesRead: bytes(PHOTO_OEMBED) + bytes(page),
    });
    expect(seen.map((s) => [s.url.split("?")[0], s.userAgent])).toEqual([
      [OEMBED, null],
      [PAGE, "Twitterbot/1.0"],
    ]);
  });

  it("an avatar og:image is no image; the oEmbed result is unchanged", async () => {
    network.use(
      http.get(OEMBED, () => jsonText(PHOTO_OEMBED)),
      http.get(PAGE, () => htmlText(photoPage("https://pbs.twimg.com/profile_images/1/naval_400x400.jpg"))),
    );

    const result = await lookupX(ID, signal());

    expect(result?.image).toBeUndefined();
    expect(result?.title).toBe("Naval: Sunset pic.twitter.com/AbC123");
  });

  it("the Twitterbot fallback (oEmbed down) keeps a post photo too", async () => {
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)),
      http.get(PAGE, () => htmlText(photoPage("https://pbs.twimg.com/media/GaBc.jpg"))),
    );

    const result = await lookupX(ID, signal());

    expect(result).toMatchObject({ source: "x-twitterbot", image: "https://pbs.twimg.com/media/GaBc.jpg" });
  });

  it(
    "a slow oEmbed leaves the photo read only what's left of 4.5 s, so the title survives the 5 s lookup cap",
    { timeout: 15_000 },
    async () => {
      network.use(
        http.get(OEMBED, async () => {
          await new Promise((r) => setTimeout(r, 3800));
          return jsonText(PHOTO_OEMBED);
        }),
        http.get(PAGE, () => new Promise<Response>(() => {})),
      );

      const start = performance.now();
      const result = await lookupTitle(`https://x.com/i/status/${ID}`, "x", AbortSignal.timeout(5000));
      const elapsed = performance.now() - start;

      expect(result).toMatchObject({ title: "Naval: Sunset pic.twitter.com/AbC123", source: "x-oembed" });
      expect(result.image).toBeUndefined();
      expect(elapsed).toBeGreaterThanOrEqual(4400);
      expect(elapsed).toBeLessThan(4900);
    },
  );
});

// SAT-55: an oEmbed for a post whose <p> is `paragraph`, author Naval.
const oembedWith = (paragraph: string) =>
  `{"url":"https://x.com/naval/status/${ID}","author_name":"Naval","author_url":"https://twitter.com/naval","html":${esc(
    `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${paragraph}</p>&mdash; Naval (@naval) <a href="https://twitter.com/naval/status/${ID}">May 31, 2018</a></blockquote>\n`,
  )},"type":"rich","version":"1.0"}`;

describe("SAT-55: named entities in X post text", () => {
  const encoded =
    "Ship it &mdash; today&hellip; &ldquo;Quoted&rdquo; &lsquo;single&rsquo; 1&ndash;2&nbsp;days &amp; &lt;b&gt; &apos;a&apos; &quot;q&quot;";
  const decoded = "Ship it — today… “Quoted” ‘single’ 1–2 days & <b> 'a' \"q\"";

  it("oEmbed post text decodes mdash, ndash, hellip, nbsp and curly quotes", async () => {
    network.use(http.get(OEMBED, () => jsonText(oembedWith(encoded))));

    const result = await lookupX(ID, signal());

    expect(result?.description).toBe(decoded);
    expect(result?.title).toBe(`Naval: ${decoded}`);
  });

  it("the Twitterbot page's og tags decode them too", async () => {
    network.use(
      http.get(OEMBED, () => htmlText(NOT_FOUND_HTML, 404)),
      http.get(PAGE, () => htmlText(xPage("Naval &mdash; N (@naval) on X", encoded))),
    );

    const result = await lookupX(ID, signal());

    expect(result).toMatchObject({ author: "Naval — N", description: decoded, source: "x-twitterbot" });
  });

  it("an unknown named entity stays as written", async () => {
    network.use(http.get(OEMBED, () => jsonText(oembedWith("A &notanentity; B &mdash C"))));

    const result = await lookupX(ID, signal());

    expect(result?.description).toBe("A &notanentity; B &mdash C");
  });
});

describe("SAT-55: a display URL is a link only when X marks it as one", () => {
  it("words that look like a host plus a path are post text", () => {
    expect(isOnlyLinks("Node.js/Deno")).toBe(false);
    expect(isOnlyLinks("Node.js/Deno ship today")).toBe(false);
    expect(isOnlyLinks("box.com/blog/ai-agents-a…")).toBe(false);
  });

  it("t.co, pic.twitter.com and any http(s) URL are links from the text alone", () => {
    expect(isOnlyLinks("https://t.co/a pic.twitter.com/b")).toBe(true);
    expect(isOnlyLinks("https://www.box.com/blog/ai-agents")).toBe(true);
  });

  it("a display URL is a link when it's the text of one of the post's t.co anchors", () => {
    expect(isOnlyLinks("box.com/blog/ai-agents-a…", ["box.com/blog/ai-agents-a…"])).toBe(true);
    expect(isOnlyLinks("box.com/blog/x pic.twitter.com/b", ["box.com/blog/x"])).toBe(true);
    expect(isOnlyLinks("Node.js/Deno box.com/blog/x", ["box.com/blog/x"])).toBe(false);
    expect(isOnlyLinks("Node.js/Deno", [""])).toBe(false);
  });

  it("oEmbed: `links` holds the display text of t.co anchors only, never hashtags, mentions or text", async () => {
    network.use(
      http.get(OEMBED, () =>
        jsonText(
          oembedWith(
            'Node.js/Deno ship today <a href="https://t.co/a">deno.com/blog/v2…</a> ' +
              '<a href="https://t.co/b">https://t.co/b</a> <a href="https://t.co/c">pic.twitter.com/c</a> ' +
              '<a href="https://twitter.com/hashtag/JS?src=hash&amp;ref_src=twsrc%5Etfw">#JS</a> ' +
              '<a href="https://twitter.com/deno_land?ref_src=twsrc%5Etfw">@deno_land</a> ' +
              '<a href="https://t.co/d">example.com/a&amp;b</a>',
          ),
        ),
      ),
      http.get(PAGE, () => htmlText("<html></html>", 404)),
    );

    const result = await lookupX(ID, signal());

    expect(result?.description).toBe(
      "Node.js/Deno ship today deno.com/blog/v2… https://t.co/b pic.twitter.com/c #JS @deno_land example.com/a&b",
    );
    expect(result?.links).toEqual(["deno.com/blog/v2…", "example.com/a&b"]);
  });

  it("oEmbed: a post with no display-URL anchor has no `links`", async () => {
    network.use(http.get(OEMBED, () => jsonText(OPENAI_OEMBED)));

    const result = await lookupX(ID, signal());

    expect(result).not.toHaveProperty("links");
  });

  it("oEmbed: a <p> that's only a display-URL anchor reads the page for text (SAT-43)", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, () => jsonText(oembedWith('<a href="https://t.co/Lv1eB0x">box.com/blog/ai-agents-a…</a>'))),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(xPage("Naval on X: &quot;An Article&quot; / X", "An Article…"));
      }),
    );

    const result = await lookupX(ID, signal());

    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ description: "An Article", article: true });
    // The article title replaced the oEmbed text, so its links no longer apply.
    expect(result).not.toHaveProperty("links");
  });

  it("oEmbed: a <p> whose only host-and-path-looking text isn't an anchor is post text", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, () => jsonText(oembedWith("Node.js/Deno"))),
      http.get(PAGE, ({ request }) => {
        record(request);
        return htmlText(NAVAL_PAGE);
      }),
    );

    const result = await lookupX(ID, signal());

    expect(seen).toHaveLength(0);
    expect(result?.description).toBe("Node.js/Deno");
  });
});
