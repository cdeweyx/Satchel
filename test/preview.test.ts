import { describe, expect, it } from "vitest";
import { httpsUrl, isXPostMedia, previewBlock, summary } from "../src/preview";
import type { LookupResult } from "../src/title";

const image = (url: string) => ({ type: "image", image: { type: "external", external: { url } } });
const paragraph = (content: string) => ({
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content } }] },
});
const page = (over: Partial<LookupResult> = {}): LookupResult => ({ title: "T", source: "page", bytesRead: 1, ...over });

describe("SAT-48 previewBlock: lookup result to the one block, or none", () => {
  it("an https image wins over a description", () => {
    expect(previewBlock(page({ image: "https://cdn.example.com/a.jpg", description: "Summary." }))).toEqual(
      image("https://cdn.example.com/a.jpg"),
    );
  });

  it("a page with only a description is one paragraph", () => {
    expect(previewBlock(page({ description: "  Summary   text. " }))).toEqual(paragraph("Summary text."));
  });

  it("nothing to add is null", () => {
    expect(previewBlock(page())).toBeNull();
    expect(previewBlock(page({ description: "   " }))).toBeNull();
    expect(previewBlock({ title: null, source: "fallback", bytesRead: 0 })).toBeNull();
  });

  it("an image that isn't https, or is past Notion's 2000-char URL limit, isn't used", () => {
    expect(previewBlock(page({ image: "http://cdn.example.com/a.jpg", description: "S." }))).toEqual(paragraph("S."));
    const long = `https://cdn.example.com/${"a".repeat(2000)}.jpg`;
    expect(previewBlock(page({ image: long }))).toBeNull();
  });

  // SAT-52 replaced SAT-48's "X posts get an image or nothing" test: Conor ruled a text-only
  // post shows its post text.
  it("SAT-52: an X post's photo wins; with no photo its post text, links stripped, is one paragraph", () => {
    const x: LookupResult = {
      title: "Naval: Read https://t.co/AbC123  this pic.twitter.com/XyZ",
      description: "Read https://t.co/AbC123  this\npic.twitter.com/XyZ",
      source: "x-oembed",
      bytesRead: 1,
    };
    expect(previewBlock(x)).toEqual(paragraph("Read this"));
    expect(previewBlock({ ...x, source: "x-twitterbot" })).toEqual(paragraph("Read this"));
    expect(previewBlock({ ...x, image: "https://pbs.twimg.com/media/A.jpg" })).toEqual(
      image("https://pbs.twimg.com/media/A.jpg"),
    );
  });

  it("SAT-52: an X post with only links, or no text, gets nothing", () => {
    const x = (description?: string, links?: string[]): LookupResult => ({
      title: `X: ${description}`,
      ...(description === undefined ? {} : { description }),
      ...(links ? { links } : {}),
      source: "x-oembed",
      bytesRead: 1,
    });
    expect(previewBlock(x("https://t.co/Lv1eB0x"))).toBeNull();
    expect(previewBlock(x("pic.twitter.com/AbC123"))).toBeNull();
    // SAT-55: the display URL is a link because X anchored it (`links`).
    expect(previewBlock(x("box.com/blog/ai-agents-a… pic.twitter.com/b", ["box.com/blog/ai-agents-a…"]))).toBeNull();
    expect(previewBlock(x("  "))).toBeNull();
    // Review fix: what's left after the links has no letter or digit.
    expect(previewBlock(x("— https://t.co/a"))).toBeNull();
    expect(previewBlock(x("👇 https://t.co/a"))).toBeNull();
    expect(previewBlock(x("👇 2 https://t.co/a"))).toEqual(paragraph("👇 2"));
    expect(previewBlock(x("Ça va https://t.co/a"))).toEqual(paragraph("Ça va"));
    expect(previewBlock(x())).toBeNull();
  });

  it("SAT-52: X text keeps words that only look like hosts, and is cut to about 300 characters", () => {
    const x = (description: string, links?: string[]): LookupResult => ({
      title: "t",
      description,
      ...(links ? { links } : {}),
      source: "x-oembed",
      bytesRead: 1,
    });
    // SAT-55: example.com/path is a link because X anchored it (`links`), not from its shape.
    expect(previewBlock(x("Node.js and box.com are text; example.com/path isn't", ["example.com/path"]))).toEqual(
      paragraph("Node.js and box.com are text; isn't"),
    );
    const long = `${"word ".repeat(70)}https://t.co/z`;
    expect(previewBlock(x(long))).toEqual(paragraph(`${"word ".repeat(60).trimEnd()}…`));
  });

  it("SAT-55: X text keeps words shaped like a host plus a path unless X anchored them", () => {
    const x = (description: string, links?: string[]): LookupResult => ({
      title: "t",
      description,
      ...(links ? { links } : {}),
      source: "x-oembed",
      bytesRead: 1,
    });
    expect(previewBlock(x("Node.js/Deno ship today"))).toEqual(paragraph("Node.js/Deno ship today"));
    expect(previewBlock(x("Node.js/Deno ship today https://t.co/a pic.twitter.com/b"))).toEqual(
      paragraph("Node.js/Deno ship today"),
    );
    expect(previewBlock(x("Node.js/Deno ship today deno.com/blog/v2…", ["deno.com/blog/v2…"]))).toEqual(
      paragraph("Node.js/Deno ship today"),
    );
    // An anchored link only strips its own text, and a blank anchor strips nothing.
    expect(previewBlock(x("See example.com/a and example.com/b", ["example.com/a"]))).toEqual(
      paragraph("See and example.com/b"),
    );
    expect(previewBlock(x("Node.js/Deno ship today", [""]))).toEqual(paragraph("Node.js/Deno ship today"));
    expect(previewBlock({ ...x("Node.js/Deno ship today"), source: "x-twitterbot" })).toEqual(
      paragraph("Node.js/Deno ship today"),
    );
  });

  it("SAT-52: an X Article with no image is a paragraph of its article title; with an image, the image", () => {
    const article: LookupResult = {
      title: "Aaron Levie: The never-ending last mile of work",
      description: "The never-ending last mile of work",
      author: "Aaron Levie",
      source: "x-oembed",
      article: true,
      bytesRead: 1,
    };
    expect(previewBlock(article)).toEqual(paragraph("The never-ending last mile of work"));
    expect(previewBlock({ ...article, image: "https://pbs.twimg.com/media/B.jpg" })).toEqual(
      image("https://pbs.twimg.com/media/B.jpg"),
    );
  });

  it("media oEmbed gets its thumbnail, no paragraph", () => {
    const media: LookupResult = { title: "Video", source: "media-oembed", bytesRead: 1 };
    expect(previewBlock(media)).toBeNull();
    expect(previewBlock({ ...media, image: "https://i.ytimg.com/vi/x/hqdefault.jpg" })).toEqual(
      image("https://i.ytimg.com/vi/x/hqdefault.jpg"),
    );
  });
});

