/**
 * Unit tests for `src/runtime/shutdown.ts`.
 *
 * The file's whole promise is ordering. A watcher killed while a transaction is open holds a
 * Postgres connection until the server times it out, so shutdown has to stop accepting work, let
 * the current page finish, and only then close the pool. That is what "steps run in reverse
 * registration order" buys, and a regression that stopped reversing the list would close the pool
 * while the indexer is mid-page. Nothing else imports this file, so all of it is asserted here.
 */
import { describe, expect, it } from "vitest";

import { Shutdown } from "../../src/runtime/shutdown.js";
import { capturingLogger } from "../stellar-fakes.js";

/** A step that records that it ran and resolves immediately. */
function recordingStep(order: string[], name: string): () => Promise<void> {
  return () => {
    order.push(name);
    return Promise.resolve();
  };
}

describe("Shutdown", () => {
  it("runs steps in reverse registration order", async () => {
    const { logger } = capturingLogger();
    const shutdown = new Shutdown(logger, 5_000);
    const order: string[] = [];

    shutdown.add("postgres", recordingStep(order, "postgres"));
    shutdown.add("redis", recordingStep(order, "redis"));
    shutdown.add("indexer", recordingStep(order, "indexer"));
    shutdown.add("http", recordingStep(order, "http"));

    await shutdown.run("SIGTERM");

    expect(order).toEqual(["http", "indexer", "redis", "postgres"]);
  });

  it("logs a failing step and still runs the remaining steps", async () => {
    const { logger, lines } = capturingLogger();
    const shutdown = new Shutdown(logger, 5_000);
    const order: string[] = [];

    shutdown.add("first", recordingStep(order, "first"));
    // Registered second, so it runs first. An unclosed pool is the failure a step that will not
    // finish must not be allowed to cause.
    shutdown.add("boom", () => {
      order.push("boom");
      return Promise.reject(new Error("step refused to finish"));
    });
    shutdown.add("last", recordingStep(order, "last"));

    await shutdown.run("SIGTERM");

    expect(order).toEqual(["last", "boom", "first"]);
    expect(lines.some((line) => line.message === "shutdown step failed")).toBe(true);
  });

  it("does not re-run any step when run is called twice", async () => {
    const { logger } = capturingLogger();
    const shutdown = new Shutdown(logger, 5_000);
    const order: string[] = [];

    shutdown.add("postgres", recordingStep(order, "postgres"));

    expect(shutdown.started).toBe(false);
    await shutdown.run("SIGTERM");
    expect(shutdown.started).toBe(true);
    // A container runtime sends SIGTERM and an impatient operator sends another one.
    await shutdown.run("SIGINT");

    expect(order).toEqual(["postgres"]);
  });

  it("stops scheduling steps once the budget is spent", async () => {
    const { logger, lines } = capturingLogger();
    const shutdown = new Shutdown(logger, 20);
    const order: string[] = [];

    // Registered first, so it runs last and must not run at all: the step ahead of it outlives
    // the whole budget. Each step gets what remains, not the whole budget again.
    shutdown.add("skipped", recordingStep(order, "skipped"));
    shutdown.add("slow", () => {
      order.push("slow");
      return new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    });

    await shutdown.run("SIGTERM");

    expect(order).toEqual(["slow"]);
    expect(lines.some((line) => line.message.includes("shutdown budget spent"))).toBe(true);
  });
});
