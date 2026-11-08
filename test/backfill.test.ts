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
} from "../scripts/backfill";
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

type Fixture = { id: string; title: string; url: string | null; tags: string[]; archived: boolean; inTrash?: boolean };

const ROWS: Fixture[] = [
  { id: "p-inbox-tagged", title: "Why Startups Fail | The Acme Blog", url: "https://acme.com/why?utm_source=x", tags: ["Startups"], archived: false },
  { id: "p-inbox-empty", title: "(3) building agents - YouTube", url: "https://youtu.be/abc123?si=zz", tags: [], archived: false },
  { id: "p-arch-empty", title: "the art of vibe design", url: "https://example.org/vibe", tags: [], archived: true },
  { id: "p-arch-two", title: "Managing Up", url: "https://example.org/managing-up", tags: ["Career", "Product"], archived: true },
  { id: "p-arch-three", title: "Mental Models 101", url: "https://example.org/mm", tags: ["Mental Models", "Thinking", "Self-Improvement"], archived: true },
  { id: "p-dup-a", title: "Dup A - Medium", url: "https://www.dup.com/post?utm_medium=email", tags: ["Tech"], archived: true },
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
      Name: { id: "title", type: "title", title: [{ type: "text", text: { content: r.title }, plain_text: r.title }] },
      URL: { id: "u", type: "url", url: r.url },
      Tags: { id: "t", type: "multi_select", multi_select: r.tags.map((name) => ({ id: optId(name), name, color: "default" })) },
      Archived: { id: "a", type: "checkbox", checkbox: r.archived },
    },
  };
}

type Captured = { method: string; url: string; body: any };

// Notion: schema, two pages of query results, PATCH /pages. Claude: answers from `claude`.
function mock(rows: Fixture[], claude: (title: string) => { title: string; tags: string[] } | undefined) {
  const notion: Captured[] = [];
  const claudeInputs: string[] = [];
  const split = Math.ceil(rows.length / 2);
  network.use(
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
      notion.push({ method: "PATCH", url: request.url, body: await request.json() });
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
  return { notion, claudeInputs };
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
      newUrl: "https://youtube.com/watch?v=abc123",
    });
    expect(byId.get("p-arch-empty")).toMatchObject({ archived: true, newTitle: "The Art of Vibe Design", newTags: ["Design"] });
    // No change, a failed Claude call (old title kept), a trashed row: not in the plan.
    expect([...byId.keys()].sort()).toEqual(["p-arch-empty", "p-inbox-empty", "p-inbox-tagged"]);

    // Duplicates: listed, kept out of the plan, never sent to Claude.
    const dups = JSON.parse(readFileSync(`${out}/duplicates.json`, "utf8")) as DuplicateGroup[];
    expect(dups).toHaveLength(1);
    expect(dups[0]!.key).toBe("url:https://dup.com/post");
    expect(dups[0]!.rows.map((r) => r.pageId)).toEqual(["p-dup-a", "p-dup-b"]);
    expect(claudeInputs.some((c) => c.includes("Dup A") || c.includes("Dup B"))).toBe(false);
    expect(claudeInputs.some((c) => c.includes("trashed"))).toBe(false);
    // The titled shape: current Name plus the canonical URL.
    expect(claudeInputs).toContain("Title: (3) building agents - YouTube\nURL: https://youtube.com/watch?v=abc123");

    expect(d.lines).toContain("Rows scanned: 8");
    expect(d.lines).toContain("Titles changed: 3");
    expect(d.lines).toContain("Tags added: 2 across 2 rows");
    expect(d.lines).toContain("URLs changed: 2");
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
    const examples = d.lines.filter((l) => l.startsWith("  ["));
    expect(examples).toHaveLength(20);
    expect(examples.some((l) => l.startsWith("  [Inbox] title:"))).toBe(true);
    expect(examples.some((l) => l.startsWith("  [Archived] title:"))).toBe(true);
    expect(examples.some((l) => l.startsWith("  [Inbox] tags: (none) → Product"))).toBe(true);
    expect(examples.some((l) => l.startsWith("  [Archived] tags: (none) → Product"))).toBe(true);
  });
});

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

  it("writes exactly the 2 rows in the plan and logs both old values before each write", async () => {
    const out = tmpDir();
    const planPath = `${out}/plan.jsonl`;
    writeFileSync(planPath, PLAN.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const { notion } = mock([], () => undefined);

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
      { pageId: "p-1", fields: ["title", "tags", "url"], title: "old one | Blog", tags: [], url: "https://a.com/x?utm_source=y" },
      { pageId: "p-2", fields: ["title"], title: "two - YouTube", tags: ["Career"], url: "https://b.com/y" },
    ]);
    expect(d.lines).toContain("Rows written: 2 of 2 in the plan");
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
  it("restores rows from the log", async () => {
    const out = tmpDir();
    const logPath = `${out}/rollback.jsonl`;
    const log: RollbackEntry[] = [
      { pageId: "p-1", fields: ["title", "tags", "url"], title: "old one | Blog", tags: [], url: "https://a.com/x?utm_source=y" },
      { pageId: "p-2", fields: ["title", "tags"], title: "two - YouTube", tags: ["Career", "Mental Models"], url: "https://b.com/y" },
    ];
    writeFileSync(logPath, log.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const { notion } = mock([], () => undefined);
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
    expect(byId.get("p-inbox-tagged")).toEqual({
      Name: { title: [{ text: { content: "Why Startups Fail | The Acme Blog" } }] },
      URL: { url: "https://acme.com/why?utm_source=x" },
    });
    expect(byId.get("p-inbox-empty")).toMatchObject({
      Tags: { multi_select: [] },
      URL: { url: "https://youtu.be/abc123?si=zz" },
    });
    expect(byId.get("p-arch-empty")).toEqual({
      Name: { title: [{ text: { content: "the art of vibe design" } }] },
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
    }));
    writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
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
    expect(starts).toHaveLength(5); // schema, p-3, p-2 (429), p-2, p-1
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
