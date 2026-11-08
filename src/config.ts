// Notion identity in one place (D-15). A fork remaps property names here; nothing else
// in src/ may spell a property name. Tags options are read live from the schema (D-6).

export const PROPS = {
  name: "Name",
  url: "URL",
  tags: "Tags",
  archived: "Archived",
  favorite: "Favorite",
  media: "Media",
} as const;

// Pinned Notion API version (D-10). Pages are created under the data source.
export const NOTION_VERSION = "2026-03-11";

const PLACEHOLDER = "set-at-deploy";

// The two IDs are vars (wrangler.jsonc), set for real by scripts/deploy.sh.
export function notionIds(env: Env): { databaseId: string; dataSourceId: string } {
  const databaseId = env.NOTION_DATABASE_ID;
  const dataSourceId = env.NOTION_DATA_SOURCE_ID;
  if (!databaseId || databaseId === PLACEHOLDER) {
    throw new Error("NOTION_DATABASE_ID is not set");
  }
  if (!dataSourceId || dataSourceId === PLACEHOLDER) {
    throw new Error("NOTION_DATA_SOURCE_ID is not set");
  }
  return { databaseId, dataSourceId };
}
