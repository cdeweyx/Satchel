/// <reference types="vite/client" />
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { lookupMedia } from "../src/title/media";
import mediaSource from "../src/title/media.ts?raw";
import { network } from "./network";

// Records every outbound request, then answers with `respond` (default: network error).
function recordAll(respond: () => Response = () => HttpResponse.error()) {
  const seen: string[] = [];
  network.use(
    http.all("*", ({ request }) => {
      seen.push(request.url);
      return respond();
    }),
  );
  return seen;
}

const never = () => new AbortController().signal;
const q = encodeURIComponent;

// Body shapes follow the L3 probes (docs/research/03-titles-urls.md): each endpoint answers
// 200 application/json with `title`; Vimeo answers 404 for a missing video.
const cases = [
  {
    name: "YouTube",
    stored: "https://youtube.com/watch?v=dQw4w9WgXcQ",
    endpoint: "https://www.youtube.com/oembed",
    request: `https://www.youtube.com/oembed?format=json&url=${q("https://youtube.com/watch?v=dQw4w9WgXcQ")}`,
    body: {
      title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      author_name: "Rick Astley",
      author_url: "https://www.youtube.com/@RickAstleyYT",
      type: "video",
      provider_name: "YouTube",
      provider_url: "https://www.youtube.com/",
      version: "1.0",
    },
  },
  {
    name: "YouTube www form",
    stored: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    endpoint: "https://www.youtube.com/oembed",
    request: `https://www.youtube.com/oembed?format=json&url=${q("https://www.youtube.com/watch?v=aqz-KE-bpKQ")}`,
    body: { title: "Big Buck Bunny 60fps 4K", author_name: "Peach", type: "video", provider_name: "YouTube" },
  },
  {
    name: "Spotify",
    stored: "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5",
    endpoint: "https://open.spotify.com/oembed",
    request: `https://open.spotify.com/oembed?url=${q("https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5")}`,
    body: {
      title: "My Path to Spotify: Women in Engineering",
      type: "rich",
      provider_name: "Spotify",
      provider_url: "https://spotify.com",
      version: "1.0",
    },
  },
  {
    name: "Vimeo",
    stored: "https://vimeo.com/76979871",
    endpoint: "https://vimeo.com/api/oembed.json",
    request: `https://vimeo.com/api/oembed.json?url=${q("https://vimeo.com/76979871")}`,
    body: {
      type: "video",
      version: "1.0",
      provider_name: "Vimeo",
      title: "The New Vimeo Player (You Know, For Videos)",
      author_name: "Vimeo",
      video_id: 76979871,
    },
  },
  {
    name: "TikTok",
    stored: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
    endpoint: "https://www.tiktok.com/oembed",
    request: `https://www.tiktok.com/oembed?url=${q("https://www.tiktok.com/@scout2015/video/6718335390845095173")}`,
    body: {
      version: "1.0",
      type: "video",
      title: "Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic",
      author_name: "Scout, Suki & Stella",
      provider_name: "TikTok",
    },
  },
  {
    name: "SoundCloud",
    stored: "https://soundcloud.com/forss/flickermood",
    endpoint: "https://soundcloud.com/oembed",
    request: `https://soundcloud.com/oembed?format=json&url=${q("https://soundcloud.com/forss/flickermood")}`,
    body: {
      version: 1,
      type: "rich",
      provider_name: "SoundCloud",
      title: "Flickermood by Forss",
      author_name: "Forss",
    },
  },
] as const;

