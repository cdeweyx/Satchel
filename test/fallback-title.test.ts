import { describe, expect, it } from "vitest";
import { fallbackTitle, isMissingTitle, type LinkKind } from "../src/fallback-title";

// Expected values come from D-3's fallback rule and the SAT-5 brief, not from running the code.
const fixtures: Array<{ name: string; raw: string; kind: LinkKind; expected: string }> = [
  {
    name: "Medium slug drops the trailing hex id",
    raw: "https://medium.com/@kentbeck_7670/thinking-about-code-review-cfd6e3b6cc7d?source=rss----abc",
    kind: "page",
    expected: "Thinking about code review · medium.com",
  },
  {
    name: "GitHub path with a trailing slash",
    raw: "https://github.com/cloudflare/workers-sdk/",
    kind: "page",
    expected: "Workers sdk · github.com",
  },
  {
    name: "Substack slug drops the trailing numeric token and www.",
    raw: "https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29?utm_source=substack",
    kind: "page",
    expected: "What is good retention issue · lennysnewsletter.com",
  },
  {
    name: "underscores become spaces",
    raw: "https://example.com/blog/my_first_post",
    kind: "page",
    expected: "My first post · example.com",
  },
  {
    name: "a hex-looking word without digits is kept",
    raw: "https://example.com/blog/visit-the-cafe",
    kind: "page",
    expected: "Visit the cafe · example.com",
  },
  {
    name: "percent-encoded slug is decoded",
    raw: "https://example.com/wiki/caf%C3%A9-culture",
    kind: "page",
    expected: "Café culture · example.com",
  },
  {
    name: "NYT page extension is stripped",
    raw: "https://www.nytimes.com/2025/01/27/technology/deepseek.html?unlocked_article_code=1.abc",
    kind: "page",
    expected: "Deepseek · nytimes.com",
  },
  {
    name: "uppercase page extension is stripped",
    raw: "https://example.com/news/big-announcement.ASPX",
    kind: "page",
    expected: "Big announcement · example.com",
  },
  { name: "bare root", raw: "https://example.com/", kind: "page", expected: "example.com" },
  { name: "bare root without slash, www. dropped", raw: "https://www.example.com", kind: "page", expected: "example.com" },
  { name: "host is lowercased", raw: "https://EXAMPLE.com/", kind: "page", expected: "example.com" },
  { name: "id-only last segment falls back to hostname", raw: "https://example.com/posts/12345", kind: "page", expected: "example.com" },
  { name: "m. dropped from a media host", raw: "https://m.youtube.com/watch?v=dQw4w9WgXcQ", kind: "media", expected: "Watch · youtube.com" },
  {
    name: "X with username (share sheet params)",
    raw: "https://x.com/naval/status/1002103360646823936?s=46&t=abcDEF",
    kind: "x",
    expected: "@naval on X",
  },
  { name: "X via twitter.com", raw: "https://twitter.com/naval/status/1002103360646823936", kind: "x", expected: "@naval on X" },
  {
    name: "X via mobile.twitter.com",
    raw: "https://mobile.twitter.com/naval/status/1002103360646823936",
    kind: "x",
    expected: "@naval on X",
  },
  { name: "X with /photo/1 suffix", raw: "https://x.com/naval/status/1002103360646823936/photo/1", kind: "x", expected: "@naval on X" },
  { name: "X statuses form", raw: "https://twitter.com/naval/statuses/1002103360646823936", kind: "x", expected: "@naval on X" },
  {
    name: "X without username (i/status)",
    raw: "https://x.com/i/status/1002103360646823936",
    kind: "x",
    expected: "X post 1002103360646823936",
  },
  {
    name: "X without username (i/web/status)",
    raw: "https://x.com/i/web/status/1002103360646823936",
    kind: "x",
    expected: "X post 1002103360646823936",
  },
  { name: "unparsable raw is returned trimmed", raw: "  not a url  ", kind: "page", expected: "not a url" },
  { name: "empty raw becomes Untitled", raw: "", kind: "page", expected: "Untitled" },
  { name: "whitespace raw becomes Untitled", raw: "   ", kind: "x", expected: "Untitled" },
];

describe("fallbackTitle", () => {
  for (const f of fixtures) {
    it(`${f.name}: ${JSON.stringify(f.raw)} -> ${JSON.stringify(f.expected)}`, () => {
      expect(fallbackTitle(f.raw, f.kind)).toBe(f.expected);
    });
  }

  it("is never empty for any fixture, including https://example.com/", () => {
    const raws = [...fixtures.map((f) => f.raw), "https://example.com/"];
    for (const raw of raws) {
      for (const kind of ["x", "media", "page"] as const) {
        expect(fallbackTitle(raw, kind).trim(), `${kind} ${raw}`).not.toBe("");
      }
    }
  });
});

describe("isMissingTitle", () => {
  const xRaw = "https://x.com/naval/status/1002103360646823936?s=46&t=abcDEF";
  const xStored = "https://x.com/i/status/1002103360646823936";
  const mailRaw =
    "https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29?utm_source=substack&utm_medium=email&r=abc&s=r";
  const mailStored = "https://lennysnewsletter.com/p/what-is-good-retention-issue-29";

  it("is true for an empty or absent title", () => {
    expect(isMissingTitle("", xRaw, xStored)).toBe(true);
    expect(isMissingTitle(undefined, xRaw, xStored)).toBe(true);
  });

  it("is true for a whitespace-only title", () => {
    expect(isMissingTitle("  \n\t ", xRaw, xStored)).toBe(true);
  });

  it("is true when the title is the raw URL (X share sheet)", () => {
    expect(isMissingTitle(xRaw, xRaw, xStored)).toBe(true);
  });

  it("is true when the title is the raw URL (Mail share sheet)", () => {
    expect(isMissingTitle(mailRaw, mailRaw, mailStored)).toBe(true);
  });

  it("is true when the title is the stored URL", () => {
    expect(isMissingTitle(xStored, xRaw, xStored)).toBe(true);
    expect(isMissingTitle(mailStored, mailRaw, mailStored)).toBe(true);
  });

  it("compares after trim and ignores a trailing slash on either side", () => {
    expect(isMissingTitle(`  ${xRaw}  `, xRaw, xStored)).toBe(true);
    expect(isMissingTitle("https://example.com/a/", "https://example.com/a", "https://example.com/a")).toBe(true);
    expect(isMissingTitle("https://github.com/cloudflare/workers-sdk", "https://github.com/cloudflare/workers-sdk/", "https://github.com/x/y")).toBe(true);
  });

  it("is false for a real title", () => {
    expect(isMissingTitle("Thinking About Code Review", mailRaw, mailStored)).toBe(false);
    expect(isMissingTitle("Naval: How to Get Rich", xRaw, xStored)).toBe(false);
  });
});
