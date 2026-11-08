import { type ClaudeInput, cleanTitleAndTags } from "./claude";
import { PROPS } from "./config";
import type { EnrichJob } from "./contract";
import { isMissingTitle } from "./fallback-title";
import { logEvent } from "./log";
import { NotionError, type Properties, notion, tagIdsProp, titleProp, truncateText, urlProp } from "./notion";
import { type TagOptions, getTagOptions, guardTags, invalidateTagCache } from "./tags";
import { type LookupResult, lookupTitle } from "./title";

// Background enrich, run in waitUntil after a create (D-1, "Rules in full" > Response path
// budget). A sequence of stages, each with its own timeout: lookup (5 s over all its
// fetches), tag options (3 s), Claude (10 s, abandoned at the 22 s deadline), re-read (3 s),
// then ONE patch (3 s). Only Claude runs under the deadline signal; the re-read and patch
// never do. Satchel never retries Notion (D-10): any NotionError logs `enrich_failed` with
// its stage and stops, leaving the row as saved. The one exception is D-6's re-patch after a
// schema change (a tag patch rejected with validation_error). Never throws.

const LOOKUP_STAGE_MS = 5000;
const REREAD_MS = 3000;
const PATCH_MS = 3000;
// Measured from task start. Worst case 5 + 3 + 10 + 3 + 3 = 24 s, under Cloudflare's 30 s.
export const DEADLINE_MS = 22_000;

export type EnrichOptions = { deadlineMs?: number };

// An X post with no text of its own: only media or links (SAT-12, SAT-37). Tested on the
// post text alone (never the `author: ` title, so a real post ending in "...: pic.twitter.com/x"
// keeps its title). A link reads as X shows it: a full URL (t.co or any other, Twitterbot's
// og:description), a pic.twitter.com media link, or a display URL (host plus a path, maybe
// cut with "…"). A display URL needs the path, so "Node.js", "Node.js…" and "box.com" stay text.
const LINK = String.raw`(?:https?:\/\/\S+|pic\.twitter\.com\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*)`;
const NO_POST_TEXT = new RegExp(`^${LINK}(?: ${LINK})*$`, "i");

type Stage = "schema" | "reread" | "patch";

// R2: whitespace collapsed (X `<br>` newlines included) and trimmed. Empty and URL-equal
// titles carry nothing, so they're no title. titleProp truncates at 2000.
export function usableTitle(title: string | null | undefined, storedUrl: string): string | null {
  if (typeof title !== "string") return null;
  const clean = title.replace(/\s+/g, " ").trim();
  if (isMissingTitle(clean, storedUrl, storedUrl)) return null;
  return clean;
}

// R2: an X lookup whose post text is only media or links has no title worth writing.
export function isNoTextX(lookup: LookupResult): boolean {
  if (lookup.source !== "x-oembed" && lookup.source !== "x-twitterbot") return false;
  return NO_POST_TEXT.test((lookup.description ?? "").replace(/\s+/g, " ").trim());
}

// The looked-up title for Name purposes, after R2 hygiene.
function lookedUpTitle(lookup: LookupResult, storedUrl: string): string | null {
  return isNoTextX(lookup) ? null : usableTitle(lookup.title, storedUrl);
}

// R4: the Name's plain text, joined across its rich-text runs. Null when the shape is off,
// which the guard reads as "changed" (never overwrite what we can't read).
function currentName(properties: Record<string, unknown> | undefined): string | null {
  const prop = properties?.[PROPS.name] as { title?: unknown } | undefined;
  if (!prop || !Array.isArray(prop.title)) return null;
  let text = "";
  for (const run of prop.title) {
    const plain = (run as { plain_text?: unknown } | null)?.plain_text;
    if (typeof plain !== "string") return null;
    text += plain;
  }
  return text;
}

// R4: the re-read Name still reads as what save wrote. Save wrote it through titleProp,
// which truncates at 2000, so a long client title is compared truncated, like for like.
export function nameUnchanged(job: EnrichJob, now: string | null): boolean {
  if (now === null) return false;
  return now.trim() === truncateText(job.clientTitle ?? job.fallbackTitle).trim();
}

