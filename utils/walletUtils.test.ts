/**
 * Unit tests for the Solana additions in `utils/walletUtils.ts`.
 *
 * Spec reference: `docs/solana-chain-support-spec.md` §7.3, §14.6.
 * Task reference: `docs/solana-chain-support-task/09_solana_wallet_creators_and_validators_istaken_true.md`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./utils/_test-resolver.mjs \
 *        utils/walletUtils.test.ts
 *
 * Node-only — no react / react-native / expo imports at the test bench.
 * `_test-resolver.mjs` aliases `@/*` and stubs the expo modules reached
 * through transitive imports.
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

// `@solana/kit` reaches for `globalThis.crypto` at import time. Node 22
// exposes `node:crypto`'s `webcrypto`, which supports Ed25519 natively
// (so no polyfill is required in this test bench).
if (!globalThis.crypto) {
  (globalThis as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import { fromBase64, toBase64 } from "@mysten/bcs";
import { bytesToBase58 } from "@/services/chains/solana/codec";
import {
  classifySuiRecipient,
  createSolanaWalletFromMnemonic,
  createSolanaWalletFromPrivateKey,
  createSuiWalletFromMnemonic,
  createSuiWalletFromPrivateKey,
  createWalletFromParams,
  isLegacySui20ByteAddress,
  isValidSolanaAddress,
  isValidSolanaPrivateKey,
  isValidSuiAddress,
  isValidSuiPrivateKey,
  parseSolanaPrivateKey,
  SUI_LEGACY_ADDRESS_UX_MESSAGE,
  walletAvatarInitials,
  walletTypeLabel,
} from "@/utils/walletUtils";

// Canonical Phantom-verified golden vector from
// `services/chains/solana/derivation.test.ts`.
const GOLDEN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GOLDEN_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

// System-Program address = 32 zero bytes, base58-encoded. A known-good
// 32-byte Solana address fixture.
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

// A 64-hex EVM-style key. Under the §14.6 cross-curve guard this must
// NEVER validate as a Solana private key. The hex characters that aren't
// also base58 (0, O, I, l) mean decoding this as base58 either throws
// or yields a byte length ≠ 32/64 — either outcome is a rejection.
const EVM_HEX_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("isValidSolanaAddress", () => {
  it("accepts a known 32-byte base58 Solana address (System Program)", () => {
    assert.equal(isValidSolanaAddress(SYSTEM_PROGRAM_ADDRESS), true);
  });

  it("accepts the golden-vector derived address", () => {
    assert.equal(isValidSolanaAddress(GOLDEN_ADDRESS), true);
  });

  it("rejects a random short string", () => {
    assert.equal(isValidSolanaAddress("abc"), false);
  });

  it("rejects an empty string", () => {
    assert.equal(isValidSolanaAddress(""), false);
  });

  it("rejects an EVM 0x-hex string (wrong length after base58 decode)", () => {
    assert.equal(
      isValidSolanaAddress("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97"),
      false,
    );
  });

  it("never throws on obviously malformed input", () => {
    // `I`, `O`, `0`, `l` are non-base58; bs58 throws — the validator must
    // swallow that and return false.
    assert.doesNotThrow(() => isValidSolanaAddress("Il0O"));
    assert.equal(isValidSolanaAddress("Il0O"), false);
  });
});

describe("isValidSolanaPrivateKey", () => {
  it("accepts a 32-byte Solana seed (base58)", () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 1) & 0xff;
    assert.equal(isValidSolanaPrivateKey(bytesToBase58(seed)), true);
  });

  it("accepts a Phantom 64-byte export (base58)", () => {
    const full = new Uint8Array(64);
    for (let i = 0; i < 64; i++) full[i] = (i * 13 + 3) & 0xff;
    assert.equal(isValidSolanaPrivateKey(bytesToBase58(full)), true);
  });

  it("rejects an EVM 64-char hex key (§14.6 cross-curve guard)", () => {
    assert.equal(isValidSolanaPrivateKey(EVM_HEX_KEY), false);
    // Also reject the unprefixed form.
    assert.equal(isValidSolanaPrivateKey(EVM_HEX_KEY.slice(2)), false);
  });

  it("rejects empty and obviously garbage input without throwing", () => {
    assert.equal(isValidSolanaPrivateKey(""), false);
    assert.doesNotThrow(() => isValidSolanaPrivateKey("not-a-key"));
  });
});

describe("parseSolanaPrivateKey (walletUtils non-throwing wrapper)", () => {
  it("returns the 32-byte seed for a 32-byte base58 input", () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 11 + 2) & 0xff;
    const parsed = parseSolanaPrivateKey(bytesToBase58(seed));
    assert.ok(parsed instanceof Uint8Array);
    assert.equal(parsed!.length, 32);
    for (let i = 0; i < 32; i++) assert.equal(parsed![i], seed[i]);
  });

  it("returns null on malformed input instead of throwing", () => {
    assert.equal(parseSolanaPrivateKey(""), null);
    assert.equal(parseSolanaPrivateKey("not-a-valid-base58"), null);
    assert.equal(parseSolanaPrivateKey(EVM_HEX_KEY), null);
  });
});

describe("createSolanaWalletFromMnemonic", () => {
  it("derives the Phantom-verified golden address", async () => {
    const wallet = await createSolanaWalletFromMnemonic(GOLDEN_MNEMONIC);
    assert.ok(wallet, "expected a TWallet, got null");
    assert.equal(wallet!.address, GOLDEN_ADDRESS);
    assert.equal(wallet!.namespace, "solana");
    assert.equal(wallet!.type, "SeedPhrase");
    assert.equal(wallet!.source, "Created");
    assert.equal(wallet!.solana?.pubkeyBase58, GOLDEN_ADDRESS);
    assert.equal(wallet!.solana?.derivationPath, "m/44'/501'/0'/0'");
    assert.equal(wallet!.seedPhrase, GOLDEN_MNEMONIC);
    // privateKey stored as base58 of the 32-byte seed (Phantom-compat).
    assert.equal(typeof wallet!.privateKey, "string");
  });

  it("returns null for an invalid mnemonic (word-count check)", async () => {
    const result = await createSolanaWalletFromMnemonic("too few words");
    assert.equal(result, null);
  });

  it("honors the optional wallet name", async () => {
    const wallet = await createSolanaWalletFromMnemonic(
      GOLDEN_MNEMONIC,
      "My SOL",
    );
    assert.equal(wallet?.name, "My SOL");
  });
});

describe("createSolanaWalletFromPrivateKey (round-trip)", () => {
  it("round-trips via bytesToBase58(seed) → re-import → same address", async () => {
    const first = await createSolanaWalletFromMnemonic(GOLDEN_MNEMONIC);
    assert.ok(first);
    // The mnemonic-created wallet stores the 32-byte seed as base58 on
    // `privateKey`. Re-importing via `createSolanaWalletFromPrivateKey`
    // must produce the identical address.
    const reimported = await createSolanaWalletFromPrivateKey(
      first!.privateKey!,
      "Reimported",
    );
    assert.ok(reimported);
    assert.equal(reimported!.address, first!.address);
    assert.equal(reimported!.namespace, "solana");
    assert.equal(reimported!.type, "PrivateKey");
    assert.equal(reimported!.source, "Imported");
    assert.equal(reimported!.solana?.pubkeyBase58, first!.address);
    // §7.3 — private-key imports don't carry a derivation path.
    assert.equal(reimported!.solana?.derivationPath, undefined);
    assert.equal(reimported!.name, "Reimported");
  });

  it("returns null when the base58 input is not a valid Solana key", async () => {
    assert.equal(await createSolanaWalletFromPrivateKey(""), null);
    assert.equal(await createSolanaWalletFromPrivateKey(EVM_HEX_KEY), null);
    assert.equal(
      await createSolanaWalletFromPrivateKey("not-a-valid-base58"),
      null,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// Sui suite. Spec reference: docs/sui-chain-support-spec.md §1.4, §3.2.
// Task reference:
//   docs/sui-chain-support-task/06_walletutils_sui_validators_and_creators.md.
// ───────────────────────────────────────────────────────────────────────

// Same canonical BIP-39 zero-mnemonic the Solana suite + Task 03
// derivation test use, so the wallet derived here can be cross-checked
// against the SDK-verified golden Sui address.
const SUI_GOLDEN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SUI_GOLDEN_ADDRESS =
  "0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1";

describe("isValidSuiAddress", () => {
  it("accepts the canonical golden 32-byte Sui address", () => {
    assert.equal(isValidSuiAddress(SUI_GOLDEN_ADDRESS), true);
  });

  it("rejects an empty string", () => {
    assert.equal(isValidSuiAddress(""), false);
  });

  it("rejects a legacy 20-byte hex address (`0x` + 40 hex chars)", () => {
    assert.equal(
      isValidSuiAddress("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97"),
      false,
    );
    assert.equal(
      isValidSuiAddress("0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97"),
      false,
    );
  });

  it("rejects mixed-case hex (canonical Sui addresses are lowercase)", () => {
    assert.equal(
      isValidSuiAddress(
        "0x5E93A736D04FBB25737AA40BEE40171EF79F65FAE833749E3C089FE7CC2161F1",
      ),
      false,
    );
    assert.equal(
      isValidSuiAddress(
        "0x5E93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1",
      ),
      false,
    );
  });

  it("rejects 64 hex chars without a `0x` prefix", () => {
    assert.equal(
      isValidSuiAddress(
        "5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1",
      ),
      false,
    );
  });

  it("rejects non-hex characters", () => {
    assert.equal(
      isValidSuiAddress(
        "0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161fz",
      ),
      false,
    );
  });
});

describe("isValidSuiPrivateKey", () => {
  it("accepts the canonical bech32 `suiprivkey1…` from Ed25519Keypair.getSecretKey", async () => {
    const wallet = await createSuiWalletFromMnemonic(SUI_GOLDEN_MNEMONIC);
    assert.ok(wallet);
    assert.ok(wallet!.privateKey?.startsWith("suiprivkey1"));
    assert.equal(isValidSuiPrivateKey(wallet!.privateKey!), true);
  });

  it("accepts a 32-byte hex seed (with `0x` prefix)", () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 3) & 0xff;
    let hex = "0x";
    for (let i = 0; i < 32; i++) hex += seed[i].toString(16).padStart(2, "0");
    assert.equal(isValidSuiPrivateKey(hex), true);
  });

  it("accepts a 32-byte hex seed (no prefix)", () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 11 + 5) & 0xff;
    let hex = "";
    for (let i = 0; i < 32; i++) hex += seed[i].toString(16).padStart(2, "0");
    assert.equal(isValidSuiPrivateKey(hex), true);
  });

  it("accepts a 32-byte base64 payload", () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 13 + 7) & 0xff;
    assert.equal(isValidSuiPrivateKey(toBase64(seed)), true);
    // Round-trip sanity — decoding the same string yields 32 bytes.
    assert.equal(fromBase64(toBase64(seed)).length, 32);
  });

  it("rejects an empty string", () => {
    assert.equal(isValidSuiPrivateKey(""), false);
  });

  it("rejects a 31-byte hex payload (too short)", () => {
    assert.equal(isValidSuiPrivateKey("ab".repeat(31)), false);
  });

  it("rejects a 33-byte hex payload (too long)", () => {
    assert.equal(isValidSuiPrivateKey("ab".repeat(33)), false);
  });

  it("rejects non-base64 garbage without throwing", () => {
    assert.doesNotThrow(() => isValidSuiPrivateKey("not-a-valid-key!!!"));
    assert.equal(isValidSuiPrivateKey("not-a-valid-key!!!"), false);
  });

  it("rejects a malformed bech32 `suiprivkey1…` string", () => {
    assert.equal(isValidSuiPrivateKey("suiprivkey1zzzzzzzz"), false);
  });
});

describe("createSuiWalletFromMnemonic", () => {
  it("derives the SDK-verified golden Sui address for the canonical mnemonic", async () => {
    const wallet = await createSuiWalletFromMnemonic(SUI_GOLDEN_MNEMONIC);
    assert.ok(wallet, "expected a TWallet, got null");
    assert.equal(wallet!.address, SUI_GOLDEN_ADDRESS);
    assert.equal(wallet!.namespace, "sui");
    assert.equal(wallet!.type, "SeedPhrase");
    assert.equal(wallet!.source, "Created");
    assert.equal(wallet!.address, wallet!.sui?.suiAddress);
    assert.equal(wallet!.sui?.scheme, "ed25519");
    assert.equal(wallet!.sui?.derivationPath, "m/44'/784'/0'/0'/0'");
    assert.equal(wallet!.seedPhrase, SUI_GOLDEN_MNEMONIC);
    assert.ok(typeof wallet!.privateKey === "string");
    assert.ok(wallet!.privateKey!.startsWith("suiprivkey1"));
    // pubkeyHex is 32 bytes -> 64 lowercase hex chars (no 0x prefix).
    assert.match(wallet!.sui!.pubkeyHex, /^[0-9a-f]{64}$/);
  });

  it("returns null for an invalid mnemonic (word-count check)", async () => {
    const result = await createSuiWalletFromMnemonic("too few words");
    assert.equal(result, null);
  });

  it("honors the optional wallet name", async () => {
    const wallet = await createSuiWalletFromMnemonic(
      SUI_GOLDEN_MNEMONIC,
      "My SUI",
    );
    assert.equal(wallet?.name, "My SUI");
  });
});

describe("createSuiWalletFromPrivateKey (round-trip)", () => {
  it("round-trips bech32 -> reimport -> same address", async () => {
    const first = await createSuiWalletFromMnemonic(SUI_GOLDEN_MNEMONIC);
    assert.ok(first);
    const reimported = await createSuiWalletFromPrivateKey(
      first!.privateKey!,
      "Reimported",
    );
    assert.ok(reimported);
    assert.equal(reimported!.address, first!.address);
    assert.equal(reimported!.namespace, "sui");
    assert.equal(reimported!.type, "PrivateKey");
    assert.equal(reimported!.source, "Imported");
    assert.equal(reimported!.address, reimported!.sui?.suiAddress);
    assert.equal(reimported!.sui?.scheme, "ed25519");
    // §7.3-style — private-key imports don't carry a derivation path.
    assert.equal(reimported!.sui?.derivationPath, undefined);
    assert.equal(reimported!.seedPhrase, undefined);
    assert.ok(reimported!.privateKey!.startsWith("suiprivkey1"));
    assert.equal(reimported!.name, "Reimported");
  });

  it("returns null on malformed input instead of throwing", async () => {
    assert.equal(await createSuiWalletFromPrivateKey(""), null);
    assert.equal(await createSuiWalletFromPrivateKey("not-a-valid-key"), null);
  });
});

describe("createWalletFromParams (Sui sources)", () => {
  it("dispatches `SuiSeedPhrase` to createSuiWalletFromMnemonic", async () => {
    const wallet = await createWalletFromParams({
      source: "SuiSeedPhrase",
      seedPhrase: SUI_GOLDEN_MNEMONIC,
    });
    assert.ok(wallet);
    assert.equal(wallet!.namespace, "sui");
    assert.equal(wallet!.type, "SeedPhrase");
    assert.equal(wallet!.address, SUI_GOLDEN_ADDRESS);
  });

  it("dispatches `SuiPrivateKey` to createSuiWalletFromPrivateKey", async () => {
    const seed = await createSuiWalletFromMnemonic(SUI_GOLDEN_MNEMONIC);
    assert.ok(seed);
    const wallet = await createWalletFromParams({
      source: "SuiPrivateKey",
      privateKey: seed!.privateKey!,
    });
    assert.ok(wallet);
    assert.equal(wallet!.namespace, "sui");
    assert.equal(wallet!.type, "PrivateKey");
    assert.equal(wallet!.address, SUI_GOLDEN_ADDRESS);
  });
});

// Spec reference: `docs/sui-chain-support-spec.md` §3.5.
// Pre-mainnet Sui addresses were 20 bytes. The send sheet rejects them
// with a migration-pointer message instead of a generic "invalid
// address" error so users know to ask the recipient for the new form.
describe("isLegacySui20ByteAddress", () => {
  it("accepts canonical 20-byte hex (`0x` + 40 lowercase hex)", () => {
    assert.equal(
      isLegacySui20ByteAddress("0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97"),
      true,
    );
  });

  it("rejects the canonical 32-byte Sui address", () => {
    assert.equal(isLegacySui20ByteAddress(SUI_GOLDEN_ADDRESS), false);
  });

  it("rejects mixed-case 20-byte hex (lowercase only, matches isValidSuiAddress strictness)", () => {
    assert.equal(
      isLegacySui20ByteAddress("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97"),
      false,
    );
  });

  it("rejects 40 hex chars without a `0x` prefix", () => {
    assert.equal(
      isLegacySui20ByteAddress("4838b106fce9647bdf1e7877bf73ce8b0bad5f97"),
      false,
    );
  });

  it("rejects non-hex characters in the 40-char body", () => {
    assert.equal(
      isLegacySui20ByteAddress("0x4838b106fce9647bdf1e7877bf73ce8b0bad5fzz"),
      false,
    );
  });

  it("rejects an empty string and never throws", () => {
    assert.equal(isLegacySui20ByteAddress(""), false);
    assert.equal(isLegacySui20ByteAddress("not an address"), false);
  });
});

describe("classifySuiRecipient", () => {
  it("returns ok for the canonical 32-byte address", () => {
    const verdict = classifySuiRecipient(SUI_GOLDEN_ADDRESS);
    assert.equal(verdict.ok, true);
  });

  it("returns kind=legacy20 with a typed error for 20-byte hex", () => {
    const verdict = classifySuiRecipient(
      "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97",
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.kind, "legacy20");
      if (verdict.kind === "legacy20") {
        assert.equal(verdict.error.name, "InvalidSuiAddressLegacyError");
        assert.equal(
          verdict.error.address,
          "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97",
        );
        assert.equal(verdict.message, SUI_LEGACY_ADDRESS_UX_MESSAGE);
      }
    }
  });

  it("returns kind=invalid for unrelated junk", () => {
    const verdict = classifySuiRecipient("definitely not a sui address");
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.kind, "invalid");
    }
  });

  it("returns kind=invalid for an EVM-shaped 20-byte address with mixed case", () => {
    // Same byte-shape as the legacy form but with checksum casing — we
    // still surface generic invalid (the lowercase-only predicate
    // matches isValidSuiAddress's strictness).
    const verdict = classifySuiRecipient(
      "0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97",
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.kind, "invalid");
    }
  });

  it("returns kind=invalid for an empty string", () => {
    const verdict = classifySuiRecipient("");
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.kind, "invalid");
    }
  });
});

describe("walletAvatarInitials", () => {
  it("prefers the social account name over the local chain-suffixed label", () => {
    assert.equal(
      walletAvatarInitials({
        name: "Satria · ETH",
        socialAccount: { provider: "google", email: "", name: "Satria Ali" },
      }),
      "SA",
    );
  });

  it("handles a first-name-only social account (no last name)", () => {
    assert.equal(
      walletAvatarInitials({
        name: "Satria · SOL",
        socialAccount: { provider: "google", email: "", name: "Satria" },
      }),
      "SA",
    );
  });

  it("strips the chain suffix from the local label when no social name", () => {
    // Non-social wallet, or a social wallet where Google returned no name.
    assert.equal(walletAvatarInitials({ name: "Satria · ETH" }), "SA");
    assert.equal(walletAvatarInitials({ name: "Main Wallet · ETH" }), "MW");
  });

  it("does not fold a chain tag into the initials", () => {
    // Regression: the old logic produced "S·" from "Satria · ETH".
    assert.notEqual(walletAvatarInitials({ name: "Satria · ETH" }), "S·");
  });

  it("uses two letters for a single-word local name", () => {
    assert.equal(walletAvatarInitials({ name: "Trading" }), "TR");
  });

  it("falls back to 'W' when nothing is usable", () => {
    assert.equal(walletAvatarInitials({ name: "" }), "W");
  });
});

describe("walletTypeLabel", () => {
  it("labels a passkey-login seed wallet by its login method", () => {
    const passkey = { credentialId: "Y3JlZC1pZA", rpId: "takumipay.xyz" };
    assert.equal(walletTypeLabel({ type: "SeedPhrase", passkey }), "Passkey");
  });

  it("labels a Google wallet by provider and a plain one by key type", () => {
    const socialAccount = { provider: "google", email: "", name: "" };
    assert.equal(
      walletTypeLabel({ type: "SeedPhrase", socialAccount }),
      "Google",
    );
    assert.equal(walletTypeLabel({ type: "SeedPhrase" }), "SeedPhrase");
  });
});
