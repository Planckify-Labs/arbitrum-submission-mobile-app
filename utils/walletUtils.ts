import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
} from "@solana/kit";
import { Keypair as StellarKeypair } from "@stellar/stellar-base";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type {
  TWallet,
  TWalletCreationParams,
} from "@/constants/types/walletTypes";
import {
  base58ToBytes,
  bytesToBase58,
  parseSolanaPrivateKey as parseSolanaPrivateKeyCodec,
} from "@/services/chains/solana/codec";
import {
  DEFAULT_SOLANA_PATH,
  mnemonicToSolanaPrivateKey,
} from "@/services/chains/solana/derivation";
import {
  DEFAULT_STELLAR_PATH,
  mnemonicToStellarPrivateKey,
} from "@/services/chains/stellar/derivation";
import {
  decodeStellarSecretSeed,
  isValidStellarAddress as isValidStellarAddressStrkey,
  isValidStellarSecretSeed,
} from "@/services/chains/stellar/strkey";
import {
  decodeSuiPrivateKey,
  encodeSuiPrivateKey,
} from "@/services/chains/sui/codec";
import {
  DEFAULT_SUI_PATH,
  mnemonicToSuiKeypair,
} from "@/services/chains/sui/derivation";
import { InvalidSuiAddressLegacyError } from "@/services/chains/sui/errorCodes";

/**
 * Chip label for a wallet's provenance. A wallet tied to a login method
 * (Google via `socialAccount`, a Mera passkey via `passkey`) shows that method;
 * every other wallet shows its key type ("SeedPhrase" / "PrivateKey"). Keyed
 * off the provenance fields rather than `type` so these wallets keep
 * `type: "SeedPhrase"` and their seed-reveal UI.
 */
export function walletTypeLabel(
  wallet: Pick<TWallet, "type" | "socialAccount" | "passkey">,
): string {
  const provider = wallet.socialAccount?.provider;
  if (provider) return provider.charAt(0).toUpperCase() + provider.slice(1);
  if (wallet.passkey) return "Passkey";
  return wallet.type;
}

/**
 * Initials for the wallet avatar chip. Social-login wallets prefer the
 * provider account name (e.g. the Google display name) so the avatar
 * reflects the person, not the wallet's local `"Satria · ETH"` label —
 * which would otherwise produce a nonsense `"S·"`.
 *
 * Handles a first-name-only account ("Satria" → "SA") as well as a full
 * "First Last" name ("Satria Ali" → "SA"). Falls back to the wallet's
 * local name for non-social wallets, and to "W" when nothing is usable.
 */
export function walletAvatarInitials(
  wallet: Pick<TWallet, "name" | "socialAccount">,
): string {
  const raw = wallet.socialAccount?.name?.trim() || wallet.name?.trim() || "";
  // The local label carries an auto-appended chain suffix ("Satria · ETH");
  // strip a trailing "· <token>" so the tag isn't folded into the initials.
  // A social account name has no separator, so this is a no-op there.
  const source = raw.replace(/\s*[·•|]\s*\S+\s*$/u, "").trim() || raw;
  if (!source) return "W";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return words[0].slice(0, 2).toUpperCase();
}

export function isValidPrivateKey(privateKey: string): boolean {
  const privateKeyRegex = /^(0x)?[0-9a-fA-F]{64}$/;
  return privateKeyRegex.test(privateKey);
}

export function isValidMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().split(/\s+/);
  return words.length === 12 || words.length === 24;
}

