/**
 * Unit tests for `src/logging/logger.ts`.
 *
 * Two behaviours there are load bearing and neither is exercised anywhere else. Redaction is what
 * keeps a connection string out of a log aggregator when an error handler logs a pg or fetch
 * error at speed, and the `logMethod` hook is what stops the first `bigint` logged — every block
 * height and every amount in this process is one — from throwing inside pino's serialiser and
 * taking the process down.
 *
 * The logger is pointed at a capturing destination rather than stdout, so the assertions read the
 * emitted JSON directly.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { createLogger } from "../../src/logging/logger.js";
import { completeEnv } from "../helpers.js";

/** A destination that keeps every JSON line pino writes. */
interface Capture {
  readonly lines: string[];
  readonly write: (line: string) => void;
}

function capturingDestination(): Capture {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

describe("createLogger", () => {
  it("redacts connection strings and emits a bigint as a decimal string", () => {
    // Deliberately not development: that path installs the pino-pretty transport, which formats
    // records in a worker rather than writing one JSON object per line to this destination.
    const config = loadConfig({ env: completeEnv({ NODE_ENV: "test" }) });
    const capture = capturingDestination();
    const logger = createLogger(config, capture);

    const error = new Error("connect ECONNREFUSED") as Error & { connectionString: string };
    error.connectionString = "postgres://user:hunter2@db.internal/hyperion";

    // Every field here is one the redaction list exists for, plus the bigint the serialiser hook
    // exists for. A throw anywhere in this call would be the failure the hook prevents.
    logger.info(
      {
        databaseUrl: "postgres://user:hunter2@db.internal/hyperion",
        redisUrl: "redis://:hunter2@cache.internal:6379",
        blockHeight: 12345678901234567890n,
        err: error,
      },
      "connecting",
    );

    const line = capture.lines.join("");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("db.internal");
    expect(line).not.toContain("cache.internal");
    expect(line).toContain('"databaseUrl":"[redacted]"');
    expect(line).toContain('"redisUrl":"[redacted]"');

    const parsed = JSON.parse(line) as {
      blockHeight: unknown;
      err: { connectionString: unknown };
    };
    expect(parsed.blockHeight).toBe("12345678901234567890");
    expect(parsed.err.connectionString).toBe("[redacted]");
  });
});