describe("lookupMedia: one fixture per endpoint", () => {
  for (const c of cases) {
    it(`${c.name}: calls ${c.endpoint} with the stored URL and returns its title`, async () => {
      const seen: string[] = [];
      const payload = JSON.stringify(c.body);
      network.use(
        http.get(c.endpoint, ({ request }) => {
          seen.push(request.url);
          return new HttpResponse(payload, {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }),
      );

      const result = await lookupMedia(c.stored, never());

      expect(seen).toEqual([c.request]);
      expect(result).toEqual({
        title: c.body.title,
        source: "media-oembed",
        bytesRead: new TextEncoder().encode(payload).byteLength,
      });
    });
  }
});

describe("lookupMedia: null cases", () => {
  it("Vimeo 404 for a missing video → null", async () => {
    const seen: string[] = [];
    network.use(
      http.get("https://vimeo.com/api/oembed.json", ({ request }) => {
        seen.push(request.url);
        return new HttpResponse("404 Not Found", { status: 404, headers: { "content-type": "text/html" } });
      }),
    );
    expect(await lookupMedia("https://vimeo.com/148751763", never())).toBeNull();
    expect(seen).toEqual([`https://vimeo.com/api/oembed.json?url=${q("https://vimeo.com/148751763")}`]);
  });

  it("empty or missing title → null", async () => {
    for (const body of [{ title: "" }, { title: "   " }, { author_name: "Someone" }, { title: 42 }]) {
      network.use(http.get("https://www.youtube.com/oembed", () => HttpResponse.json(body)));
      expect(await lookupMedia("https://youtube.com/watch?v=x", never())).toBeNull();
    }
  });

  it("200 with a non-JSON content type or a bad body → null", async () => {
    network.use(
      http.get("https://open.spotify.com/oembed", () =>
        HttpResponse.text("<html><title>Spotify</title></html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    expect(await lookupMedia("https://open.spotify.com/episode/a", never())).toBeNull();

    network.use(
      http.get("https://open.spotify.com/oembed", () =>
        HttpResponse.text("{not json", { headers: { "content-type": "application/json" } }),
      ),
    );
    expect(await lookupMedia("https://open.spotify.com/episode/a", never())).toBeNull();
  });

  it("network error → null, never throws", async () => {
    network.use(http.get("https://soundcloud.com/oembed", () => HttpResponse.error()));
    await expect(lookupMedia("https://soundcloud.com/a/b", never())).resolves.toBeNull();
  });

  it("Apple Podcasts, Overcast, Pocket Casts, Twitch and plain pages → null with no request", async () => {
    const seen = recordAll();
    for (const stored of [
      "https://podcasts.apple.com/us/podcast/lex-fridman-podcast/id1434243584",
      "https://podcasts.apple.com/us/podcast/lennys-podcast/id1627920305?i=1000600000000",
      "https://overcast.fm/+AAbRzG5RzBI",
      "https://pca.st/episode/abc",
      "https://pocketcasts.com/podcast/abc",
      "https://twitch.tv/somestreamer",
      "https://paulgraham.com/greatwork.html",
    ]) {
      expect(await lookupMedia(stored, never())).toBeNull();
    }
    expect(seen).toEqual([]);
  });

  it("a caller abort → null", async () => {
    network.use(http.get("https://vimeo.com/api/oembed.json", () => new Promise<Response>(() => {})));
    const ctrl = new AbortController();
    const pending = lookupMedia("https://vimeo.com/76979871", ctrl.signal);
    ctrl.abort();
    expect(await pending).toBeNull();
  });
});

describe("lookupMedia: no iTunes lookup", () => {
  it("the source never mentions the iTunes API", () => {
    expect(mediaSource).not.toMatch(/itunes/i);
    expect(mediaSource).not.toMatch(/\/lookup\b/);
  });
});

describe("lookupMedia: 4 s per fetch", () => {
  // Real wait: AbortSignal.timeout runs on workerd's own clock, which vi.useFakeTimers
  // doesn't control, so this one test takes about 4 s.
  it("a hanging endpoint resolves to null in about 4 s", { timeout: 10_000 }, async () => {
    const seen: string[] = [];
    network.use(
      http.get("https://www.youtube.com/oembed", ({ request }) => {
        seen.push(request.url);
        return new Promise<Response>(() => {});
      }),
    );
    const start = performance.now();
    const result = await lookupMedia("https://youtube.com/watch?v=dQw4w9WgXcQ", never());
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(3900);
    expect(elapsed).toBeLessThan(5000);
  });
});