export function formatPrivateKey(privateKey: string): string {
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

/**
 * Validate a Solana base58 address (32 bytes decoded). Never throws — any
 * malformed input returns `false` so callers can render a clean error
 * state without a try/catch.
 */
export function isValidSolanaAddress(s: string): boolean {
  if (!s) return false;
  try {
    const bytes = base58ToBytes(s);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Validate a Solana private key. Accepts both the 32-byte ed25519 seed
 * form and Phantom's 64-byte export. Never throws.
 *
 * Cross-curve guard (§14.6): a 64-hex EVM key like
 * `0xabcd…` decodes — if at all — to bytes whose length is neither 32
 * nor 64, so it is correctly rejected here before it reaches
 * `createSolanaWalletFromPrivateKey`.
 */
export function isValidSolanaPrivateKey(s: string): boolean {
  if (!s) return false;
  try {
    const bytes = base58ToBytes(s);
    return bytes.length === 32 || bytes.length === 64;
  } catch {
    return false;
  }
}

/**
 * Non-throwing variant of `parseSolanaPrivateKey` from
 * `services/chains/solana/codec.ts`. Returns the 32-byte seed on
 * success or `null` when the input is not a valid 32- or 64-byte
 * base58 Solana secret.
 *
 * Keeps the throwing codec helper as the canonical implementation —
 * this wrapper only converts the failure mode to suit the UI surface.
 */
export function parseSolanaPrivateKey(s: string): Uint8Array | null {
  if (!s) return null;
  try {
    return parseSolanaPrivateKeyCodec(s);
  } catch {
    return null;
  }
}

export function createWalletFromPrivateKey(
  privateKey: string,
  name?: string,
): TWallet {
  const formattedKey = formatPrivateKey(privateKey);
  const account = privateKeyToAccount(formattedKey as `0x${string}`);

  return {
    account,
    address: account.address,
    privateKey: formattedKey,
    name: name || "Imported Wallet",
    balance: "0",
    source: "Imported",
    type: "PrivateKey",
    namespace: "eip155",
  };
}

export function createWalletFromMnemonic(
  seedPhrase: string,
  name?: string,
): TWallet {
  const account = mnemonicToAccount(seedPhrase);

  return {
    account,
    address: account.address,
    seedPhrase,
    name: name || "Seed Phrase Wallet",
    balance: "0",
    source: "Created",
    type: "SeedPhrase",
    namespace: "eip155",
  };
}

/**
 * Create a Solana `TWallet` from a base58-encoded private key.
 *
 * Spec reference: `docs/solana-chain-support-spec.md` §7.3.
 *
 * Accepts either a 32-byte seed or a 64-byte Phantom export (seed +
 * pubkey). Returns `null` on malformed input so callers can render a
 * clean error — the validator surface (`isValidSolanaPrivateKey`) is
 * the *loud* path; this creator is the *safe* path.
 *
 * Security invariant (TWV-2026-070): the WebCrypto `CryptoKeyPair` is
 * minted with `extractable: false`. The raw 32-byte seed is held only
 * on the stack of this function; we store the original base58 string
 * on `TWallet.privateKey` so the signer dwell site (Task 10) can
 * reconstruct it later.
 */
export async function createSolanaWalletFromPrivateKey(
  pkBase58: string,
  name?: string,
): Promise<TWallet | null> {
  const seed = parseSolanaPrivateKey(pkBase58);
  if (!seed) return null;
  try {
    const keyPair = await createKeyPairFromPrivateKeyBytes(seed, false);
    const addr = await getAddressFromPublicKey(keyPair.publicKey);
    const address = addr.toString();
    return {
      account: { address },
      address,
      privateKey: pkBase58,
      name: name || "Solana Wallet",
      balance: "0",
      source: "Imported",
      type: "PrivateKey",
      namespace: "solana",
      solana: { pubkeyBase58: address, derivationPath: undefined },
    };
  } catch {
    return null;
  }
}

/**
 * Create a Solana `TWallet` from a BIP-39 mnemonic via SLIP-0010
 * ed25519 derivation at the Phantom-compatible default path.
 *
 * Spec reference: `docs/solana-chain-support-spec.md` §7.3, §7.2.
 *
 * Returns `null` if the mnemonic fails `isValidMnemonic` (12- or
 * 24-word BIP-39 check) or if kit rejects the derived bytes. We store
 * the seed in Phantom's 32-byte base58 form on `TWallet.privateKey`
 * so the signer can reconstruct it without re-deriving from the
 * mnemonic.
 *
 * Security invariant (TWV-2026-070): `extractable: false` on the
 * CryptoKeyPair — the private half must not leave the kit surface.
 */
export async function createSolanaWalletFromMnemonic(
  mnemonic: string,
  name?: string,
): Promise<TWallet | null> {
  if (!isValidMnemonic(mnemonic)) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createSolanaWalletFromMnemonic] isValidMnemonic rejected input (word count / wordlist)",
      );
    }
    return null;
  }
  try {
    const seed = mnemonicToSolanaPrivateKey(mnemonic);
    const keyPair = await createKeyPairFromPrivateKeyBytes(seed, false);
    const addr = await getAddressFromPublicKey(keyPair.publicKey);
    const address = addr.toString();
    return {
      account: { address },
      address,
      privateKey: bytesToBase58(seed),
      seedPhrase: mnemonic,
      name: name || "Solana Wallet",
      balance: "0",
      source: "Created",
      type: "SeedPhrase",
      namespace: "solana",
      solana: {
        pubkeyBase58: address,
        derivationPath: DEFAULT_SOLANA_PATH,
      },
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createSolanaWalletFromMnemonic] derivation threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Validate a canonical Sui address.
 *
 * Spec reference: `docs/sui-chain-support-spec.md` §1.4.
 *
 * Strict canonical form: `0x` + 64 lowercase hex chars (66 chars total).
 * Rejects:
 *   - legacy 20-byte hex addresses (`0x` + 40 hex chars),
 *   - mixed-case hex (canonical Sui addresses are lowercase),
 *   - non-hex characters,
 *   - missing `0x` prefix,
 *   - empty string.
 *
 * Pure regex check; never throws. Legacy 20-byte rejection at the send
 * sheet (Task 14) relies on this validator returning `false` for the
 * shorter form.
 */
export function isValidSuiAddress(address: string): boolean {
  if (!address) return false;
  return /^0x[0-9a-f]{64}$/.test(address);
}

/**
 * Returns true iff `input` is `0x` + 40 lowercase hex chars (20 bytes) —
 * the pre-mainnet Sui address shape. Distinct from the canonical 32-byte
 * form. Used by the send sheet to surface a helpful migration message
 * instead of a generic "invalid address" error.
 *
 * Spec reference: `docs/sui-chain-support-spec.md` §3.5.
 *
 * Lowercase only, matching `isValidSuiAddress` strictness. Pure regex,
 * never throws.
 */
export function isLegacySui20ByteAddress(input: string): boolean {
  if (!input) return false;
  return /^0x[0-9a-f]{40}$/.test(input);
}

/**
 * The user-facing message surfaced when a recipient input matches the
 * pre-mainnet 20-byte Sui address shape. Kept beside the predicate so
 * UI surfaces import one symbol and don't have to re-author the copy.
 */
export const SUI_LEGACY_ADDRESS_UX_MESSAGE =
  "This looks like a pre-mainnet (20-byte) Sui address. The current Sui network uses 32-byte addresses; ask the recipient to send you their up-to-date address.";

/**
 * Classify a Sui recipient string into one of three outcomes for the
 * send sheet:
 *  1. Canonical 32-byte address → `{ ok: true }`.
 *  2. Pre-mainnet 20-byte address → `{ ok: false, kind: "legacy20", error }`
 *     where `error` is a constructed `InvalidSuiAddressLegacyError`
 *     ready for UI surfacing or telemetry.
 *  3. Anything else → `{ ok: false, kind: "invalid" }`.
 *
 * Spec reference: `docs/sui-chain-support-spec.md` §3.5. Detection-only —
 * never re-derives or maps; the 20-byte → 32-byte mapping is not 1:1
 * and auto-conversion would lose funds.
 *
 * Pure function; never throws.
 */
export type TSuiRecipientClassification =
  | { ok: true }
  | {
      ok: false;
      kind: "legacy20";
      error: InvalidSuiAddressLegacyError;
      message: string;
    }
  | { ok: false; kind: "invalid" };

export function classifySuiRecipient(
  input: string,
): TSuiRecipientClassification {
  if (isValidSuiAddress(input)) return { ok: true };
  if (isLegacySui20ByteAddress(input)) {
    return {
      ok: false,
      kind: "legacy20",
      error: new InvalidSuiAddressLegacyError(input),
      message: SUI_LEGACY_ADDRESS_UX_MESSAGE,
    };
  }
  return { ok: false, kind: "invalid" };
}

/**
 * Predicate-form of {@link decodeSuiPrivateKey}. Returns `true` for any
 * input the codec accepts (canonical bech32 `suiprivkey1…`, raw 32-byte
 * hex with or without `0x`, base64 32-byte payload). Catches the codec's
 * `InvalidSuiPrivateKeyEncodingError` and returns `false`.
 *
 * Mirrors `isValidSolanaPrivateKey` — the loud / safe split: this is the
 * loud surface for UI validation, and {@link createSuiWalletFromPrivateKey}
 * is the safe surface that returns `null` on bad input.
 */
export function isValidSuiPrivateKey(input: string): boolean {
  if (!input) return false;
  try {
    decodeSuiPrivateKey(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a Sui `TWallet` from a BIP-39 mnemonic via SLIP-0010 ed25519
 * derivation at the default 5-level fully-hardened path
 * (`m/44'/784'/0'/0'/0'`).
 *
 * Spec reference: `docs/sui-chain-support-spec.md` §1.4, §3.2, §6.
 *
 * Returns `null` if `isValidMnemonic` rejects the input or if the SDK
 * throws during derivation. We store the secret as canonical bech32
 * (`suiprivkey1…`) on `TWallet.privateKey` so the dwell site
 * (`getSuiSignerForWallet`) can re-decode without re-running BIP-39.
 *
 * Security: never logs mnemonic or key bytes. Failures emit a bounded
 * `__DEV__` breadcrumb only.
 */
export async function createSuiWalletFromMnemonic(
  mnemonic: string,
  name?: string,
): Promise<TWallet | null> {
  if (!isValidMnemonic(mnemonic)) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createSuiWalletFromMnemonic] isValidMnemonic rejected input (word count / wordlist)",
      );
    }
    return null;
  }
  try {
    const kp = mnemonicToSuiKeypair(mnemonic);
    const address = kp.toSuiAddress();
    const bech32 = kp.getSecretKey();
    const pubkeyHex = bytesToHex(kp.getPublicKey().toRawBytes());
    return {
      account: { address },
      address,
      privateKey: bech32,
      seedPhrase: mnemonic,
      name: name || "Sui Wallet",
      balance: "0",
      source: "Created",
      type: "SeedPhrase",
      namespace: "sui",
      sui: {
        suiAddress: address,
        pubkeyHex,
        derivationPath: DEFAULT_SUI_PATH,
        scheme: "ed25519",
      },
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createSuiWalletFromMnemonic] derivation threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Create a Sui `TWallet` from an exported private key.
 *
 * Spec reference: `docs/sui-chain-support-spec.md` §1.4.
 *
 * Accepts any encoding {@link decodeSuiPrivateKey} understands — bech32
 * `suiprivkey1…`, raw 32-byte hex (with or without `0x`), or base64 —
 * and re-encodes to canonical bech32 before storing on
 * `TWallet.privateKey`. This way, regardless of the import form, every
 * downstream consumer sees the same canonical secret.
 *
 * Returns `null` on any decoding / derivation failure so the UI can
 * render a clean error state without a try/catch.
 */
export async function createSuiWalletFromPrivateKey(
  privateKey: string,
  name?: string,
): Promise<TWallet | null> {
  try {
    const seed = decodeSuiPrivateKey(privateKey);
    const kp = Ed25519Keypair.fromSecretKey(seed);
    const address = kp.toSuiAddress();
    // Canonicalize the secret form. Prefer the keypair's own
    // `getSecretKey()` (matches the SDK encoder) but fall back to the
    // codec helper if the SDK shape ever changes.
    const bech32 =
      typeof kp.getSecretKey === "function"
        ? kp.getSecretKey()
        : encodeSuiPrivateKey(seed);
    const pubkeyHex = bytesToHex(kp.getPublicKey().toRawBytes());
    return {
      account: { address },
      address,
      privateKey: bech32,
      name: name || "Sui Wallet",
      balance: "0",
      source: "Imported",
      type: "PrivateKey",
      namespace: "sui",
      sui: {
        suiAddress: address,
        pubkeyHex,
        derivationPath: undefined,
        scheme: "ed25519",
      },
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createSuiWalletFromPrivateKey] decode/derivation threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Validate a canonical Stellar address (StrKey `G…`, ed25519 public
 * key, checksum-verified). Never throws.
 *
 * Spec reference: `docs/stellar-chain-support-spec.md` §1.2, §9.
 */
export function isValidStellarAddress(address: string): boolean {
  return isValidStellarAddressStrkey(address);
}

/**
 * Validate a Stellar secret key export (StrKey `S…` secret seed,
 * checksum-verified). Never throws.
 */
export function isValidStellarSecretKey(secretKey: string): boolean {
  return isValidStellarSecretSeed(secretKey);
}

/**
 * Create a Stellar `TWallet` from a BIP-39 mnemonic via SLIP-0010
 * ed25519 derivation at the default SEP-0005 "primary key" path
 * (`m/44'/148'/0'`).
 *
 * Spec reference: `docs/stellar-chain-support-spec.md` §1.2, §3.2, §6.
 *
 * Returns `null` if `isValidMnemonic` rejects the input or if
 * derivation throws. Stores the secret as canonical StrKey `S…` on
 * `TWallet.privateKey` so the dwell site (`getStellarSignerForWallet`)
 * can re-decode without re-running BIP-39.
 *
 * Security: never logs mnemonic or key bytes. Failures emit a bounded
 * `__DEV__` breadcrumb only.
 */
export async function createStellarWalletFromMnemonic(
  mnemonic: string,
  name?: string,
): Promise<TWallet | null> {
  if (!isValidMnemonic(mnemonic)) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createStellarWalletFromMnemonic] isValidMnemonic rejected input (word count / wordlist)",
      );
    }
    return null;
  }
  try {
    const seed = mnemonicToStellarPrivateKey(mnemonic);
    const kp = StellarKeypair.fromRawEd25519Seed(Buffer.from(seed));
    const address = kp.publicKey();
    const secret = kp.secret();
    return {
      account: { address },
      address,
      privateKey: secret,
      seedPhrase: mnemonic,
      name: name || "Stellar Wallet",
      balance: "0",
      source: "Created",
      type: "SeedPhrase",
      namespace: "stellar",
      stellar: {
        stellarAddress: address,
        derivationPath: DEFAULT_STELLAR_PATH,
        scheme: "ed25519",
      },
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createStellarWalletFromMnemonic] derivation threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Create a Stellar `TWallet` from an exported StrKey `S…` secret seed.
 *
 * Spec reference: `docs/stellar-chain-support-spec.md` §1.2.
 *
 * Returns `null` on any decoding failure so the UI can render a clean
 * error state without a try/catch.
 */
export async function createStellarWalletFromPrivateKey(
  privateKey: string,
  name?: string,
): Promise<TWallet | null> {
  try {
    const seed = decodeStellarSecretSeed(privateKey);
    const kp = StellarKeypair.fromRawEd25519Seed(seed);
    const address = kp.publicKey();
    return {
      account: { address },
      address,
      privateKey: kp.secret(),
      name: name || "Stellar Wallet",
      balance: "0",
      source: "Imported",
      type: "PrivateKey",
      namespace: "stellar",
      stellar: {
        stellarAddress: address,
        derivationPath: undefined,
        scheme: "ed25519",
      },
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[createStellarWalletFromPrivateKey] decode/derivation threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

export async function createWalletFromParams(
  params: TWalletCreationParams,
): Promise<TWallet | null> {
  if (params.source === "PrivateKey" && params.privateKey) {
    return createWalletFromPrivateKey(params.privateKey, params.name);
  }

  if (params.source === "SeedPhrase" && params.seedPhrase) {
    return createWalletFromMnemonic(params.seedPhrase, params.name);
  }

  if (params.source === "SolanaPrivateKey" && params.privateKey) {
    return createSolanaWalletFromPrivateKey(params.privateKey, params.name);
  }

  if (params.source === "SolanaSeedPhrase" && params.seedPhrase) {
    return createSolanaWalletFromMnemonic(params.seedPhrase, params.name);
  }

  if (params.source === "SuiPrivateKey" && params.privateKey) {
    return createSuiWalletFromPrivateKey(params.privateKey, params.name);
  }

  if (params.source === "SuiSeedPhrase" && params.seedPhrase) {
    return createSuiWalletFromMnemonic(params.seedPhrase, params.name);
  }

  if (params.source === "StellarPrivateKey" && params.privateKey) {
    return createStellarWalletFromPrivateKey(params.privateKey, params.name);
  }

  if (params.source === "StellarSeedPhrase" && params.seedPhrase) {
    return createStellarWalletFromMnemonic(params.seedPhrase, params.name);
  }

  if (params.source === "social" && params.account) {
    return {
      account: { address: params.account.address },
      address: params.account.address,
      name: params.name || "Social Wallet",
      balance: "0",
      source: "Social",
      type: "Social",
      namespace: "eip155",
      socialAccount: {
        provider: params.provider || "Unknown",
        email: params.socialAccount?.email || "",
        name: params.socialAccount?.name || "",
      },
    };
  }

  return null;
}

/**
 * Hex-encode a `Uint8Array` (lowercase, no `0x` prefix). Used to render
 * the raw 32-byte Sui ed25519 public key onto `TWallet.sui.pubkeyHex`.
 * Stays inline here to avoid pulling in `@noble/hashes/utils` just for
 * one utility.
 */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// Common address truncation presets
export const ADDRESS_TRUNCATE_PRESETS = {
  short: { start: 4, end: 4 }, // 0x12...5678
  medium: { start: 6, end: 4 }, // 0x1234...5678
  long: { start: 10, end: 8 }, // 0x12345678...12345678
} as const;

type TAddressTruncatePreset = keyof typeof ADDRESS_TRUNCATE_PRESETS;

type TTruncateAddressParams = {
  address: string;
  preset?: TAddressTruncatePreset;
  startLength?: number;
  endLength?: number;
};

/**
 * Truncates an address with preset or custom lengths
 *
 * @example
 * truncateAddress({ address: "0x1234567890abcdef" }) // "0x12...cdef"
 * truncateAddress({ address: "0x1234567890abcdef", preset: "medium" }) // "0x1234...cdef"
 * truncateAddress({ address: "0x1234567890abcdef", startLength: 8, endLength: 6 }) // "0x123456...abcdef"
 */
export function truncateAddress({
  address,
  preset = "short",
  startLength,
  endLength,
}: TTruncateAddressParams): string {
  if (!address) return "";

  const start = startLength ?? ADDRESS_TRUNCATE_PRESETS[preset].start;
  const end = endLength ?? ADDRESS_TRUNCATE_PRESETS[preset].end;

  if (address.length <= start + end) return address;

  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

/**
 * Build a block-explorer transaction URL. Handles explorers that store
 * query params in the base URL (e.g. Solana's
 * `https://explorer.solana.com?cluster=devnet`) by inserting the
 * `/tx/{hash}` path before the query string.
 */
export function buildExplorerTxUrl(
  blockExplorer: string,
  txHash: string,
): string {
  try {
    const url = new URL(blockExplorer);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/tx/${txHash}`;
    return url.toString();
  } catch {
    return `${blockExplorer}/tx/${txHash}`;
  }
}
