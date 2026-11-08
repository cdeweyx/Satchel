import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";

// Every test's outbound network. Per-test mocks: network.use(http.post(url, resolver)).
export const network = setupNetwork();

// Last-resort handler: any request no test mocked fails as a network error instead of
// reaching Notion, Anthropic or anything else for real (MSW passes unmocked requests
// through by default). test/setup.ts installs it as the *initial* handler, so
// network.resetHandlers() restores it, and handlers added with network.use() are
// prepended and win over it.
export const catchAll = http.all("*", () => HttpResponse.error());
