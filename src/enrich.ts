import type { EnrichJob } from "./contract";

// Background title lookup and Claude enrich, run in waitUntil. Stub: SAT-12 fills the body.
// Signature is final. Must never throw: failures log `enrich_failed` (D-9).
export async function enrich(job: EnrichJob, env: Env): Promise<void> {}
