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

  it("X posts get an image or nothing, never a paragraph of post text", () => {
    const x: LookupResult = { title: "Naval: hi", description: "hi", source: "x-oembed", bytesRead: 1 };
    expect(previewBlock(x)).toBeNull();
    expect(previewBlock({ ...x, source: "x-twitterbot" })).toBeNull();
    expect(previewBlock({ ...x, image: "https://pbs.twimg.com/media/A.jpg" })).toEqual(
      image("https://pbs.twimg.com/media/A.jpg"),
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
