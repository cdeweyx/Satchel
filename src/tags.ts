import { PROPS } from "./config";
import { NotionError, type TagRef, notion } from "./notion";

// Tag guard (D-6). The Tags options are read live from the data source schema and cached
// per isolate for 10 minutes. Claude's tag names are matched case-insensitively against
// them and written by option id only, so a junk name can never create a new option.

export const TAG_CACHE_TTL_MS = 10 * 60 * 1000;
const RETRIEVE_TIMEOUT_MS = 3000;
const MAX_TAGS = 3;

export type TagOption = { id: string; name: string };
// Keyed by the option's lowercase name.
export type TagOptions = Map<string, TagOption>;

let cache: { options: TagOptions; fetchedAt: number } | undefined;

// One retrieve per cold isolate, then again only after the TTL. A failed retrieve (or a
// schema without a multi_select Tags property) throws and leaves nothing cached.
// `now` is injectable so tests can move past the TTL without the wall clock.
export async function getTagOptions(env: Env, now: number = Date.now()): Promise<TagOptions> {
  if (cache && now - cache.fetchedAt < TAG_CACHE_TTL_MS) return cache.options;

  const schema = await notion(env).retrieveDataSource({ timeoutMs: RETRIEVE_TIMEOUT_MS });
  const prop = schema.properties?.[PROPS.tags];
  if (!prop || prop.type !== "multi_select" || !Array.isArray(prop.multi_select?.options)) {
    throw new NotionError(200, "tags_missing");
  }

  const options: TagOptions = new Map();
  for (const opt of prop.multi_select.options) {
    if (typeof opt?.id !== "string" || typeof opt?.name !== "string") continue;
    const key = opt.name.toLowerCase();
    if (!options.has(key)) options.set(key, { id: opt.id, name: opt.name });
  }

  cache = { options, fetchedAt: now };
  return options;
}

// Drops the cached options so the next getTagOptions retrieves the schema again
// (SAT-15 calls this before its one retry on a tag-patch validation_error).
export function invalidateTagCache(): void {
  cache = undefined;
}

// Case-insensitive match, unknown names dropped, de-duplicated by id, at most 3, order kept.
// Returns fresh {id} objects only, never the option itself, so a name can't reach Notion.
export function guardTags(names: readonly string[], options: TagOptions): TagRef[] {
  const out: TagRef[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") continue;
    const opt = options.get(name.toLowerCase());
    if (!opt || seen.has(opt.id)) continue;
    seen.add(opt.id);
    out.push({ id: opt.id });
  }
  return out.slice(0, MAX_TAGS);
}
