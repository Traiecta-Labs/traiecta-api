/**
 * Unit tests for `src/chains/stellar/rpc.ts`.
 *
 * This file is the only place the Stellar watcher's backoff policy is decided. `call` classifies
 * every failure as retryable or not: 429 and 5xx are load, other 4xx are a wrong request, a body
 * that is not JSON is a transport fault, and a JSON-RPC error naming the ledger range is retention,
 * which no amount of retrying fixes. `stellar-events.test.ts` covers the decoder and
 * `stellar-watcher.test.ts` drives its own `FakeRpc`, so the classification is asserted here
 * against a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { StellarRpc, StellarRpcError } from "../../src/chains/stellar/rpc.js";

const URL = "https://soroban-testnet.stellar.org";
const CONTRACT = "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF";

/** The `retryable` flag of the `StellarRpcError` a call rejects with. */
async function retryableFlag(call: Promise<unknown>): Promise<boolean> {
  try {
    await call;
  } catch (error) {
    if (error instanceof StellarRpcError) return error.retryable;
    throw error;
  }
  throw new Error("expected the call to reject");
}

/** Stub `fetch` with one JSON response, then classify the resulting failure. */
function retryableWhen(body: unknown, status: number): Promise<boolean> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
  return retryableFlag(new StellarRpc(URL).latestLedger());
}

/** Stub `fetch` with a body that is not JSON, then classify the resulting failure. */
function retryableWhenNotJson(body: string): Promise<boolean> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
  );
  return retryableFlag(new StellarRpc(URL).latestLedger());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StellarRpc retry classification", () => {
  it("marks HTTP 429 retryable", async () => {
    expect(await retryableWhen({ error: "rate limited" }, 429)).toBe(true);
  });

  it("marks other 4xx non-retryable", async () => {
    expect(await retryableWhen({ error: "bad request" }, 400)).toBe(false);
  });

  it("marks a JSON-RPC retention error non-retryable", async () => {
    // "ledger range" is the node saying the cursor fell out of its window. Retrying re-asks the
    // same question the node has already refused to answer.
    expect(
      await retryableWhen(
        { error: { message: "startLedger must be within the ledger range: 100 - 200" } },
        200,
      ),
    ).toBe(false);
  });

  it("marks a non-JSON body retryable", async () => {
    expect(await retryableWhenNotJson("<html>502 Bad Gateway</html>")).toBe(true);
  });
});

describe("StellarRpc events guard", () => {
  it("rejects a query carrying both a startLedger and a cursor", async () => {
    const call = new StellarRpc(URL).events({
      contractIds: [CONTRACT],
      startLedger: 1,
      cursor: "0000000000000000001-0000000000",
      limit: 200,
    });

    await expect(call).rejects.toBeInstanceOf(StellarRpcError);
    await expect(call).rejects.toMatchObject({ retryable: false });
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";

import { StellarRpc, StellarRpcError, type EventsQuery } from "../../src/chains/stellar/rpc.js";

describe("StellarRpc error classification and queries", () => {
  const rpcUrl = "http://127.0.0.1:8000/rpc";
  const rpc = new StellarRpc(rpcUrl);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("HTTP status code handling", () => {
    it("marks HTTP 429 as retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("http 429");
        expect(rpcErr.retryable).toBe(true);
        return true;
      });
    });

    it("marks HTTP 5xx (e.g. 500, 503) as retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("http 503");
        expect(rpcErr.retryable).toBe(true);
        return true;
      });
    });

    it("marks HTTP 400 (and other non-429 4xx) as non-retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("http 400");
        expect(rpcErr.retryable).toBe(false);
        return true;
      });
    });
  });

  describe("response body parsing", () => {
    it("marks non-JSON body as retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token < in JSON")),
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("response was not json");
        expect(rpcErr.retryable).toBe(true);
        return true;
      });
    });

    it("marks JSON-RPC error naming ledger range as non-retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32600,
              message: "startLedger must be within the ledger range [100, 200]",
            },
          }),
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("must be within the ledger range");
        expect(rpcErr.retryable).toBe(false);
        return true;
      });
    });

    it("marks JSON-RPC error not mentioning ledger range as retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32603,
              message: "internal rate limit or transient upstream error",
            },
          }),
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("transient upstream error");
        expect(rpcErr.retryable).toBe(true);
        return true;
      });
    });

    it("marks response with neither result nor error as retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            jsonrpc: "2.0",
            id: 1,
          }),
        }),
      );

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("response carried neither a result nor an error");
        expect(rpcErr.retryable).toBe(true);
        return true;
      });
    });
  });

  describe("transport and abort errors", () => {
    it("marks fetch network error as retryable when not aborted", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(rpc.latestLedger()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toContain("ECONNREFUSED");
        expect(rpcErr.retryable).toBe(true);
        return true;
      });
    });

    it("marks caller aborted error as non-retryable", async () => {
      const controller = new AbortController();
      controller.abort();

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted")));

      await expect(rpc.latestLedger(controller.signal)).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getLatestLedger");
        expect(rpcErr.message).toBe("getLatestLedger: cancelled");
        expect(rpcErr.retryable).toBe(false);
        return true;
      });
    });
  });

  describe("events query parameter validation", () => {
    it("rejects a query carrying both startLedger and cursor as non-retryable", async () => {
      const query: EventsQuery = {
        contractIds: ["CA3D5KRYM6CB7OWQ6TWYRR3Z4T7ZQVNOQ"],
        startLedger: 1000,
        cursor: "0021002390077439999-4294967295",
        limit: 10,
      };

      await expect(rpc.events(query)).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getEvents");
        expect(rpcErr.message).toContain("takes a startLedger or a cursor, never both");
        expect(rpcErr.retryable).toBe(false);
        return true;
      });
    });

    it("rejects a query missing both startLedger and cursor as non-retryable", async () => {
      const query: EventsQuery = {
        contractIds: ["CA3D5KRYM6CB7OWQ6TWYRR3Z4T7ZQVNOQ"],
        limit: 10,
      };

      await expect(rpc.events(query)).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(StellarRpcError);
        const rpcErr = err as StellarRpcError;
        expect(rpcErr.method).toBe("getEvents");
        expect(rpcErr.message).toContain("needs either a startLedger or a cursor");
        expect(rpcErr.retryable).toBe(false);
        return true;
      });
    });
  });
});
