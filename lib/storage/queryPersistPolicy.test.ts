import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldPersistQuery } from "./queryPersistPolicy.ts";

const ok = { status: "success" };

describe("shouldPersistQuery", () => {
  it("never persists send-screen fee quotes (bigint results, recipient in key)", () => {
    assert.equal(
      shouldPersistQuery({
        queryKey: ["transferFee", "eip155:84532", "0xabc", "0xdef", "native"],
        state: ok,
      }),
      false,
    );
  });

  it("leaves the gas preference to MMKV", () => {
    assert.equal(
      shouldPersistQuery({ queryKey: ["preferredGasToken"], state: ok }),
      false,
    );
  });

  it("still persists ordinary server state", () => {
    assert.equal(
      shouldPersistQuery({ queryKey: ["blockchains"], state: ok }),
      true,
    );
  });
});
