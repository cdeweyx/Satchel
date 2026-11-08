import { afterAll, afterEach, beforeAll } from "vitest";
import { catchAll, network } from "./network";

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
