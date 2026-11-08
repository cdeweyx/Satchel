// Backlog backfill (SAT-32). Runs the live rules over every non-trashed row in the
// Articles data source: Claude's title (Title Case, site-suffix drop, X titles), tags for
// rows that have none, and the canonical URL. Dev tool, not part of the Worker.
//
//   set -a; . <env file with NOTION_TOKEN, NOTION_DATA_SOURCE_ID, ANTHROPIC_API_KEY>; set +a
//   npm run backfill -- --dry-run --out <dir> [--tags=fill-empty|union]
//   npm run backfill -- --apply <dir>/plan.jsonl --out <dir>
//   npm run backfill -- --rollback <dir>/rollback.jsonl
//
// --dry-run writes nothing to Notion: it writes <out>/plan.jsonl (only rows that change) and
// <out>/duplicates.json, and prints examples, counts, Claude cost and elapsed time.
// --apply writes only the rows in the plan, and only the properties that change in each. It
// re-reads each page first: a row whose Name, Tags or URL changed since the dry run is
// skipped; otherwise its fresh values go to <out>/rollback.jsonl before the write.
// --rollback writes the logged old values back, newest log line first.
//
// One rulebook: the Claude call, the tag guard and canonicalization come from src/ unchanged.
// At most 3 Notion requests a second. No retries, except waiting out a 429.
// The data files are personal reading history: keep them under a gitignored .context/.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ClaudeInput } from "../src/claude";
import type { TagOptions } from "../src/tags";
import type { Properties } from "../src/notion";

export type TagsMode = "fill-empty" | "union";

export type BackfillEnv = {
  NOTION_TOKEN?: string;
  NOTION_DATA_SOURCE_ID?: string;
  ANTHROPIC_API_KEY?: string;
};

export type Deps = {
  env: BackfillEnv;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  // Gap between Notion request starts. 334 ms keeps it at 3 a second.
  minIntervalMs: number;
};

export type PlanEntry = {
  pageId: string;
  archived: boolean;
  oldTitle: string;
  newTitle: string;
  oldTags: string[];
  newTags: string[];
  oldUrl: string | null;
  newUrl: string | null;
};

export type RollbackEntry = {
  pageId: string;
  fields: ("title" | "tags" | "url")[];
  title: string;
  tags: string[];
  url: string | null;
};

export type DuplicateGroup = {
  key: string;
  rows: { pageId: string; archived: boolean; title: string; url: string | null; canonicalUrl: string | null }[];
};

type Row = {
  pageId: string;
  archived: boolean;
  title: string;
  url: string | null;
  tags: string[];
};

// Haiku 5.5, prompts under 100k tokens: $0.10 / MTok in, $0.50 / MTok out
// (docs/research/02-claude.md, pricing page 2026-11-07).
const USD_PER_INPUT_TOKEN = 0.1 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 0.5 / 1_000_000;
const CLAUDE_CONCURRENCY = 3;
const EXAMPLES = 20;
const MAX_TAGS = 3;
const MAX_429_WAITS = 10;
const NOTION_API = "https://api.notion.com/v1";

// src/ is loaded lazily so the CLI can register its .ts resolve hook first (see the bottom).
async function lib() {
  const [claude, tags, canonical, notion, config] = await Promise.all([
    import("../src/claude"),
    import("../src/tags"),
    import("../src/canonical"),
    import("../src/notion"),
    import("../src/config"),
  ]);
  return { claude, tags, canonical, notion, config };
}

// --- Notion: throttled, waits out a 429, never retries anything else ---

