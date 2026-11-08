import { PROPS } from "./config";
import type { EnrichJob } from "./contract";
import { isMissingTitle } from "./fallback-title";
import { logEvent } from "./log";
import { NotionError, type Properties, notion, titleProp, truncateText, urlProp } from "./notion";
import { type LookupResult, lookupTitle } from "./title";

// Background enrich, run in waitUntil after a create (D-1, "Rules in full" > Response path
// budget). A sequence of stages, each with its own timeout and none sharing a signal:
// lookup (5 s over all its fetches), Claude (null until SAT-15), re-read (3 s), then ONE
// patch (3 s). Satchel never retries Notion (D-10): any NotionError logs `enrich_failed`
// with its stage and stops, leaving the row as saved. Never throws.

const LOOKUP_STAGE_MS = 5000;
const REREAD_MS = 3000;
const PATCH_MS = 3000;

// A media-only X post: oEmbed's text is just the pic.twitter.com link (lead ruling R2).
const MEDIA_ONLY_X = /^.+?: pic\.twitter\.com\/\S+$/;

type Stage = "reread" | "patch";

// Claude stage slot. M1 has no Claude, so there's never a cleaned title; SAT-15 fills this
// with its own timeout and signal.
async function claudeStage(_job: EnrichJob, _lookup: LookupResult): Promise<string | null> {
  return null;
}

// R2: whitespace collapsed (X `<br>` newlines included) and trimmed. Empty, URL-equal and
// media-only X titles carry nothing, so they're no title. titleProp truncates at 2000.
export function usableTitle(title: string | null | undefined, storedUrl: string): string | null {
  if (typeof title !== "string") return null;
  const clean = title.replace(/\s+/g, " ").trim();
  if (isMissingTitle(clean, storedUrl, storedUrl)) return null;
  if (MEDIA_ONLY_X.test(clean)) return null;
  return clean;
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

export async function enrich(job: EnrichJob, env: Env): Promise<void> {
  const start = Date.now();
  let stage: Stage | "unexpected" = "unexpected";
  try {
    // Lookup: skipped when the client sent a title.
    const lookup: LookupResult =
      job.clientTitle !== undefined
        ? { title: null, source: "client", bytesRead: 0 }
        : await lookupTitle(job.storedUrl, job.kind, AbortSignal.timeout(LOOKUP_STAGE_MS));

    const claudeTitle = await claudeStage(job, lookup);

    const client = notion(env);

    stage = "reread";
    const page = await client.retrievePage(job.pageId, { timeoutMs: REREAD_MS });
    stage = "unexpected";

    const props: Properties = {};

    const name = usableTitle(claudeTitle, job.storedUrl) ?? usableTitle(lookup.title, job.storedUrl);
    if (name !== null) {
      const created = truncateText((job.clientTitle ?? job.fallbackTitle).trim()).trim();
      const now = currentName(page.properties);
      if (now !== null && now.trim() === created) Object.assign(props, titleProp(name));
    }

    stage = "patch";
    // R5: X only, oEmbed's canonical when it differs from what's stored. urlProp guards 2000.
    if (job.kind === "x" && lookup.url && lookup.url !== job.storedUrl) {
      Object.assign(props, urlProp(lookup.url));
    }

    if (Object.keys(props).length === 0) {
      logEvent("enrich", {
        ok: true,
        pageId: job.pageId,
        source: lookup.source,
        ms: Date.now() - start,
        patched: false,
      });
      return;
    }

    await client.patchPage(job.pageId, props, { timeoutMs: PATCH_MS });
    logEvent("enrich", {
      ok: true,
      pageId: job.pageId,
      source: lookup.source,
      ms: Date.now() - start,
      patched: true,
    });
  } catch (err) {
    try {
      failed(err instanceof NotionError ? stage : "unexpected", job?.pageId, err);
    } catch {
      // Logging itself failed; there's nothing left to do, and enrich must never throw.
    }
  }
}
