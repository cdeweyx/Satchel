import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  type Deps,
  type DuplicateGroup,
  type PlanEntry,
  type RollbackEntry,
  apply,
  dryRun,
  parseArgs,
  rollback,
  run,
  stripTracking,
} from "../scripts/backfill";
import { canonicalize } from "../src/canonical";
import { network } from "./network";

// Every Notion and Anthropic request below is answered by MSW (test/network.ts); anything
// unmocked fails. Files go to a fresh directory under workerd's /tmp per test.

const NOTION = "https://api.notion.com/v1";
const DS = `${NOTION}/data_sources/test-data-source-id`;
const MESSAGES = "https://api.anthropic.com/v1/messages";

const OPTIONS = [
  "Startups",
  "Growth",
  "AI",
  "Design",
  "Career",
  "Product",
  "Thinking",
  "Mental Models",
  "Self-Improvement",
  "Tech",
].map((name) => ({ id: `opt-${name.toLowerCase().replace(/[^a-z]/g, "")}`, name, color: "default" }));
const optId = (name: string) => OPTIONS.find((o) => o.name === name)!.id;

type Fixture = {
  id: string;
  title: string;
  url: string | null;
  tags: string[];
  archived: boolean;
  inTrash?: boolean;
  // The Name's rich text as Notion returns it; defaults to one plain text run of `title`.
  titleRich?: unknown[];
};