function notionClient(deps: Deps, version: string) {
  const { NOTION_TOKEN: token, NOTION_DATA_SOURCE_ID: dataSourceId } = deps.env;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  if (!dataSourceId) throw new Error("NOTION_DATA_SOURCE_ID is not set");
  let lastStart = Number.NEGATIVE_INFINITY;

  async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    for (let waits = 0; ; waits++) {
      const gap = lastStart + deps.minIntervalMs - deps.now();
      if (gap > 0) await deps.sleep(gap);
      lastStart = deps.now();
      const res = await fetch(`${NOTION_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": version,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status === 429 && waits < MAX_429_WAITS) {
        const seconds = Number(res.headers.get("retry-after"));
        await deps.sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000);
        continue;
      }
      if (!res.ok) {
        let code = `http_${res.status}`;
        try {
          const parsed = JSON.parse(text) as { code?: unknown };
          if (typeof parsed.code === "string") code = parsed.code;
        } catch {
          // keep http_<status>
        }
        throw new Error(`Notion ${method} ${path} failed: ${res.status} ${code}`);
      }
      return JSON.parse(text) as T;
    }
  }

  return {
    retrieveDataSource: () =>
      call<{ properties?: Record<string, { type?: string; multi_select?: { options?: unknown[] } }> }>(
        "GET",
        `/data_sources/${dataSourceId}`,
      ),
    queryPage: (cursor: string | undefined) =>
      call<{ results?: unknown[]; has_more?: boolean; next_cursor?: string | null }>(
        "POST",
        `/data_sources/${dataSourceId}/query`,
        {
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      ),
    retrievePage: (id: string) => call<unknown>("GET", `/pages/${encodeURIComponent(id)}`),
    patchPage: (id: string, properties: Properties) =>
      call<unknown>("PATCH", `/pages/${encodeURIComponent(id)}`, { properties }),
  };
}

type Lib = Awaited<ReturnType<typeof lib>>;
type Notion = ReturnType<typeof notionClient>;

// Same shape as getTagOptions in src/tags.ts (lowercase name → option), read through the
// throttled client. Also returns the names in schema order for Claude's allowed list.
async function readTagOptions(n: Notion, l: Lib): Promise<{ options: TagOptions; names: string[] }> {
  const schema = await n.retrieveDataSource();
  const prop = schema.properties?.[l.config.PROPS.tags];
  if (!prop || prop.type !== "multi_select" || !Array.isArray(prop.multi_select?.options)) {
    throw new Error("The data source has no multi_select Tags property");
  }
  const options: TagOptions = new Map();
  for (const raw of prop.multi_select.options) {
    const opt = raw as { id?: unknown; name?: unknown };
    if (typeof opt.id !== "string" || typeof opt.name !== "string") continue;
    const key = opt.name.toLowerCase();
    if (!options.has(key)) options.set(key, { id: opt.id, name: opt.name });
  }
  return { options, names: [...options.values()].map((o) => o.name) };
}

// A page's Name, URL, Tags and Archived as the script reads them. Null for a trashed page.
function rowFromPage(l: Lib, raw: unknown): Row | null {
  const { PROPS } = l.config;
  const p = raw as { id?: string; in_trash?: boolean; archived?: boolean; properties?: Record<string, any> };
  if (typeof p.id !== "string" || p.in_trash === true || p.archived === true) return null;
  const props = p.properties ?? {};
  const title = Array.isArray(props[PROPS.name]?.title)
    ? (props[PROPS.name].title as { plain_text?: string; text?: { content?: string } }[])
        .map((t) => t.plain_text ?? t.text?.content ?? "")
        .join("")
    : "";
  const url = typeof props[PROPS.url]?.url === "string" ? (props[PROPS.url].url as string) : null;
  const tags = Array.isArray(props[PROPS.tags]?.multi_select)
    ? (props[PROPS.tags].multi_select as { name?: string }[])
        .map((t) => t.name)
        .filter((t): t is string => typeof t === "string")
    : [];
  return { pageId: p.id, archived: props[PROPS.archived]?.checkbox === true, title, url, tags };
}

async function readRows(n: Notion, l: Lib): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await n.queryPage(cursor);
    for (const raw of page.results ?? []) {
      const row = rowFromPage(l, raw);
      if (row) rows.push(row);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// --- Dry run ---

function canonicalOf(l: Lib, url: string | null): { stored: string | null; key: string | null } {
  if (url === null || url.trim() === "") return { stored: url, key: null };
  try {
    const c = l.canonical.canonicalize(url);
    return { stored: c.stored, key: c.dedupe.type === "x" ? `x:${c.dedupe.id}` : `url:${c.dedupe.bare}` };
  } catch {
    // Unparsable or non-http(s): leave it as it is, dedupe on the raw string.
    return { stored: url, key: `raw:${url.trim()}` };
  }
}

// Counts Claude's tokens from the responses the SDK reads, without touching src/claude.ts.
// The SDK picks up the global fetch when each client is built, so this sees every call.
async function withUsageMeter<T>(run: (usage: { input: number; output: number }) => Promise<T>): Promise<T> {
  const usage = { input: 0, output: 0 };
  const original = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const metered = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (res.ok && url.includes("/v1/messages")) {
      try {
        const body = (await res.clone().json()) as { usage?: Record<string, unknown> };
        const u = body.usage ?? {};
        for (const k of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
          if (typeof u[k] === "number") usage.input += u[k];
        }
        if (typeof u.output_tokens === "number") usage.output += u.output_tokens;
      } catch {
        // Not JSON: nothing to count.
      }
    }
    return res;
  };
  // defineProperty, not assignment: fetch can be a read-only global (workerd under MSW).
  Object.defineProperty(globalThis, "fetch", {
    value: metered,
    writable: true,
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
  });
  try {
    return await run(usage);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
  }
}

export async function dryRun(deps: Deps, out: string, mode: TagsMode): Promise<void> {
  const started = deps.now();
  const l = await lib();
  const { ANTHROPIC_API_KEY: apiKey } = deps.env;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const n = notionClient(deps, l.config.NOTION_VERSION);
  const { options, names: allowedTags } = await readTagOptions(n, l);
  const rows = await readRows(n, l);

  // Duplicates: rows whose canonical URL or dedupe key matches another row's. Listed only.
  const canon = rows.map((r) => canonicalOf(l, r.url));
  const byKey = new Map<string, number[]>();
  canon.forEach((c, i) => {
    if (c.key === null) return;
    byKey.set(c.key, [...(byKey.get(c.key) ?? []), i]);
  });
  const groups: DuplicateGroup[] = [];
  const isDuplicate = new Set<number>();
  for (const [key, idx] of byKey) {
    if (idx.length < 2) continue;
    idx.forEach((i) => isDuplicate.add(i));
    groups.push({
      key,
      rows: idx.map((i) => ({
        pageId: rows[i]!.pageId,
        archived: rows[i]!.archived,
        title: rows[i]!.title,
        url: rows[i]!.url,
        canonicalUrl: canon[i]!.stored,
      })),
    });
  }

  // Claude for every non-duplicate row (duplicates are never written, so never paid for).
  const env = { ANTHROPIC_API_KEY: apiKey } as unknown as Env;
  const results: ({ title: string; tags: string[] } | null)[] = new Array(rows.length).fill(null);
  let failed = 0;
  const usage = await withUsageMeter(async (usage) => {
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        if (isDuplicate.has(i)) continue;
        const row = rows[i]!;
        const url = canon[i]!.stored ?? "";
        const input: ClaudeInput =
          row.title.trim() === "" ? { shape: "untitled", url } : { shape: "titled", title: row.title, url };
        const res = await l.claude.cleanTitleAndTags(env, input, allowedTags, new AbortController().signal);
        if (res === null) failed++;
        results[i] = res;
      }
    };
    await Promise.all(Array.from({ length: CLAUDE_CONCURRENCY }, worker));
    return usage;
  });

  const idToName = new Map([...options.values()].map((o) => [o.id, o.name]));
  const plan: PlanEntry[] = [];
  let tagsAddedRows = 0;
  let tagsAdded = 0;
  rows.forEach((row, i) => {
    if (isDuplicate.has(i)) return;
    const res = results[i] ?? null;
    const newTitle = res && res.title.trim() !== "" ? res.title.trim() : row.title;
    const claudeTags = res ? l.tags.guardTags(res.tags, options).map((t) => idToName.get(t.id)!) : [];
    let newTags = row.tags;
    if (mode === "fill-empty") {
      if (row.tags.length === 0) newTags = claudeTags;
    } else {
      // Union: keep every tag, add Claude's missing ones while the row has fewer than 3.
      const have = new Set(row.tags.map((t) => t.toLowerCase()));
      const added = claudeTags.filter((t) => !have.has(t.toLowerCase()));
      newTags = [...row.tags, ...added.slice(0, Math.max(0, MAX_TAGS - row.tags.length))];
    }
    const newUrl = canon[i]!.stored;
    const added = newTags.length - row.tags.length;
    if (newTitle === row.title && added === 0 && newUrl === row.url) return;
    if (added > 0) {
      tagsAddedRows++;
      tagsAdded += added;
    }
    plan.push({
      pageId: row.pageId,
      archived: row.archived,
      oldTitle: row.title,
      newTitle,
      oldTags: row.tags,
      newTags,
      oldUrl: row.url,
      newUrl,
    });
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/plan.jsonl`, plan.map((e) => JSON.stringify(e)).join("\n") + (plan.length ? "\n" : ""));
  writeFileSync(`${out}/duplicates.json`, JSON.stringify(groups, null, 2) + "\n");

  const where = (e: PlanEntry) => (e.archived ? "Archived" : "Inbox");
  deps.log(`Examples (up to ${EXAMPLES}, title changes and tag fills, Inbox and Archived):`);
  for (const ex of pickExamples(plan)) {
    if (ex.kind === "title") {
      deps.log(`  [${where(ex.entry)}] title: ${JSON.stringify(ex.entry.oldTitle)} → ${JSON.stringify(ex.entry.newTitle)}`);
    } else {
      const before = ex.entry.oldTags.length ? ex.entry.oldTags.join(", ") : "(none)";
      deps.log(`  [${where(ex.entry)}] tags: ${before} → ${ex.entry.newTags.join(", ")}  (${JSON.stringify(ex.entry.newTitle)})`);
    }
  }
  const cost = usage.input * USD_PER_INPUT_TOKEN + usage.output * USD_PER_OUTPUT_TOKEN;
  const dupRows = groups.reduce((s, g) => s + g.rows.length, 0);
  deps.log("");
  deps.log(`Tags mode: ${mode}`);
  deps.log(`Rows scanned: ${rows.length}`);
  deps.log(`Titles changed: ${plan.filter((e) => e.newTitle !== e.oldTitle).length}`);
  deps.log(`Tags added: ${tagsAdded} across ${tagsAddedRows} rows`);
  deps.log(`URLs changed: ${plan.filter((e) => e.newUrl !== e.oldUrl).length}`);
  deps.log(`Duplicate groups: ${groups.length} (${dupRows} rows, listed only, not in the plan)`);
  deps.log(`Claude failures (old title kept): ${failed}`);
  deps.log(`Rows in plan: ${plan.length}`);
  deps.log(`Claude cost: $${cost.toFixed(4)} (${usage.input} input, ${usage.output} output tokens)`);
  deps.log(`Elapsed: ${((deps.now() - started) / 1000).toFixed(1)} s`);
  deps.log(`Wrote ${out}/plan.jsonl and ${out}/duplicates.json`);
}

// Round-robin over title changes and tag fills, Inbox and Archived, one example per row.
function pickExamples(plan: PlanEntry[]): { kind: "title" | "tags"; entry: PlanEntry }[] {
  const buckets: { kind: "title" | "tags"; entries: PlanEntry[] }[] = [
    { kind: "title", entries: plan.filter((e) => !e.archived && e.newTitle !== e.oldTitle) },
    { kind: "tags", entries: plan.filter((e) => !e.archived && e.newTags.length > e.oldTags.length) },
    { kind: "title", entries: plan.filter((e) => e.archived && e.newTitle !== e.oldTitle) },
    { kind: "tags", entries: plan.filter((e) => e.archived && e.newTags.length > e.oldTags.length) },
  ];
  const picked: { kind: "title" | "tags"; entry: PlanEntry }[] = [];
  const used = new Set<string>();
  let progress = true;
  while (picked.length < EXAMPLES && progress) {
    progress = false;
    for (const b of buckets) {
      if (picked.length >= EXAMPLES) break;
      const entry = b.entries.find((e) => !used.has(e.pageId));
      if (!entry) continue;
      used.add(entry.pageId);
      picked.push({ kind: b.kind, entry });
      progress = true;
    }
  }
  return picked;
}

// --- Apply and rollback ---

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

// Order-free: a reshuffle of the same tags isn't an edit worth skipping a row for.
function sameTagSet(a: string[], b: string[]): boolean {
  return sameTags([...a].sort(), [...b].sort());
}

// Tag names → option ids through guardTags. Refuses (throws) rather than drop a tag.
function tagIds(l: Lib, names: string[], options: TagOptions, pageId: string): string[] {
  const refs = l.tags.guardTags(names, options);
  if (refs.length !== names.length) {
    throw new Error(`Row ${pageId}: tags ${JSON.stringify(names)} don't all map to Tags options (max ${MAX_TAGS})`);
  }
  return refs.map((r) => r.id);
}

export async function apply(deps: Deps, planPath: string, out: string): Promise<void> {
  const l = await lib();
  const plan = readJsonl<PlanEntry>(planPath);
  const n = notionClient(deps, l.config.NOTION_VERSION);
  const { options } = await readTagOptions(n, l);

  // Build every write first, so a bad plan line stops the run before anything is written.
  const writes = plan.map((e) => {
    const props: Properties = {};
    const fields: RollbackEntry["fields"] = [];
    if (e.newTitle !== e.oldTitle) {
      Object.assign(props, l.notion.titleProp(e.newTitle));
      fields.push("title");
    }
    if (!sameTags(e.newTags, e.oldTags)) {
      Object.assign(props, l.notion.tagIdsProp(tagIds(l, e.newTags, options, e.pageId)));
      fields.push("tags");
    }
    if (e.newUrl !== e.oldUrl && e.newUrl) {
      Object.assign(props, l.notion.urlProp(e.newUrl));
      fields.push("url");
    }
    return { entry: e, props, fields };
  });

  mkdirSync(out, { recursive: true });
  const logPath = `${out}/rollback.jsonl`;
  let written = 0;
  let skipped = 0;
  for (const { entry: e, props, fields } of writes) {
    if (fields.length === 0) continue;
    // Re-read right before writing. A row the user edited (or trashed) since the dry run is
    // skipped; otherwise the rollback entry holds what's in Notion now, not the plan's copy.
    const current = rowFromPage(l, await n.retrievePage(e.pageId));
    if (
      current === null ||
      current.title !== e.oldTitle ||
      current.url !== e.oldUrl ||
      !sameTagSet(current.tags, e.oldTags)
    ) {
      deps.log(`  ${e.pageId} skipped: changed since dry run`);
      skipped++;
      continue;
    }
    const rollback: RollbackEntry = {
      pageId: e.pageId,
      fields,
      title: current.title,
      tags: current.tags,
      url: current.url,
    };
    appendFileSync(logPath, JSON.stringify(rollback) + "\n");
    await n.patchPage(e.pageId, props);
    written++;
  }
  deps.log(`Rows written: ${written} of ${plan.length} in the plan`);
  deps.log(`Skipped (changed since dry run): ${skipped}`);
  deps.log(`Old values logged to ${logPath}`);
}

export async function rollback(deps: Deps, logPath: string): Promise<void> {
  const l = await lib();
  const entries = readJsonl<RollbackEntry>(logPath);
  const n = notionClient(deps, l.config.NOTION_VERSION);
  const { options } = await readTagOptions(n, l);

  const writes = entries.map((e) => {
    const props: Properties = {};
    if (e.fields.includes("title")) Object.assign(props, l.notion.titleProp(e.title));
    if (e.fields.includes("tags")) Object.assign(props, l.notion.tagIdsProp(tagIds(l, e.tags, options, e.pageId)));
    if (e.fields.includes("url")) {
      Object.assign(props, e.url === null ? { [l.config.PROPS.url]: { url: null } } : l.notion.urlProp(e.url));
    }
    return { pageId: e.pageId, props };
  });

  // Newest first, so a row written twice ends at its oldest logged value.
  let restored = 0;
  for (const w of writes.reverse()) {
    if (Object.keys(w.props).length === 0) continue;
    await n.patchPage(w.pageId, w.props);
    restored++;
  }
  deps.log(`Rows restored: ${restored}`);
}

// --- CLI ---

export type Command =
  | { cmd: "dry-run"; out: string; tags: TagsMode }
  | { cmd: "apply"; plan: string; out: string }
  | { cmd: "rollback"; log: string };

export function parseArgs(argv: string[]): Command {
  let cmd: Command["cmd"] | undefined;
  let file: string | undefined;
  let out: string | undefined;
  let tags: TagsMode = "fill-empty";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (flag: string) => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (a === "--dry-run") cmd = "dry-run";
    else if (a === "--apply") [cmd, file] = ["apply", value(a)];
    else if (a === "--rollback") [cmd, file] = ["rollback", value(a)];
    else if (a === "--out") out = value(a);
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a.startsWith("--tags=")) {
      const m = a.slice("--tags=".length);
      if (m !== "fill-empty" && m !== "union") throw new Error(`--tags must be fill-empty or union, not ${m}`);
      tags = m;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (cmd === undefined) throw new Error("Pass one of --dry-run, --apply <plan.jsonl>, --rollback <rollback.jsonl>");
  if (cmd === "rollback") return { cmd, log: file! };
  if (!out) throw new Error("--out <dir> is required (a gitignored .context/backfill directory)");
  if (cmd === "dry-run") return { cmd, out, tags };
  return { cmd, plan: file!, out };
}

export async function run(argv: string[], deps: Deps): Promise<void> {
  const c = parseArgs(argv);
  if (c.cmd === "dry-run") return dryRun(deps, c.out, c.tags);
  if (c.cmd === "apply") return apply(deps, c.plan, c.out);
  return rollback(deps, c.log);
}

// Node entry. src/ uses extensionless relative imports (bundler resolution), so add the .ts
// here, as scripts/eval-tags.ts does. Under Vitest import.meta.main is unset and this is skipped.
if ((import.meta as { main?: boolean }).main) {
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        try {
          return next(`${specifier}.ts`, context);
        } catch {
          // fall through to the default
        }
      }
      return next(specifier, context);
    },
  });
  try {
    await run(process.argv.slice(2), {
      env: {
        NOTION_TOKEN: process.env.NOTION_TOKEN,
        NOTION_DATA_SOURCE_ID: process.env.NOTION_DATA_SOURCE_ID,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
      log: (line) => console.log(line),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      minIntervalMs: 334,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
