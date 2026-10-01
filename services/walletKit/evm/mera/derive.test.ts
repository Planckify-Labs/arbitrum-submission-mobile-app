/**
 * Mera passkey derivation (docs/monad-metropolis-2026-spec.md §3.2).
 *
 * Pins the properties the "no seed phrase" claim and the multi-chain
 * passkey account rest on:
 *   - determinism: the same PRF output always yields the same addresses,
 *   - the EVM address is `mnemonicToAccount` at m/44'/60'/0'/0/0 of the
 *     PRF mnemonic,
 *   - the row shape: one ordinary `SeedPhrase` row per registered
 *     chain, EVM first, tagged with the credential like Google tags
 *     `socialAccount` (no passkey-specific type for shared code to
 *     branch on).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { MeraError } from "@category-labs/mera";
import { mnemonicToAccount } from "viem/accounts";
import { __resetWalletKitBootForTests, bootWalletKits } from "../../boot.ts";
import { walletKitRegistry } from "../../registry.ts";
import {
  derivePasskeyWallets,
  PASSKEY_RP_ID,
  passkeyMnemonic,
} from "./derive.ts";
import { classifyPasskeyError } from "./errors.ts";

const PRF = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const PASSKEY = { credentialId: "Y3JlZC1pZA", rpId: PASSKEY_RP_ID };

describe("derivePasskeyWallets", () => {
  before(() => {
    walletKitRegistry.clear();
    __resetWalletKitBootForTests();
    bootWalletKits();
  });

  // What a ceremony hands back for a given PRF output.
  const ceremonyFor = (prf: Uint8Array) => ({
    mnemonic: passkeyMnemonic(prf),
    passkey: PASSKEY,
  });

  it("is deterministic for the same PRF output", async () => {
    const a = await derivePasskeyWallets(ceremonyFor(PRF));
    const b = await derivePasskeyWallets(ceremonyFor(new Uint8Array(PRF)));
    assert.deepEqual(
      a.map((w) => w.address),
      b.map((w) => w.address),
    );
  });

  it("derives the EVM address from the PRF mnemonic", async () => {
    const [evm] = await derivePasskeyWallets(ceremonyFor(PRF));
    assert.equal(evm.namespace, "eip155");
    assert.equal(evm.address, mnemonicToAccount(passkeyMnemonic(PRF)).address);
  });

  it("produces one tagged seed row per registered chain", async () => {
    const rows = await derivePasskeyWallets({
      ...ceremonyFor(PRF),
      name: "Demo",
    });
    assert.deepEqual(
      rows.map((w) => w.namespace),
      walletKitRegistry.getAll().map((k) => k.namespace),
    );
    for (const w of rows) {
      assert.equal(w.type, "SeedPhrase");
      assert.deepEqual(w.passkey, PASSKEY);
      assert.match(w.name, /^Demo · /);
      // Shared mnemonic: what groups the rows into one account and lets
      // the backfill mint a future chain from the same passkey.
      assert.equal(w.seedPhrase, passkeyMnemonic(PRF));
    }
  });

  it("changes addresses when the PRF output changes", async () => {
    const other = new Uint8Array(PRF);
    other[0] ^= 1;
    const a = await derivePasskeyWallets(ceremonyFor(PRF));
    const b = await derivePasskeyWallets(ceremonyFor(other));
    for (let i = 0; i < a.length; i++) {
      assert.notEqual(a[i].address, b[i].address);
    }
  });
});

describe("passkeyMnemonic", () => {
  it("rejects a PRF output that is not 32 bytes", () => {
    assert.throws(() => passkeyMnemonic(new Uint8Array(31)));
  });
});

describe("classifyPasskeyError", () => {
  it("maps PRF_UNAVAILABLE to the unsupported-provider copy", () => {
    const c = classifyPasskeyError(new MeraError("PRF_UNAVAILABLE", "x"));
    assert.equal(c.kind, "prf-unavailable");
  });

  it("detects a cancelled ceremony through the wrapped cause", () => {
    const native = Object.assign(new Error("User cancelled the request"), {
      code: "UserCancelled",
    });
    const c = classifyPasskeyError(
      new MeraError("PASSKEY_OPERATION_FAILED", "Passkey creation failed", {
        cause: native,
      }),
    );
    assert.equal(c.kind, "cancelled");
  });

  it("never echoes the raw message", () => {
    const c = classifyPasskeyError(new Error('500 {"code":"boom"}'));
    assert.equal(c.kind, "failed");
    assert.doesNotMatch(c.message, /boom/);
  });
});
