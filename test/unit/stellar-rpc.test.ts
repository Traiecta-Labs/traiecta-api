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