// One plain text run, as Notion reads it back.
const rich = (s: string) => [
  {
    type: "text",
    text: { content: s, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    plain_text: s,
    href: null,
  },
];

const ROWS: Fixture[] = [
  { id: "p-inbox-tagged", title: "Why Startups Fail | The Acme Blog", url: "https://acme.com/why?utm_source=x", tags: ["Startups"], archived: false },
  { id: "p-inbox-empty", title: "(3) building agents - YouTube", url: "https://youtu.be/abc123?si=zz", tags: [], archived: false },
  { id: "p-arch-empty", title: "the art of vibe design", url: "https://example.org/vibe", tags: [], archived: true },
  { id: "p-arch-two", title: "Managing Up", url: "https://example.org/managing-up", tags: ["Career", "Product"], archived: true },
  { id: "p-arch-three", title: "Mental Models 101", url: "https://example.org/mm", tags: ["Mental Models", "Thinking", "Self-Improvement"], archived: true },
  { id: "p-dup-a", title: "Dup A - Medium", url: "https://dup.com/post?utm_medium=email", tags: ["Tech"], archived: true },
  { id: "p-dup-b", title: "Dup B", url: "https://dup.com/post", tags: [], archived: false },
  { id: "p-fail", title: "keep me", url: "https://example.org/keep", tags: ["AI"], archived: true },
  { id: "p-trashed", title: "trashed", url: "https://example.org/trash", tags: [], archived: true, inTrash: true },
];

// What Claude answers per input title. Missing titles (and "keep me") get a 500.
const CLAUDE: Record<string, { title: string; tags: string[] }> = {
  "Why Startups Fail | The Acme Blog": { title: "Why Startups Fail", tags: ["Startups", "Growth"] },
  "(3) building agents - YouTube": { title: "Building Agents", tags: ["AI"] },
  "the art of vibe design": { title: "The Art of Vibe Design", tags: ["Design"] },
  "Managing Up": { title: "Managing Up", tags: ["Career", "Thinking"] },
  "Mental Models 101": { title: "Mental Models 101", tags: ["AI"] },
};

function page(r: Fixture) {
  return {
    object: "page",
    id: r.id,
    in_trash: r.inTrash ?? false,
    properties: {
      Name: { id: "title", type: "title", title: r.titleRich ?? rich(r.title) },
      URL: { id: "u", type: "url", url: r.url },
      Tags: { id: "t", type: "multi_select", multi_select: r.tags.map((name) => ({ id: optId(name), name, color: "default" })) },
      Archived: { id: "a", type: "checkbox", checkbox: r.archived },
    },
  };
}

type Captured = { method: string; url: string; body: any };

// What a PATCH does to the stored page: Name (rich text, read back with plain_text and
// href), Tags by option id, URL.
function patchFixture(row: Fixture, props: Record<string, any>): void {
  if (props.Name) {
    row.titleRich = (props.Name.title as any[]).map((t) => {
      const content: string = t.text?.content ?? "";
      return { ...t, plain_text: content, href: t.text?.link?.url ?? null };
    });
    row.title = (row.titleRich as { plain_text: string }[]).map((t) => t.plain_text).join("");
  }
  if (props.Tags) row.tags = (props.Tags.multi_select as { id: string }[]).map((t) => OPTIONS.find((o) => o.id === t.id)!.name);
  if (props.URL) row.url = props.URL.url;
}

// Notion: schema, two pages of query results, GET and PATCH /pages. Claude: answers from
// `claude`. GET /pages/:id serves `current` (the query rows plus `pages`); a test edits it
// to play the user changing a row. A PATCH updates it the way Notion would.
function mock(
  rows: Fixture[],
  claude: (title: string) => { title: string; tags: string[] } | undefined,
  pages: Fixture[] = [],
) {
  const notion: Captured[] = [];
  const claudeInputs: string[] = [];
  const current = new Map([...rows, ...pages].map((r) => [r.id, { ...r }]));
  const split = Math.ceil(rows.length / 2);
  network.use(
    http.get(`${NOTION}/pages/:id`, ({ request, params }) => {
      notion.push({ method: "GET", url: request.url, body: null });
      const row = current.get(String(params.id));
      if (!row) return HttpResponse.json({ object: "error", status: 404, code: "object_not_found" }, { status: 404 });
      return HttpResponse.json(page(row));
    }),
    http.get(DS, ({ request }) => {
      notion.push({ method: "GET", url: request.url, body: null });
      return HttpResponse.json({
        object: "data_source",
        id: "test-data-source-id",
        properties: { Tags: { id: "t", name: "Tags", type: "multi_select", multi_select: { options: OPTIONS } } },
      });
    }),
    http.post(`${DS}/query`, async ({ request }) => {
      const body = (await request.json()) as { start_cursor?: string };
      notion.push({ method: "POST", url: request.url, body });
      const second = body.start_cursor === "cursor-2";
      return HttpResponse.json({
        object: "list",
        results: (second ? rows.slice(split) : rows.slice(0, split)).map(page),
        has_more: !second,
        next_cursor: second ? null : "cursor-2",
      });
    }),
    http.patch(`${NOTION}/pages/:id`, async ({ request, params }) => {
      const body = (await request.json()) as { properties: Record<string, any> };
      notion.push({ method: "PATCH", url: request.url, body });
      const row = current.get(String(params.id));
      if (row) patchFixture(row, body.properties);
      return HttpResponse.json({ object: "page", id: params.id, properties: {} });
    }),
    http.post(MESSAGES, async ({ request }) => {
      const body = (await request.json()) as { messages: { content: string }[] };
      const content = body.messages[0]!.content;
      claudeInputs.push(content);
      const title = /^Title: (.*)$/m.exec(content)?.[1] ?? "";
      const out = claude(title);
      if (!out) {
        return HttpResponse.json(
          { type: "error", error: { type: "api_error", message: "boom" } },
          { status: 500, headers: { "request-id": "req_fail" } },
        );
      }
      return HttpResponse.json(
        {
          id: "msg_01Test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: JSON.stringify(out) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
        { headers: { "request-id": "req_ok" } },
      );
    }),
  );
  return { notion, claudeInputs, current };
}

function tmpDir(): string {
  const dir = `/tmp/sat32-${crypto.randomUUID()}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function deps(over: Partial<Deps> = {}): Deps & { lines: string[] } {
  const lines: string[] = [];
  return {
    env: { NOTION_TOKEN: "test-notion-token", NOTION_DATA_SOURCE_ID: "test-data-source-id", ANTHROPIC_API_KEY: "test-anthropic-key" },
    log: (line) => lines.push(line),
    sleep: async () => {},
    now: () => Date.now(),
    minIntervalMs: 0,
    lines,
    ...over,
  };
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

const fixtureClaude = (title: string) => CLAUDE[title];

describe("backfill dry run", () => {
  it("fill-empty: never changes a tagged row's tags, fills empty rows, writes nothing to Notion", async () => {
    const out = tmpDir();
    const { notion, claudeInputs } = mock(ROWS, fixtureClaude);
    const d = deps();
    await dryRun(d, out, "fill-empty");

    // Reads only: the schema and two query pages (the second from the first's cursor).
    expect(notion.map((r) => r.method)).toEqual(["GET", "POST", "POST"]);
    expect(notion[1]!.body.start_cursor).toBeUndefined();
    expect(notion[2]!.body.start_cursor).toBe("cursor-2");
    expect(notion.every((r) => r.body?.page_size === undefined || r.body.page_size === 100)).toBe(true);

    const plan = readJsonl<PlanEntry>(`${out}/plan.jsonl`);
    const byId = new Map(plan.map((e) => [e.pageId, e]));

    // Every tagged fixture row keeps exactly its tags (or isn't in the plan at all).
    for (const row of ROWS.filter((r) => r.tags.length > 0)) {
      const e = byId.get(row.id);
      if (e) expect(e.newTags).toEqual(row.tags);
    }

    expect(byId.get("p-inbox-tagged")).toEqual({
      pageId: "p-inbox-tagged",
      archived: false,
      oldTitle: "Why Startups Fail | The Acme Blog",
      newTitle: "Why Startups Fail",
      oldTags: ["Startups"],
      newTags: ["Startups"],
      oldUrl: "https://acme.com/why?utm_source=x",
      newUrl: "https://acme.com/why",
    });
    expect(byId.get("p-inbox-empty")).toMatchObject({
      newTitle: "Building Agents",
      oldTags: [],
      newTags: ["AI"],
      newUrl: "https://youtu.be/abc123",
    });
    expect(byId.get("p-arch-empty")).toMatchObject({ archived: true, newTitle: "The Art of Vibe Design", newTags: ["Design"] });
    // No change, a failed Claude call (old title kept), a trashed row: not in the plan.
    expect([...byId.keys()].sort()).toEqual(["p-arch-empty", "p-inbox-empty", "p-inbox-tagged"]);

    // Duplicates: listed, kept out of the plan, never sent to Claude.
    const dups = JSON.parse(readFileSync(`${out}/duplicates.json`, "utf8")) as DuplicateGroup[];
    expect(dups).toHaveLength(1);
    expect(dups[0]!.key).toBe("https://dup.com/post");
    expect(dups[0]!.rows.map((r) => r.pageId)).toEqual(["p-dup-a", "p-dup-b"]);
    expect(claudeInputs.some((c) => c.includes("Dup A") || c.includes("Dup B"))).toBe(false);
    expect(claudeInputs.some((c) => c.includes("trashed"))).toBe(false);
    // The titled shape: current Name plus the URL with tracking params stripped.
    expect(claudeInputs).toContain("Title: (3) building agents - YouTube\nURL: https://youtu.be/abc123");

    expect(d.lines).toContain("Rows scanned: 8");
    expect(d.lines).toContain("Titles changed: 3");
    expect(d.lines).toContain("Tags added: 2 across 2 rows");
    expect(d.lines).toContain("URLs changed (tracking params stripped): 2 (page 1, X 0, media 1)");
    expect(d.lines).toContain("Duplicate groups: 1 (2 rows, listed only, not in the plan)");
    expect(d.lines).toContain("Claude failures (old title kept): 1");
    // 5 successful calls at 1000 in / 50 out: 5000 × $0.10/M + 250 × $0.50/M = $0.000625.
    expect(d.lines).toContain("Claude cost: $0.0006 (5000 input, 250 output tokens)");
    expect(d.lines.some((l) => /^Elapsed: \d+\.\d s$/.test(l))).toBe(true);
  });

  it("union: keeps every existing tag on every row and adds Claude's up to 3", async () => {
    const out = tmpDir();
    const { notion } = mock(ROWS, fixtureClaude);
    await dryRun(deps(), out, "union");
    expect(notion.some((r) => r.method === "PATCH")).toBe(false);

    const plan = readJsonl<PlanEntry>(`${out}/plan.jsonl`);
    const byId = new Map(plan.map((e) => [e.pageId, e]));
    for (const row of ROWS) {
      const e = byId.get(row.id);
      if (!e) continue;
      expect(e.oldTags).toEqual(row.tags);
      for (const t of row.tags) expect(e.newTags).toContain(t);
    }
    expect(byId.get("p-inbox-tagged")!.newTags).toEqual(["Startups", "Growth"]);
    expect(byId.get("p-arch-two")!.newTags).toEqual(["Career", "Product", "Thinking"]);
    // Already at 3 tags and the title didn't change: nothing to write.
    expect(byId.has("p-arch-three")).toBe(false);
    expect(byId.has("p-dup-a")).toBe(false);
  });

  it("prints 20 examples mixing title changes and tag fills across Inbox and Archived", async () => {
    const rows: Fixture[] = Array.from({ length: 30 }, (_, i) => ({
      id: `p-${i}`,
      title: `messy title ${i} - Medium`,
      url: `https://example.org/${i}`,
      tags: i % 3 === 0 ? [] : ["AI"],
      archived: i % 2 === 0,
    }));
    mock(rows, (title) => ({ title: title.replace(" - Medium", "").replace("messy", "Clean"), tags: ["Product"] }));
    const d = deps();
    await dryRun(d, tmpDir(), "fill-empty");
    const examples = d.lines.filter((l) => / (title|tags): /.test(l));
    expect(examples).toHaveLength(20);
    expect(examples.some((l) => l.startsWith("  [Inbox] title:"))).toBe(true);
    expect(examples.some((l) => l.startsWith("  [Archived] title:"))).toBe(true);
    expect(examples.some((l) => l.startsWith("  [Inbox] tags: (none) → Product"))).toBe(true);
    expect(examples.some((l) => l.startsWith("  [Archived] tags: (none) → Product"))).toBe(true);
  });
});

