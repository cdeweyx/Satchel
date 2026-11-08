/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../src/canonical";
import canonicalSource from "../src/canonical.ts?raw";
import fixturesText from "./fixtures/urls.json?raw";

interface Row {
  input: string;
  stored: string;
  kind: "x" | "media" | "page";
  media: boolean;
  bare?: string;
  xId?: string;
}

const fixtures = JSON.parse(fixturesText) as {
  l3: Row[];
  nytimesHostForms: Row[];
  paramReadWrappers: Row[];
  keptWrappers: Row[];
};

function checkRow(row: Row): void {
  const got = canonicalize(row.input);
  expect(got.stored).toBe(row.stored);
  expect(got.kind).toBe(row.kind);
  expect(got.media).toBe(row.media);
  if (row.kind === "x") {
    expect(got.dedupe).toEqual({ type: "x", id: row.xId });
    return;
  }
  const bare = row.bare!;
  expect(got.dedupe).toEqual({
    type: "url",
    bare,
    www: bare.replace(/^https:\/\//, "https://www."),
    raw: row.input,
  });
}

describe("canonicalize: fixtures", () => {
  it("has the 20 L3 rows, 3 nytimes host forms and 3 param-read wrappers", () => {
    expect(fixtures.l3).toHaveLength(20);
    expect(fixtures.nytimesHostForms).toHaveLength(3);
    expect(fixtures.paramReadWrappers).toHaveLength(3);
  });

  it.each(fixtures.l3.map((r) => [r.input, r] as const))("L3: %s", (_, row) => checkRow(row));

  it.each(fixtures.nytimesHostForms.map((r) => [r.input, r] as const))("nytimes host form: %s", (_, row) =>
    checkRow(row),
  );

  it("the m., www. and bare nytimes forms share one dedupe key (bare and www forms)", () => {
    const keys = fixtures.nytimesHostForms.map((r) => canonicalize(r.input).dedupe);
    for (const k of keys) {
      if (k.type !== "url") throw new Error("expected a url key");
      expect(k.bare).toBe("https://nytimes.com/2025/01/27/technology/deepseek.html");
      expect(k.www).toBe("https://www.nytimes.com/2025/01/27/technology/deepseek.html");
    }
  });

  it.each(fixtures.paramReadWrappers.map((r) => [r.input, r] as const))("param-read wrapper: %s", (_, row) =>
    checkRow(row),
  );

  it.each(fixtures.keptWrappers.map((r) => [r.input, r] as const))(
    "follow-only wrapper stays as given (no redirect following): %s",
    (_, row) => checkRow(row),
  );
});

describe("canonicalize: stored form", () => {
  const stored = (raw: string) => canonicalize(raw).stored;

  it("lowercases the host and keeps path case", () => {
    expect(stored("https://GitHub.COM/CloudFlare/Workers-SDK")).toBe("https://github.com/CloudFlare/Workers-SDK");
  });

  it("drops m. and mobile. but keeps www. as given", () => {
    expect(stored("https://m.example.com/a")).toBe("https://example.com/a");
    expect(stored("https://mobile.example.com/a")).toBe("https://example.com/a");
    expect(stored("https://www.example.com/a")).toBe("https://www.example.com/a");
    expect(stored("https://example.com/a")).toBe("https://example.com/a");
  });

  it("drops the fragment and the trailing slash on non-root paths", () => {
    expect(stored("https://example.com/a/b/#top")).toBe("https://example.com/a/b");
    expect(stored("https://example.com/a/b/?x=1")).toBe("https://example.com/a/b?x=1");
    expect(stored("https://example.com/")).toBe("https://example.com/");
  });

  it("upgrades http to https", () => {
    expect(stored("http://example.com/a")).toBe("https://example.com/a");
  });

  it("drops a trailing ? whether given empty or emptied by stripping", () => {
    expect(stored("https://example.com/a?")).toBe("https://example.com/a");
    expect(stored("https://example.com/a?utm_source=x&fbclid=1")).toBe("https://example.com/a");
  });

  it("strips global exact and prefix params, keeps others with their order and encoding", () => {
    expect(stored("https://example.com/a?q=a%20b&_hsenc=1&mtm_x=2&Z=3&hsa_acc=4&ref=keep")).toBe(
      "https://example.com/a?q=a%20b&Z=3&ref=keep",
    );
  });

  it("strips YouTube t= on every YouTube form", () => {
    expect(stored("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(stored("https://youtube.com/watch?v=dQw4w9WgXcQ&t=1m2s")).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(stored("https://www.youtube.com/shorts/aqz-KE-bpKQ?t=3")).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  });

  it("keeps t= off YouTube (per-host only)", () => {
    expect(stored("https://example.com/a?t=42")).toBe("https://example.com/a?t=42");
  });

  it("strips Substack r and s only on Substack hosts or with utm_source=substack", () => {
    expect(stored("https://foo.substack.com/p/x?r=abc&s=r")).toBe("https://foo.substack.com/p/x");
    expect(stored("https://example.com/p/x?r=abc&s=r")).toBe("https://example.com/p/x?r=abc&s=r");
    expect(stored("https://example.com/p/x?r=abc&s=r&utm_source=substack")).toBe("https://example.com/p/x");
  });

  it("dedupe.raw is the trimmed input", () => {
    const k = canonicalize("  https://www.example.com/a/?utm_source=x  ").dedupe;
    expect(k).toEqual({
      type: "url",
      bare: "https://example.com/a",
      www: "https://www.example.com/a",
      raw: "https://www.example.com/a/?utm_source=x",
    });
  });

  it("throws a plain Error on unparsable input and non-http(s) schemes", () => {
    for (const bad of ["not a url", "", "ftp://example.com/a", "javascript:alert(1)", "mailto:a@b.com"]) {
      expect(() => canonicalize(bad)).toThrow(Error);
    }
  });

  it("reads nested param-read wrappers and keeps a wrapper with no usable target", () => {
    const inner = encodeURIComponent("https://l.facebook.com/l.php?u=" + encodeURIComponent("https://example.com/a?fbclid=1"));
    expect(stored(`https://google.com/url?url=${inner}`)).toBe("https://example.com/a");
    expect(stored("https://www.google.com/url?q=javascript%3Aalert(1)&sa=D")).toBe(
      "https://www.google.com/url?q=javascript%3Aalert(1)&sa=D",
    );
    expect(stored("https://www.google.com/search?q=https%3A%2F%2Fexample.com")).toBe(
      "https://www.google.com/search?q=https%3A%2F%2Fexample.com",
    );
  });
});

describe("canonicalize: X", () => {
  const hosts = ["twitter.com", "mobile.twitter.com", "x.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com", "www.x.com"];
  const paths = [
    "/i/web/status/20",
    "/i/status/20",
    "/jack/status/20",
    "/jack/statuses/20",
    "/Some_User_15chr/status/20",
    "/jack/status/20/photo/1",
    "/jack/status/20/video/1",
    "/jack/status/20?s=46&t=abc",
  ];
  const cases = hosts.flatMap((h) => paths.map((p) => `https://${h}${p}`));

  it.each(cases)("%s reduces to id 20", (raw) => {
    expect(canonicalize(raw)).toEqual({
      stored: "https://x.com/i/status/20",
      dedupe: { type: "x", id: "20" },
      kind: "x",
      media: false,
    });
  });

  it("leaves non-status X URLs as pages and strips X params on them", () => {
    const got = canonicalize("https://x.com/jack?s=20&t=abc&lang=en");
    expect(got.kind).toBe("page");
    expect(got.stored).toBe("https://x.com/jack?lang=en");
  });

  it("doesn't treat other hosts' /status/ paths as X", () => {
    expect(canonicalize("https://example.com/jack/status/20").kind).toBe("page");
  });
});

describe("canonicalize: Media (D-16)", () => {
  const mediaHosts = [
    "youtube.com",
    "youtu.be",
    "music.youtube.com",
    "vimeo.com",
    "open.spotify.com",
    "spotify.link",
    "podcasts.apple.com",
    "music.apple.com",
    "overcast.fm",
    "pca.st",
    "pocketcasts.com",
    "soundcloud.com",
    "twitch.tv",
    "tiktok.com",
  ];

  it.each(mediaHosts)("%s is media, also under www. and m.", (h) => {
    for (const host of [h, `www.${h}`, `m.${h}`]) {
      const got = canonicalize(`https://${host}/abc123`);
      expect(got.media).toBe(true);
      expect(got.kind).toBe("media");
    }
  });

  it("matches subdomains of a listed host as a suffix", () => {
    expect(canonicalize("https://clips.twitch.tv/abc").media).toBe(true);
  });

  it.each([
    "https://x.com/jack/status/20",
    "https://x.com/jack",
    "https://twitter.com/jack",
    "https://www.instagram.com/p/abc/",
    "https://www.instagram.com/reel/abc/",
    "https://spotify.com/us/premium",
    "https://apple.com/podcasts",
    "https://notyoutube.com/watch?v=1",
  ])("%s is not media", (raw) => {
    expect(canonicalize(raw).media).toBe(false);
  });
});

describe("canonicalize: no network", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the source neither imports nor calls fetch", () => {
    expect(canonicalSource.length).toBeGreaterThan(0);
    expect(canonicalSource).not.toMatch(/\bfetch\b/);
  });

  it("makes no request while canonicalizing every fixture", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const all = [...fixtures.l3, ...fixtures.nytimesHostForms, ...fixtures.paramReadWrappers, ...fixtures.keptWrappers];
    for (const row of all) canonicalize(row.input);
    expect(spy).not.toHaveBeenCalled();
  });
});