describe("SAT-48 summary", () => {
  it("leaves 300 characters or fewer alone", () => {
    const text = "a".repeat(300);
    expect(summary(text)).toBe(text);
  });

  it("cuts on the last word boundary at or before 300 and ends in …", () => {
    const text = `${"word ".repeat(70)}end`; // 353 chars
    const out = summary(text);
    expect(out).toBe(`${"word ".repeat(60).trimEnd()}…`);
    expect(out.length).toBeLessThanOrEqual(301);
  });

  it("a word ending exactly at 300 is kept whole", () => {
    const text = `${"a".repeat(299)}b more`;
    expect(summary(text)).toBe(`${"a".repeat(299)}b…`);
  });

  it("drops trailing punctuation before the ellipsis", () => {
    const text = `${"x".repeat(290)}, and then some more words here`;
    expect(summary(text)).toBe(`${"x".repeat(290)}, and then…`);
    expect(summary(`${"y".repeat(295)}, ${"z".repeat(20)}`)).toBe(`${"y".repeat(295)}…`);
  });

  it("one unbroken run is hard-cut at 300 code points, never splitting an emoji", () => {
    const out = summary("😀".repeat(400));
    expect(Array.from(out)).toHaveLength(301);
    expect(out.endsWith("😀…")).toBe(true);
  });
});

describe("SAT-48 httpsUrl and isXPostMedia", () => {
  it("resolves relative and protocol-relative URLs, keeps https only", () => {
    const base = "https://example.com/post/hello";
    expect(httpsUrl("/img/a.png", base)).toBe("https://example.com/img/a.png");
    expect(httpsUrl("img/a.png", base)).toBe("https://example.com/post/img/a.png");
    expect(httpsUrl("//cdn.example.com/a.png", base)).toBe("https://cdn.example.com/a.png");
    expect(httpsUrl("http://cdn.example.com/a.png", base)).toBeNull();
    expect(httpsUrl("data:image/png;base64,AAAA", base)).toBeNull();
    expect(httpsUrl("/img/a.png")).toBeNull();
    expect(httpsUrl("  ", base)).toBeNull();
    expect(httpsUrl(undefined, base)).toBeNull();
  });

  it("only pbs.twimg.com/media is an X post's photo", () => {
    expect(isXPostMedia("https://pbs.twimg.com/media/GaBc.jpg?format=jpg&name=large")).toBe(true);
    expect(isXPostMedia("https://pbs.twimg.com/profile_images/1/a_400x400.jpg")).toBe(false);
    expect(isXPostMedia("https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg")).toBe(false);
    expect(isXPostMedia("https://abs.twimg.com/rweb/ssr/default/v2/og/image.png")).toBe(false);
    expect(isXPostMedia("http://pbs.twimg.com/media/GaBc.jpg")).toBe(false);
    expect(isXPostMedia("https://pbs.twimg.com.evil.com/media/a.jpg")).toBe(false);
    expect(isXPostMedia("")).toBe(false);
  });
});