describe("backfill URLs, placeholders, typography", () => {
  const URLS: [before: string, after: string][] = [
    ["https://ex.org/a/", "https://ex.org/a/"], // trailing slash only: untouched
    ["https://ex.org/b?utm_source=x#sec", "https://ex.org/b#sec"], // fragment kept
    ["https://x.com/levie/status/203?s=20&t=abc", "https://x.com/levie/status/203"], // author kept
    ["https://WWW.Example.org/Path/?ref=1&utm_campaign=z&id=7", "https://WWW.Example.org/Path/?ref=1&id=7"],
    ["https://www.google.com/url?q=https://a.com/z", "https://www.google.com/url?q=https://a.com/z"], // no unwrap
    ["https://youtu.be/vid1?si=abc&t=30", "https://youtu.be/vid1"], // no youtube.com/watch rewrite
    ["https://foo.substack.com/p/post?r=abc&utm_campaign=post&showWelcomeOnShare=true", "https://foo.substack.com/p/post"],
    ["https://ex.org/c?fbclid=1", "https://ex.org/c"],
    ["https://ex.org/d?gclid=2&q=keep", "https://ex.org/d?q=keep"],
    ["https://m.youtube.com/shorts/xyz?feature=share", "https://m.youtube.com/shorts/xyz"],
  ];

  it("stripTracking removes only canonicalize's tracking params and keeps the rest as stored", () => {
    for (const [before, after] of URLS) expect(stripTracking(before, canonicalize), before).toBe(after);
    expect(stripTracking("not a url?utm_source=x", canonicalize)).toBe("not a url?utm_source=x");
    expect(stripTracking("mailto:a@b.c?utm_source=x", canonicalize)).toBe("mailto:a@b.c?utm_source=x");
  });

  it("dry run writes URL changes only for stripped tracking params and prints 5 URL examples by kind", async () => {
    const out = tmpDir();
    const rows: Fixture[] = URLS.map(([url], i) => ({ id: `p-u${i}`, title: `Row ${i} Title`, url, tags: ["AI"], archived: i % 2 === 0 }));
    mock(rows, (title) => ({ title, tags: ["AI"] }));
    const d = deps();
    await dryRun(d, out, "fill-empty");

    const plan = readJsonl<PlanEntry>(`${out}/plan.jsonl`);
    const changed = URLS.filter(([a, b]) => a !== b);
    expect(plan.map((e) => [e.oldUrl, e.newUrl])).toEqual(changed);
    expect(plan.every((e) => e.newTitle === e.oldTitle && sameArr(e.newTags, e.oldTags))).toBe(true);
    // 8 changes: X 1 (x.com), media 2 (youtu.be, m.youtube.com), page 5.
    expect(d.lines).toContain("URLs changed (tracking params stripped): 8 (page 5, X 1, media 2)");
    const urlExamples = d.lines.filter((l) => / url: /.test(l));
    expect(urlExamples).toHaveLength(5);
    expect(urlExamples).toContain("  [Inbox] url: https://ex.org/b?utm_source=x#sec → https://ex.org/b#sec");
    expect(urlExamples.some((l) => l.endsWith("→ https://x.com/levie/status/203"))).toBe(true);
    expect(urlExamples.some((l) => l.endsWith("→ https://youtu.be/vid1"))).toBe(true);
  });

  it("never sends placeholder titles to Claude and keeps them", async () => {
    const out = tmpDir();
    const rows: Fixture[] = [
      { id: "p-at", title: "@levie on X", url: "https://x.com/levie/status/203", tags: [], archived: true },
      { id: "p-xpost", title: "X post 204", url: "https://x.com/i/status/204", tags: [], archived: true },
      { id: "p-slug", title: "Some slug · example.org", url: "https://example.org/some-slug", tags: [], archived: false },
      { id: "p-urltitle", title: "https://example.org/page", url: "https://example.org/page?utm_source=x", tags: [], archived: true },
      { id: "p-empty", title: "", url: "https://example.org/blank", tags: [], archived: true },
      { id: "p-real", title: "a real title", url: "https://example.org/real", tags: [], archived: true },
    ];
    // Claude would invent a title for anything it's sent.
    const { claudeInputs } = mock(rows, (title) => ({ title: `Saved Post About ${title}`, tags: ["Tech"] }));
    const d = deps();
    await dryRun(d, out, "fill-empty");

    expect(claudeInputs).toEqual(["Title: a real title\nURL: https://example.org/real"]);
    const plan = readJsonl<PlanEntry>(`${out}/plan.jsonl`);
    expect(plan.map((e) => e.pageId)).toEqual(["p-urltitle", "p-real"]);
    // The URL-as-title row only gets its URL stripped; its title stays.
    expect(plan[0]).toMatchObject({ oldTitle: "https://example.org/page", newTitle: "https://example.org/page", newTags: [] });
    expect(d.lines).toContain("Placeholder titles kept (not sent to Claude): 5");
  });

  it("treats quote, dash and whitespace-only title differences as no change", async () => {
    const out = tmpDir();
    const rows: Fixture[] = [
      { id: "p-quotes", title: "Don’t Panic — It’s “Fine”", url: "https://e.org/1", tags: ["AI"], archived: true },
      { id: "p-space", title: "  Spaced   Out ", url: "https://e.org/2", tags: ["AI"], archived: false },
      { id: "p-real", title: "don’t stop", url: "https://e.org/3", tags: ["AI"], archived: true },
    ];
    const answers: Record<string, string> = {
      "Don’t Panic — It’s “Fine”": 'Don\'t Panic - It\'s "Fine"',
      "  Spaced   Out ": "Spaced Out",
      "don’t stop": "Don't Stop",
    };
    mock(rows, (title) => ({ title: answers[title] ?? title, tags: ["AI"] }));
    await dryRun(deps(), out, "fill-empty");
    const plan = readJsonl<PlanEntry>(`${out}/plan.jsonl`);
    // Only the real (case) change is planned.
    expect(plan.map((e) => [e.pageId, e.newTitle])).toEqual([["p-real", "Don't Stop"]]);
  });

  it("finds duplicates on the stripped URL and still only lists them", async () => {
    const out = tmpDir();
    const rows: Fixture[] = [
      { id: "p-a1", title: "A One", url: "https://same.com/a?utm_source=x", tags: [], archived: true },
      { id: "p-a2", title: "A Two", url: "https://same.com/a", tags: [], archived: false },
      // Equal only after canonicalize's rewrites (www, trailing slash, X author): not duplicates.
      { id: "p-b1", title: "B One", url: "https://www.other.com/b", tags: [], archived: true },
      { id: "p-b2", title: "B Two", url: "https://other.com/b/", tags: [], archived: true },
      { id: "p-x1", title: "X One", url: "https://x.com/levie/status/1?s=20", tags: [], archived: true },
      { id: "p-x2", title: "X Two", url: "https://twitter.com/levie/status/1", tags: [], archived: true },
    ];
    const { notion, claudeInputs } = mock(rows, (title) => ({ title, tags: ["AI"] }));
    await run(["--dry-run", "--out", out], deps());
    const dups = JSON.parse(readFileSync(`${out}/duplicates.json`, "utf8")) as DuplicateGroup[];
    expect(dups).toEqual([
      {
        key: "https://same.com/a",
        rows: [
          { pageId: "p-a1", archived: true, title: "A One", url: "https://same.com/a?utm_source=x", newUrl: "https://same.com/a" },
          { pageId: "p-a2", archived: false, title: "A Two", url: "https://same.com/a", newUrl: "https://same.com/a" },
        ],
      },
    ]);
    const plan = readJsonl<PlanEntry>(`${out}/plan.jsonl`);
    expect(plan.map((e) => e.pageId)).not.toContain("p-a1");
    expect(plan.map((e) => e.pageId)).not.toContain("p-a2");
    expect(claudeInputs.some((c) => c.includes("A One") || c.includes("A Two"))).toBe(false);

    await run(["--apply", `${out}/plan.jsonl`, "--out", out], deps());
    const patched = notion.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop());
    expect(patched).not.toContain("p-a1");
    expect(patched).not.toContain("p-a2");
    expect(patched.length).toBe(plan.length);
  });
});

function sameArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

describe("backfill apply", () => {
  const PLAN: PlanEntry[] = [
    {
      pageId: "p-1",
      archived: true,
      oldTitle: "old one | Blog",
      newTitle: "Old One",
      oldTags: [],
      newTags: ["AI", "Product"],
      oldUrl: "https://a.com/x?utm_source=y",
      newUrl: "https://a.com/x",
    },
    {
      pageId: "p-2",
      archived: false,
      oldTitle: "two - YouTube",
      newTitle: "Two",
      oldTags: ["Career"],
      newTags: ["Career"],
      oldUrl: "https://b.com/y",
      newUrl: "https://b.com/y",
    },
  ];
  // The two pages as Notion holds them at apply time, unedited since the dry run.
  const PAGES: Fixture[] = PLAN.map((e) => ({
    id: e.pageId,
    title: e.oldTitle,
    url: e.oldUrl,
    tags: e.oldTags,
    archived: e.archived,
  }));
  const writePlan = (out: string) => {
    writeFileSync(`${out}/plan.jsonl`, PLAN.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return `${out}/plan.jsonl`;
  };

  it("writes exactly the 2 rows in the plan and logs both old values before each write", async () => {
    const out = tmpDir();
    const planPath = writePlan(out);
    const { notion } = mock([], () => undefined, PAGES);

    // At each PATCH, the row's old values must already be in the log.
    const loggedAtPatch: string[][] = [];
    network.use(
      http.patch(`${NOTION}/pages/:id`, async ({ request, params }) => {
        notion.push({ method: "PATCH", url: request.url, body: await request.json() });
        const path = `${out}/rollback.jsonl`;
        loggedAtPatch.push(existsSync(path) ? readJsonl<RollbackEntry>(path).map((e) => e.pageId) : []);
        return HttpResponse.json({ object: "page", id: params.id, properties: {} });
      }),
    );

    const d = deps();
    await apply(d, planPath, out);

    const patches = notion.filter((r) => r.method === "PATCH");
    expect(patches.map((p) => p.url)).toEqual([`${NOTION}/pages/p-1`, `${NOTION}/pages/p-2`]);
    expect(patches[0]!.body).toEqual({
      properties: {
        Name: { title: [{ text: { content: "Old One" } }] },
        Tags: { multi_select: [{ id: optId("AI") }, { id: optId("Product") }] },
        URL: { url: "https://a.com/x" },
      },
    });
    // Only what changed: the title.
    expect(patches[1]!.body).toEqual({ properties: { Name: { title: [{ text: { content: "Two" } }] } } });
    expect(loggedAtPatch).toEqual([["p-1"], ["p-1", "p-2"]]);

    expect(readJsonl<RollbackEntry>(`${out}/rollback.jsonl`)).toEqual([
      {
        pageId: "p-1",
        fields: ["title", "tags", "url"],
        title: "old one | Blog",
        titleRich: rich("old one | Blog"),
        tags: [],
        url: "https://a.com/x?utm_source=y",
        written: { title: "Old One", tags: ["AI", "Product"], url: "https://a.com/x" },
      },
      {
        pageId: "p-2",
        fields: ["title"],
        title: "two - YouTube",
        titleRich: rich("two - YouTube"),
        tags: ["Career"],
        url: "https://b.com/y",
        written: { title: "Two", tags: ["Career"], url: "https://b.com/y" },
      },
    ]);
    expect(d.lines).toContain("Rows written: 2 of 2 in the plan");
    expect(d.lines).toContain("Already applied: 0");
    expect(d.lines).toContain("Skipped (changed since dry run): 0");
    // Each row is re-read right before its write.
    expect(notion.filter((r) => r.url.includes("/pages/")).map((r) => `${r.method} ${r.url.split("/").pop()}`)).toEqual([
      "GET p-1",
      "PATCH p-1",
      "GET p-2",
      "PATCH p-2",
    ]);
  });

  it.each([
    ["Name", { title: "My Own Title" }],
    ["Tags", { tags: ["Growth"] }],
    ["URL", { url: "https://a.com/elsewhere" }],
    ["trash", { inTrash: true }],
  ] as const)("skips a row whose %s changed after the dry run and doesn't write it", async (_what, edit) => {
    const out = tmpDir();
    const planPath = writePlan(out);
    const { notion, current } = mock([], () => undefined, PAGES);
    Object.assign(current.get("p-1")!, edit);

    const d = deps();
    await apply(d, planPath, out);

    const patches = notion.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop());
    expect(patches).toEqual(["p-2"]);
    expect(d.lines).toContain("  p-1 skipped: changed since dry run");
    expect(d.lines).toContain("Rows written: 1 of 2 in the plan");
    expect(d.lines).toContain("Skipped (changed since dry run): 1");
    expect(readJsonl<RollbackEntry>(`${out}/rollback.jsonl`).map((e) => e.pageId)).toEqual(["p-2"]);
  });

  it("writes the rollback entry from the fresh read, not the plan", async () => {
    const out = tmpDir();
    // Plan says p-3 had Career, Product; Notion now holds the same tags in the other order
    // (not an edit, so the row is written) and the log records Notion's copy.
    const entry: PlanEntry = {
      pageId: "p-3",
      archived: true,
      oldTitle: "three | Blog",
      newTitle: "Three",
      oldTags: ["Career", "Product"],
      newTags: ["Career", "Product"],
      oldUrl: "https://c.com/z",
      newUrl: "https://c.com/z",
    };
    writeFileSync(`${out}/plan.jsonl`, JSON.stringify(entry) + "\n");
    const fresh: Fixture = { id: "p-3", title: "three | Blog", url: "https://c.com/z", tags: ["Product", "Career"], archived: true };
    const { notion } = mock([], () => undefined, [fresh]);

    await apply(deps(), `${out}/plan.jsonl`, out);

    expect(notion.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(readJsonl<RollbackEntry>(`${out}/rollback.jsonl`)).toEqual([
      {
        pageId: "p-3",
        fields: ["title"],
        title: "three | Blog",
        titleRich: rich("three | Blog"),
        tags: ["Product", "Career"],
        url: "https://c.com/z",
        written: { title: "Three", tags: ["Career", "Product"], url: "https://c.com/z" },
      },
    ]);
  });

  it("reports a row that already holds the plan's new values as already applied, not changed", async () => {
    const out = tmpDir();
    const planPath = writePlan(out);
    const { notion, current } = mock([], () => undefined, PAGES);
    // A resumed run: p-1 was written before the last run stopped.
    Object.assign(current.get("p-1")!, { title: "Old One", tags: ["Product", "AI"], url: "https://a.com/x" });

    const d = deps();
    await apply(d, planPath, out);

    expect(notion.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop())).toEqual(["p-2"]);
    expect(d.lines).toContain("  p-1 already applied");
    expect(d.lines).not.toContain("  p-1 skipped: changed since dry run");
    expect(d.lines).toContain("Already applied: 1");
    expect(d.lines).toContain("Skipped (changed since dry run): 0");
    expect(readJsonl<RollbackEntry>(`${out}/rollback.jsonl`).map((e) => e.pageId)).toEqual(["p-2"]);
  });

  it("refuses a plan whose tags don't map to options before writing anything", async () => {
    const out = tmpDir();
    const planPath = `${out}/plan.jsonl`;
    const bad = { ...PLAN[1]!, pageId: "p-bad", newTags: ["Career", "Not A Tag"] };
    writeFileSync(planPath, [PLAN[0], bad].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const { notion } = mock([], () => undefined);
    await expect(apply(deps(), planPath, out)).rejects.toThrow(/p-bad/);
    expect(notion.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(existsSync(`${out}/rollback.jsonl`)).toBe(false);
  });

  it("dry run then apply never writes a duplicate row", async () => {
    const out = tmpDir();
    const { notion } = mock(ROWS, fixtureClaude);
    await run(["--dry-run", "--out", out], deps());
    await run(["--apply", `${out}/plan.jsonl`, "--out", out], deps());
    const patched = notion.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop());
    expect(patched.sort()).toEqual(["p-arch-empty", "p-inbox-empty", "p-inbox-tagged"]);
    expect(patched).not.toContain("p-dup-a");
    expect(patched).not.toContain("p-dup-b");
  });
});

describe("backfill rollback", () => {
  const LOG: RollbackEntry[] = [
    {
      pageId: "p-1",
      fields: ["title", "tags", "url"],
      title: "old one | Blog",
      tags: [],
      url: "https://a.com/x?utm_source=y",
      written: { title: "Old One", tags: ["AI"], url: "https://a.com/x" },
    },
    {
      pageId: "p-2",
      fields: ["title", "tags"],
      title: "two - YouTube",
      tags: ["Career", "Mental Models"],
      url: "https://b.com/y",
      written: { title: "Two", tags: ["Career", "Mental Models", "Thinking"], url: "https://b.com/y" },
    },
  ];
  // The two pages as apply left them.
  const AFTER_APPLY: Fixture[] = LOG.map((e) => ({
    id: e.pageId,
    title: e.written!.title,
    tags: e.written!.tags,
    url: e.written!.url,
    archived: true,
  }));
  const writeLog = (out: string, entries: RollbackEntry[] = LOG) => {
    writeFileSync(`${out}/rollback.jsonl`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return `${out}/rollback.jsonl`;
  };

  it("restores rows from the log", async () => {
    const out = tmpDir();
    const logPath = writeLog(out);
    const { notion } = mock([], () => undefined, AFTER_APPLY);
    const d = deps();
    await run(["--rollback", logPath], d);

    const patches = notion.filter((r) => r.method === "PATCH");
    expect(patches.map((p) => p.url)).toEqual([`${NOTION}/pages/p-2`, `${NOTION}/pages/p-1`]);
    expect(patches[0]!.body).toEqual({
      properties: {
        Name: { title: [{ text: { content: "two - YouTube" } }] },
        Tags: { multi_select: [{ id: optId("Career") }, { id: optId("Mental Models") }] },
      },
    });
    expect(patches[1]!.body).toEqual({
      properties: {
        Name: { title: [{ text: { content: "old one | Blog" } }] },
        Tags: { multi_select: [] },
        URL: { url: "https://a.com/x?utm_source=y" },
      },
    });
    expect(d.lines).toContain("Rows restored: 2");
    expect(d.lines).toContain("Skipped (changed since apply): 0");
    // Each row re-read right before its write.
    expect(notion.filter((r) => r.url.includes("/pages/")).map((r) => `${r.method} ${r.url.split("/").pop()}`)).toEqual([
      "GET p-2",
      "PATCH p-2",
      "GET p-1",
      "PATCH p-1",
    ]);
  });

  it.each([
    ["Name", { title: "Retitled By Hand" }],
    ["Tags", { tags: ["Career"] }],
    ["URL", { url: "https://a.com/moved" }],
    ["trash", { inTrash: true }],
  ] as const)("skips a row whose %s was edited after the apply, so the edit survives", async (_what, edit) => {
    const out = tmpDir();
    const logPath = writeLog(out);
    const { notion, current } = mock([], () => undefined, AFTER_APPLY);
    Object.assign(current.get("p-1")!, edit);
    const d = deps();
    await rollback(d, logPath);

    expect(notion.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop())).toEqual(["p-2"]);
    expect(d.lines).toContain("  warning: p-1 skipped: changed since apply");
    expect(d.lines).toContain("Rows restored: 1");
    expect(d.lines).toContain("Skipped (changed since apply): 1");
    // The user's edit is still there.
    expect(current.get("p-1")).toMatchObject(edit);
  });

  it("an edit to a field apply didn't write doesn't block the rollback", async () => {
    const out = tmpDir();
    const logPath = writeLog(out);
    const { notion, current } = mock([], () => undefined, AFTER_APPLY);
    // p-2's log covers title and tags only; the user changing its URL is fine.
    current.get("p-2")!.url = "https://b.com/new";
    await rollback(deps(), logPath);
    expect(notion.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop())).toEqual(["p-2", "p-1"]);
    expect(current.get("p-2")).toMatchObject({ title: "two - YouTube", url: "https://b.com/new" });
  });

  it("writes the Name's logged rich text back exactly, links and formatting included", async () => {
    const out = tmpDir();
    const linked = [
      {
        type: "text",
        text: { content: "Read ", link: null },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
        plain_text: "Read ",
        href: null,
      },
      {
        type: "text",
        text: { content: "this essay", link: { url: "https://example.org/essay" } },
        annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "red" },
        plain_text: "this essay",
        href: "https://example.org/essay",
      },
    ];
    const before: Fixture = { id: "p-rich", title: "Read this essay", titleRich: linked, url: "https://e.org/x", tags: ["AI"], archived: true };
    const entry: PlanEntry = {
      pageId: "p-rich",
      archived: true,
      oldTitle: "Read this essay",
      newTitle: "Read This Essay",
      oldTags: ["AI"],
      newTags: ["AI"],
      oldUrl: "https://e.org/x",
      newUrl: "https://e.org/x",
    };
    writeFileSync(`${out}/plan.jsonl`, JSON.stringify(entry) + "\n");
    const { notion, current } = mock([], () => undefined, [before]);

    await apply(deps(), `${out}/plan.jsonl`, out);
    expect(readJsonl<RollbackEntry>(`${out}/rollback.jsonl`)[0]!.titleRich).toEqual(linked);
    await rollback(deps(), `${out}/rollback.jsonl`);

    const patches = notion.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    // Written as Notion takes it: type, payload, annotations (no plain_text or href).
    expect(patches[1]!.body).toEqual({
      properties: {
        Name: {
          title: linked.map(({ type, text, annotations }) => ({ type, text, annotations })),
        },
      },
    });
    expect(current.get("p-rich")!.titleRich).toEqual(linked);
  });

  it("apply then rollback puts every written row back", async () => {
    const out = tmpDir();
    const { notion } = mock(ROWS, fixtureClaude);
    await run(["--dry-run", "--out", out], deps());
    await run(["--apply", `${out}/plan.jsonl`, "--out", out], deps());
    const before = notion.length;
    await run(["--rollback", `${out}/rollback.jsonl`], deps());
    const restored = notion.slice(before).filter((r) => r.method === "PATCH");
    const byId = new Map(restored.map((r) => [r.url.split("/").pop(), r.body.properties]));
    const writable = (s: string) => rich(s).map(({ type, text, annotations }) => ({ type, text, annotations }));
    expect(byId.get("p-inbox-tagged")).toEqual({
      Name: { title: writable("Why Startups Fail | The Acme Blog") },
      URL: { url: "https://acme.com/why?utm_source=x" },
    });
    expect(byId.get("p-inbox-empty")).toMatchObject({
      Tags: { multi_select: [] },
      URL: { url: "https://youtu.be/abc123?si=zz" },
    });
    expect(byId.get("p-arch-empty")).toEqual({
      Name: { title: writable("the art of vibe design") },
      Tags: { multi_select: [] },
    });
  });
});