// The URL property's value from the re-read, or null when the shape is off.
function currentUrl(properties: Record<string, unknown> | undefined): string | null {
  const url = (properties?.[PROPS.url] as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : null;
}

// R5 plus the lead's PR #17 rulings: X only, oEmbed's canonical when it differs from what's
// stored, only when it names the same post id, and only while the row's URL is still the
// stored one (an edit in Notion wins). urlProp's 2000 guard (or any other throw) drops just
// the URL, never the Name.
function urlSwap(job: EnrichJob, lookup: LookupResult, now: string | null): Properties {
  if (job.kind !== "x" || !lookup.url || lookup.url === job.storedUrl) return {};
  const id = /\/status\/(\d+)$/.exec(job.storedUrl)?.[1];
  if (!id || !new RegExp(`/status/${id}(?:$|\\D)`).test(lookup.url)) return {};
  if (now !== job.storedUrl) return {};
  try {
    return urlProp(lookup.url);
  } catch {
    return {};
  }
}

// R4's rule applied to Tags: the re-read's tag count, or null when the shape is off, which
// reads as "not empty" (never overwrite what we can't read).
function currentTagCount(properties: Record<string, unknown> | undefined): number | null {
  const tags = (properties?.[PROPS.tags] as { multi_select?: unknown } | undefined)?.multi_select;
  return Array.isArray(tags) ? tags.length : null;
}

function collapse(text: string | undefined): string | undefined {
  const clean = text?.replace(/\s+/g, " ").trim();
  return clean ? clean : undefined;
}

// What Claude sees (D-8, "Rules in full" > Claude request). A client title skips lookup, so
// Claude gets that title and the URL only. Otherwise an X post with author and text is the
// `x` shape, a usable looked-up title is `titled`, and anything else is `untitled`.
export function toClaudeInput(job: EnrichJob, lookup: LookupResult): ClaudeInput {
  const url = job.storedUrl;
  if (job.clientTitle !== undefined) return { shape: "titled", title: job.clientTitle, url };
  const text = collapse(lookup.description);
  const author = collapse(lookup.author);
  if (job.kind === "x" && author && text) {
    return { shape: "x", author, ...(lookup.handle ? { handle: lookup.handle } : {}), text, url };
  }
  const description = text ? { description: text } : {};
  const title = usableTitle(lookup.title, url);
  if (title !== null) return { shape: "titled", title, ...description, url };
  return { shape: "untitled", ...description, url };
}

type ClaudeStage = {
  options: TagOptions | null; // null when the schema retrieve failed
  title: string | null;
  tagNames: string[];
  claude: boolean; // Claude answered with usable output
  reason?: "no_text_x"; // why Claude was skipped on purpose, logged on `enrich`
};

const ABANDONED = Symbol("abandoned");

// Resolves with `p`, or with ABANDONED once `signal` fires, even if `p` ignores the abort.
async function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABANDONED> {
  if (signal.aborted) return ABANDONED;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABANDONED>((resolve) => {
    onAbort = () => resolve(ABANDONED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// Tag options (3 s, cached), then Claude under the deadline signal. Fails soft: a schema
// failure logs `enrich_failed{stage: "schema"}` and skips Claude; an empty option list skips
// Claude (a zero-length enum would 400, R4); a Claude failure was already logged by claude.ts;
// the deadline logs `enrich_deadline`. Every path goes on to the re-read and the patch.
// SAT-37: an X post with no text of its own (and no client title, which skips lookup) skips
// this stage outright. The stored URL is `x.com/i/status/<id>`, so Claude would have nothing
// to go on and would invent a contentless Name and guess tags. The fallback Name stays.
async function claudeStage(
  job: EnrichJob,
  lookup: LookupResult,
  env: Env,
  deadline: AbortSignal,
  start: number,
): Promise<ClaudeStage> {
  const none = (options: TagOptions | null): ClaudeStage => ({ options, title: null, tagNames: [], claude: false });
  if (isNoTextX(lookup)) return { ...none(null), reason: "no_text_x" };

  let options: TagOptions;
  try {
    options = await getTagOptions(env);
  } catch (err) {
    if (!(err instanceof NotionError)) throw err;
    failed("schema", job.pageId, err);
    return none(null);
  }
  if (options.size === 0) return none(options);

  const names = [...options.values()].map((o) => o.name);
  const out = await untilAbort(cleanTitleAndTags(env, toClaudeInput(job, lookup), names, deadline), deadline);
  if (out === ABANDONED) {
    logEvent("enrich_deadline", { pageId: job.pageId, ms: Date.now() - start });
    return none(options);
  }
  if (out === null) return none(options);
  return { options, title: out.title, tagNames: out.tags, claude: true };
}

function failed(stage: Stage | "unexpected", pageId: unknown, err: unknown): void {
  const fields: Record<string, unknown> = { ok: false, stage, pageId };
  if (err instanceof NotionError) {
    fields.status = err.status;
    fields.error = err.code;
  } else {
    fields.error = err instanceof Error ? err.name : "unknown";
  }
  logEvent("enrich_failed", fields);
}

export async function enrich(job: EnrichJob, env: Env, opts: EnrichOptions = {}): Promise<void> {
  const start = Date.now();
  // One signal for the whole task, fired deadlineMs after start. Only Claude listens to it.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), opts.deadlineMs ?? DEADLINE_MS);
  let stage: Stage | "unexpected" = "unexpected";
  try {
    // Lookup: skipped when the client sent a title.
    const lookup: LookupResult =
      job.clientTitle !== undefined
        ? { title: null, source: "client", bytesRead: 0 }
        : await lookupTitle(job.storedUrl, job.kind, AbortSignal.timeout(LOOKUP_STAGE_MS));

    const claude = await claudeStage(job, lookup, env, deadline.signal, start);

    // From here on nothing runs under the deadline: the re-read and patch keep their own 3 s.
    const client = notion(env);

    stage = "reread";
    const page = await client.retrievePage(job.pageId, { timeoutMs: REREAD_MS });
    stage = "unexpected";

    const props: Properties = {};

    // R2: Claude's title gets the same hygiene as a looked-up one; empty means none.
    const name = usableTitle(claude.title, job.storedUrl) ?? lookedUpTitle(lookup, job.storedUrl);
    if (name !== null && nameUnchanged(job, currentName(page.properties))) {
      Object.assign(props, titleProp(name));
    }
    Object.assign(props, urlSwap(job, lookup, currentUrl(page.properties)));

    // Tags only while the row has none, by option id only, guarded against the same options
    // map the enum came from.
    const options = claude.options;
    let tags = options && currentTagCount(page.properties) === 0 ? guardTags(claude.tagNames, options) : [];
    const setTags = () => {
      delete props[PROPS.tags];
      if (tags.length > 0) Object.assign(props, tagIdsProp(tags.map((t) => t.id)));
    };
    setTags();

    const done = (patched: boolean) =>
      logEvent("enrich", {
        ok: true,
        pageId: job.pageId,
        source: lookup.source,
        ms: Date.now() - start,
        patched,
        claude: claude.claude,
        ...(claude.reason ? { reason: claude.reason } : {}),
        tags: patched ? tags.length : 0,
      });

    stage = "patch";

    if (Object.keys(props).length === 0) {
      done(false);
      return;
    }

    try {
      await client.patchPage(job.pageId, props, { timeoutMs: PATCH_MS });
    } catch (err) {
      // D-6: a tag patch rejected with validation_error means the options changed under the
      // cache. Refetch once, rebuild the ids from Claude's names, patch once more (R5). Any
      // other failure, or one on the re-patch, is enrich_failed like everywhere else.
      if (!(err instanceof NotionError && err.code === "validation_error" && tags.length > 0)) throw err;
      invalidateTagCache();
      stage = "schema";
      const fresh = await getTagOptions(env);
      stage = "patch";
      tags = guardTags(claude.tagNames, fresh);
      setTags();
      await client.patchPage(job.pageId, props, { timeoutMs: PATCH_MS });
    }
    done(true);
  } catch (err) {
    try {
      failed(err instanceof NotionError ? stage : "unexpected", job?.pageId, err);
    } catch {
      // Logging itself failed; there's nothing left to do, and enrich must never throw.
    }
  } finally {
    clearTimeout(timer);
  }
}
