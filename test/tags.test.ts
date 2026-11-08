import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { PROPS } from "../src/config";
import { NotionError, isTagRef } from "../src/notion";
import {
  TAG_CACHE_TTL_MS,
  type TagOptions,
  getTagOptions,
  guardTags,
  invalidateTagCache,
} from "../src/tags";
import { network } from "./network";

const API = "https://api.notion.com/v1";
const DS = "test-data-source-id"; // vitest.config.ts binding
const T0 = 1_000_000; // a fixed clock; tests never read the wall clock

const OPTIONS = [
  { id: "opt-ai", name: "AI", color: "blue" },
  { id: "opt-design", name: "Design", color: "red" },
  { id: "opt-news", name: "News", color: "green" },
  { id: "opt-product", name: "Product", color: "gray" },
  { id: "opt-video", name: "Video", color: "pink" },
  { id: "opt-tools", name: "Dev Tools", color: "yellow" },
];

const schema = (properties: Record<string, unknown>) => ({
  object: "data_source",
  id: DS,
  properties: {
    [PROPS.name]: { id: "title", name: PROPS.name, type: "title", title: {} },
    ...properties,
  },
});
const tagsSchema = (options = OPTIONS) =>
  schema({
    [PROPS.tags]: { id: "t", name: PROPS.tags, type: "multi_select", multi_select: { options } },
  });

// Serves `bodies` in turn (the last one repeats) and counts every retrieve.
function mockRetrieve(...bodies: { body: unknown; status?: number }[]) {
  const counter = { calls: 0 };
  network.use(
    http.get(`${API}/data_sources/${DS}`, () => {
      const next = bodies[Math.min(counter.calls, bodies.length - 1)]!;
      counter.calls++;
      return HttpResponse.json(next.body as Record<string, unknown>, { status: next.status ?? 200 });
    }),
  );
  return counter;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  invalidateTagCache();
});

describe("getTagOptions", () => {
  it("maps the live Tags options by lowercase name to {id, name}", async () => {
    const counter = mockRetrieve({ body: tagsSchema() });

    const options = await getTagOptions(env, T0);

    expect(counter.calls).toBe(1);
    expect(options.size).toBe(OPTIONS.length);
    expect(options.get("ai")).toEqual({ id: "opt-ai", name: "AI" });
    expect(options.get("dev tools")).toEqual({ id: "opt-tools", name: "Dev Tools" });
    expect(options.get("AI")).toBeUndefined();
  });

  it("a second call within the TTL makes no network request", async () => {
    const counter = mockRetrieve({ body: tagsSchema() });

    const first = await getTagOptions(env, T0);
    const second = await getTagOptions(env, T0 + 1);
    const lastMs = await getTagOptions(env, T0 + TAG_CACHE_TTL_MS - 1);

    expect(counter.calls).toBe(1);
    expect(second).toBe(first);
    expect(lastMs).toBe(first);
  });

  it("re-fetches once the TTL has passed and serves the new options", async () => {
    const renamed = OPTIONS.map((o) => (o.id === "opt-ai" ? { ...o, name: "Machine Learning" } : o));
    const counter = mockRetrieve({ body: tagsSchema() }, { body: tagsSchema(renamed) });

    const before = await getTagOptions(env, T0);
    const after = await getTagOptions(env, T0 + TAG_CACHE_TTL_MS);
    const cachedAgain = await getTagOptions(env, T0 + TAG_CACHE_TTL_MS + 1);

    expect(counter.calls).toBe(2);
    expect(before.get("ai")).toEqual({ id: "opt-ai", name: "AI" });
    expect(after.get("ai")).toBeUndefined();
    expect(after.get("machine learning")).toEqual({ id: "opt-ai", name: "Machine Learning" });
    expect(cachedAgain).toBe(after);
  });

  it("invalidateTagCache forces the next call to retrieve again", async () => {
    const counter = mockRetrieve({ body: tagsSchema() });

    await getTagOptions(env, T0);
    invalidateTagCache();
    await getTagOptions(env, T0 + 1);

    expect(counter.calls).toBe(2);
  });

  it("a failed retrieve throws NotionError and isn't cached", async () => {
    const counter = mockRetrieve(
      {
        body: { object: "error", status: 502, code: "service_unavailable", message: "down" },
        status: 502,
      },
      { body: tagsSchema() },
    );

    const err = await caught(getTagOptions(env, T0));
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ status: 502, code: "service_unavailable" });

    const options = await getTagOptions(env, T0 + 1);
    expect(options.get("news")).toEqual({ id: "opt-news", name: "News" });
    expect(counter.calls).toBe(2);
  });

  it("throws NotionError tags_missing when the Tags property is absent, and doesn't cache it", async () => {
    const counter = mockRetrieve({ body: schema({}) }, { body: tagsSchema() });

    const err = await caught(getTagOptions(env, T0));
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ code: "tags_missing" });
    expect(`notion_${(err as NotionError).code}`).toBe("notion_tags_missing");

    expect((await getTagOptions(env, T0 + 1)).size).toBe(OPTIONS.length);
    expect(counter.calls).toBe(2);
  });

  it("throws tags_missing when Tags isn't a multi_select", async () => {
    mockRetrieve({
      body: schema({
        [PROPS.tags]: { id: "t", name: PROPS.tags, type: "select", select: { options: OPTIONS } },
      }),
    });

    const err = await caught(getTagOptions(env, T0));
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ code: "tags_missing" });
  });
});

describe("guardTags", () => {
  let options: TagOptions;
  beforeEach(async () => {
    mockRetrieve({ body: tagsSchema() });
    options = await getTagOptions(env, T0);
  });

  it("drops a fake tag and maps a wrong-case tag to the real id", () => {
    expect(guardTags(["Totally Fake Tag", "dEsIgN"], options)).toEqual([{ id: "opt-design" }]);
    expect(guardTags(["ai", "DEV TOOLS"], options)).toEqual([{ id: "opt-ai" }, { id: "opt-tools" }]);
  });

  it("five tags in, three ids out, order preserved", () => {
    const out = guardTags(["Video", "News", "AI", "Design", "Product"], options);
    expect(out).toEqual([{ id: "opt-video" }, { id: "opt-news" }, { id: "opt-ai" }]);
  });

  it("caps after dropping unknowns and duplicates, so they don't use up a slot", () => {
    const out = guardTags(["Fake", "news", "NEWS", "Nope", "Design", "News", "video", "AI"], options);
    expect(out).toEqual([{ id: "opt-news" }, { id: "opt-design" }, { id: "opt-video" }]);
  });

  it("returns [] for no input or nothing known", () => {
    expect(guardTags([], options)).toEqual([]);
    expect(guardTags(["Fake", "Also Fake"], options)).toEqual([]);
    expect(guardTags(["AI"], new Map())).toEqual([]);
  });

  it("returns plain {id} objects that pass the Notion client's tag guard", () => {
    const out = guardTags(["AI", "news"], options);
    expect(out.every(isTagRef)).toBe(true);
    for (const ref of out) expect(Object.keys(ref)).toEqual(["id"]);
  });

  it("output type can't carry name", () => {
    const out = guardTags(["AI"], options);
    expectTypeOf(out).toEqualTypeOf<{ id: string }[]>();
    expectTypeOf(out[0]!).not.toHaveProperty("name");
    // @ts-expect-error a guarded tag has no name
    const name: unknown = out[0]!.name;
    expect(name).toBeUndefined();
  });
});