describe("backfill Notion pacing", () => {
  it("keeps 334 ms between requests and waits out a 429, retrying nothing else", async () => {
    const out = tmpDir();
    const logPath = `${out}/rollback.jsonl`;
    const entries: RollbackEntry[] = ["p-1", "p-2", "p-3"].map((pageId) => ({
      pageId,
      fields: ["title"],
      title: `t ${pageId}`,
      tags: [],
      url: null,
      written: { title: `new ${pageId}`, tags: [], url: null },
    }));
    writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const current = new Map(entries.map((e) => [e.pageId, page({ id: e.pageId, title: `new ${e.pageId}`, url: null, tags: [], archived: true })]));
    mock([], () => undefined);

    let clock = 0;
    const slept: number[] = [];
    const starts: number[] = [];
    let limited = false;
    network.use(
      http.get(DS, () => {
        starts.push(clock);
        return HttpResponse.json({
          object: "data_source",
          properties: { Tags: { type: "multi_select", multi_select: { options: OPTIONS } } },
        });
      }),
      http.get(`${NOTION}/pages/:id`, ({ params }) => {
        starts.push(clock);
        return HttpResponse.json(current.get(String(params.id)));
      }),
      http.patch(`${NOTION}/pages/:id`, ({ params }) => {
        starts.push(clock);
        if (params.id === "p-2" && !limited) {
          limited = true;
          return HttpResponse.json(
            { object: "error", status: 429, code: "rate_limited" },
            { status: 429, headers: { "Retry-After": "2" } },
          );
        }
        if (params.id === "p-1") {
          return HttpResponse.json({ object: "error", status: 409, code: "conflict_error" }, { status: 409 });
        }
        return HttpResponse.json({ object: "page", id: params.id, properties: {} });
      }),
    );
    const d = deps({
      minIntervalMs: 334,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    // Newest first: p-3, p-2 (429, waited out), p-1 (409: thrown, never retried).
    await expect(rollback(d, logPath)).rejects.toThrow("409 conflict_error");
    // schema, GET+PATCH p-3, GET p-2, PATCH p-2 (429), PATCH p-2, GET+PATCH p-1
    expect(starts).toHaveLength(8);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(334);
    expect(slept).toContain(2000);
  });
});

describe("backfill args", () => {
  it("parses the three commands and defaults tags to fill-empty", () => {
    expect(parseArgs(["--dry-run", "--out", "/o"])).toEqual({ cmd: "dry-run", out: "/o", tags: "fill-empty" });
    expect(parseArgs(["--dry-run", "--out=/o", "--tags=union"])).toEqual({ cmd: "dry-run", out: "/o", tags: "union" });
    expect(parseArgs(["--apply", "/o/plan.jsonl", "--out", "/o"])).toEqual({ cmd: "apply", plan: "/o/plan.jsonl", out: "/o" });
    expect(parseArgs(["--rollback", "/o/rollback.jsonl"])).toEqual({ cmd: "rollback", log: "/o/rollback.jsonl" });
    expect(() => parseArgs(["--dry-run"])).toThrow("--out");
    expect(() => parseArgs(["--dry-run", "--out", "/o", "--tags=all"])).toThrow("fill-empty or union");
    expect(() => parseArgs([])).toThrow("--dry-run");
  });
});
