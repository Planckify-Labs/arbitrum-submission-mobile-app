/**
 * Mera passkey → wallet derivation (docs/monad-metropolis-2026-spec.md §3.2).
 *
 * Node-testable: no React Native, no WebAuthn. The passkey ceremony
 * lives in `./passkeyWallet.ts`; this file only turns the 32-byte PRF
 * output Mera hands back into `TWallet` rows.
 *
 * Derivation follows Mera's own documented recipe (PRF bytes → BIP-39
 * mnemonic) and then hands the mnemonic to the SAME multi-chain
 * pipeline a seed-phrase wallet uses (`restoreWalletsFromMnemonic`):
 *   - every chain comes from its usual path (EVM `m/44'/60'/0'/0/0`,
 *     Solana / Sui / Stellar likewise), so a passkey account gets every
 *     chain a Google or "Create New Wallet" account
 *     gets, and is recoverable by any BIP-39 wallet if ever exported.
 *
 * The rows are tagged the way Google's are (`tagWalletsAsGoogle`):
 * provenance only, on `passkey`. `type` stays `"SeedPhrase"`, so the
 * signer, the account grouping, the missing-namespace backfill, the
 * seed reveal and the Drive backup all treat a passkey account exactly
 * like any other seed account. Nothing downstream knows about passkeys.
 *
 * Determinism: same passkey + same rpId + Mera's fixed PRF salt ⇒ same
 * PRF output ⇒ same addresses on every device, which is what lets the
 * passkey stand in for writing the phrase down.
 */

import { entropyToMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import type { TPasskeyFields, TWallet } from "@/constants/types/walletTypes";
import { restoreWalletsFromMnemonic } from "@/services/walletKit/bootstrap";

export const PASSKEY_RP_ID = "takumipay.xyz";
export const PASSKEY_RP_NAME = "TakumiPay";
export const DEFAULT_PASSKEY_WALLET_NAME = "Passkey Wallet";

/**
 * What a passkey ceremony hands back: the credential and the mnemonic
 * its PRF output stands for. Deriving the wallet set from it is a
 * separate step, so the host can put its progress popup up first (same
 * as "Create New Wallet").
 */
export type TPasskeyCeremony = {
  mnemonic: string;
  /** Non-secret credential metadata to persist on every row. */
  passkey: TPasskeyFields;
};

export type DerivePasskeyWalletsParams = TPasskeyCeremony & {
  /** Name prefix; rows read "<name> · ETH", "<name> · SOL", … */
  name?: string;
};

/**
 * The BIP-39 mnemonic a PRF output stands for. Throws on an output that
 * is not exactly 32 bytes (Mera guarantees 32, so a mismatch means a
 * caller bypassed it).
 */
export function passkeyMnemonic(prfOutput: Uint8Array): string {
  if (prfOutput.length !== 32) {
    throw new Error("passkeyMnemonic: PRF output must be 32 bytes");
  }
  return entropyToMnemonic(prfOutput, englishWordlist);
}

/**
 * Tags a freshly derived wallet set as belonging to a passkey login.
 * Same shape as `tagWalletsAsGoogle`: metadata only, `type` untouched.
 */
export function tagWalletsAsPasskey(
  wallets: TWallet[],
  passkey: TPasskeyFields,
): TWallet[] {
  return wallets.map((w) => ({ ...w, passkey }));
}

/**
 * Builds the passkey account's rows, one per chain the app surfaces,
 * EVM first. Throws if no chain could be derived.
 */
export async function derivePasskeyWallets({
  mnemonic,
  passkey,
  name,
}: DerivePasskeyWalletsParams): Promise<TWallet[]> {
  const rows = await restoreWalletsFromMnemonic(
    mnemonic,
    name || DEFAULT_PASSKEY_WALLET_NAME,
  );
  if (rows.length === 0) {
    throw new Error("derivePasskeyWallets: no chain could be derived");
  }
  return tagWalletsAsPasskey(rows, passkey);
}
