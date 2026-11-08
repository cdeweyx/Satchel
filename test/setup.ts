import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll } from "vitest";
import { catchAll, network } from "./network";

// vi.mock calls AsyncLocalStorage.prototype.disable(), which workerd doesn't implement; a no-op is safe.
AsyncLocalStorage.prototype.disable = function () {};

beforeAll(async () => {
  await network.enable();
  // resetHandlers(...handlers) replaces the initial handlers, so the catch-all survives
  // every later resetHandlers() call.
  network.resetHandlers(catchAll);
});

afterEach(() => {
  network.resetHandlers();
});

afterAll(async () => {
  await network.disable();
});
