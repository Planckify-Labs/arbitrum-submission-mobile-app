/**
 * Unit tests for `SolanaWalletKit`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/walletKit/solana/SolanaWalletKit.test.ts
 *
 * Style matches `services/walletKit/evm/EvmWalletKit.test.ts` — Node
 * test runner, no react / react-native / expo imports at the test
 * bench.
 *
 * We reuse the EVM resolver hook because the kit transitively imports
 * `services/walletService.ts` (for `getSolanaSignerForWallet` +
 * `generateWalletMnemonic`), which in turn imports the Expo /
 * MMKV-backed secure-store modules. The resolver stubs both so the
 * tests run under plain Node. Network-bound methods
 * (`getNativeBalance`, `sendNativeTransfer`) are only asserted for
 * their namespace guards here — the happy path is covered by
 * `services/chains/solana/transferService.test.ts` against a mocked
 * RPC.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mainnet } from "viem/chains";

import type { TBlockchain } from "../../../api/types/blockchain.ts";
import type { ChainConfig } from "../../../constants/configs/chainConfig.ts";
import { createSolanaWalletKit } from "./SolanaWalletKit.ts";

const solanaDevnetChain: ChainConfig = {
  namespace: "solana",
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
};

const ethereumChain: ChainConfig = {
  namespace: "eip155",
  chain: mainnet,
};

// Phantom-verified golden vector — must match
// `services/chains/solana/derivation.test.ts`.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const EXPECTED_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

const VALID_EVM_ADDRESS = "0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97";

// 5,000 signature fee + 890,880 rent-exempt buffer — must mirror the
// constant in `SolanaWalletKit.ts`. Duplicated here so the test
// remains readable without importing a non-exported constant.
const FEE_RESERVE_LAMPORTS: bigint = 5_000n + 890_880n;

describe("SolanaWalletKit — interface wiring", () => {
  const kit = createSolanaWalletKit();

  it("advertises the solana namespace and capability flags", () => {
    assert.equal(kit.namespace, "solana");
    assert.equal(kit.supportsTokenTransfer, true);
    assert.equal(kit.supportsPrivateKeyImport, true);
    assert.equal(kit.displayName, "Solana");
  });
});

describe("SolanaWalletKit.validateAddress", () => {
  const kit = createSolanaWalletKit();

  it("returns true for the golden-vector base58 address", () => {
    assert.equal(kit.validateAddress(EXPECTED_ADDRESS), true);
  });

  it("rejects an EVM hex address (cross-curve guard)", () => {
    assert.equal(kit.validateAddress(VALID_EVM_ADDRESS), false);
  });

  it("rejects an empty string", () => {
    assert.equal(kit.validateAddress(""), false);
  });
});

describe("SolanaWalletKit.validatePrivateKey", () => {
  const kit = createSolanaWalletKit();

  it("rejects an EVM 64-hex private key (cross-curve guard)", () => {
    const evmKey =
      "0xabababababababababababababababababababababababababababababababab";
    assert.equal(kit.validatePrivateKey(evmKey), false);
  });

  it("rejects an empty string", () => {
    assert.equal(kit.validatePrivateKey(""), false);
  });
});

describe("SolanaWalletKit.validateMnemonic", () => {
  const kit = createSolanaWalletKit();

  it("accepts the canonical BIP-39 mnemonic", () => {
    assert.equal(kit.validateMnemonic(TEST_MNEMONIC), true);
  });

  it("trims surrounding whitespace before validation", () => {
    assert.equal(kit.validateMnemonic(`  ${TEST_MNEMONIC}  `), true);
  });

  it("rejects garbage", () => {
    assert.equal(kit.validateMnemonic("not a valid mnemonic"), false);
  });
});

describe("SolanaWalletKit.createWalletFromMnemonic (golden vector)", () => {
  const kit = createSolanaWalletKit();

  it("derives the Phantom-verified address for the canonical mnemonic", async () => {
    const wallet = await kit.createWalletFromMnemonic({
      mnemonic: TEST_MNEMONIC,
    });
    assert.equal(wallet.address, EXPECTED_ADDRESS);
    assert.equal(wallet.namespace, "solana");
    assert.equal(wallet.type, "SeedPhrase");
    assert.equal(wallet.source, "Created");
    assert.equal(wallet.solana?.pubkeyBase58, EXPECTED_ADDRESS);
  });

  it("throws on a malformed mnemonic", async () => {
    await assert.rejects(
      () => kit.createWalletFromMnemonic({ mnemonic: "not a mnemonic" }),
      /SolanaWalletKit: invalid BIP-39 mnemonic/,
    );
  });
});

describe("SolanaWalletKit.formatNativeAmount / parseNativeAmount", () => {
  const kit = createSolanaWalletKit();

  it("formatNativeAmount(1 SOL) renders '1.0000 SOL'", () => {
    assert.equal(
      kit.formatNativeAmount(1_000_000_000n, solanaDevnetChain),
      "1.0000 SOL",
    );
  });

  it("parseNativeAmount('1.5') returns 1_500_000_000n lamports", () => {
    assert.equal(
      kit.parseNativeAmount("1.5", solanaDevnetChain),
      1_500_000_000n,
    );
  });

  it("format throws on a non-solana chain", () => {
    assert.throws(
      () => kit.formatNativeAmount(1n, ethereumChain),
      /SolanaWalletKit: expected solana chain/,
    );
  });

  it("parse throws on a non-solana chain", () => {
    assert.throws(
      () => kit.parseNativeAmount("1", ethereumChain),
      /SolanaWalletKit: expected solana chain/,
    );
  });
});

describe("SolanaWalletKit.estimateMaxTransferable", () => {
  const kit = createSolanaWalletKit();

  it("subtracts the fee reserve from a comfortable balance", async () => {
    const max = await kit.estimateMaxTransferable({
      balance: 1_000_000_000n,
      chain: solanaDevnetChain,
      from: EXPECTED_ADDRESS,
    });
    assert.equal(max, 1_000_000_000n - FEE_RESERVE_LAMPORTS);
  });

  it("clamps to 0n when balance is below the fee reserve (no negatives)", async () => {
    const max = await kit.estimateMaxTransferable({
      balance: 100n,
      chain: solanaDevnetChain,
      from: EXPECTED_ADDRESS,
    });
    assert.equal(max, 0n);
  });
});

describe("SolanaWalletKit.truncateAddress", () => {
  const kit = createSolanaWalletKit();

  it("returns a start...end slice with the expected shape for the golden address", () => {
    const out = kit.truncateAddress(EXPECTED_ADDRESS);
    // Default start=4, end=4 per the spec ("short" preset in walletUtils).
    assert.equal(
      out,
      `${EXPECTED_ADDRESS.slice(0, 4)}...${EXPECTED_ADDRESS.slice(-4)}`,
    );
    assert.equal(out, "HAgk...Kpqk");
  });

  it("honours custom start/end lengths", () => {
    const out = kit.truncateAddress(EXPECTED_ADDRESS, { start: 6, end: 6 });
    assert.equal(
      out,
      `${EXPECTED_ADDRESS.slice(0, 6)}...${EXPECTED_ADDRESS.slice(-6)}`,
    );
  });

  it("returns an empty string for an empty input", () => {
    assert.equal(kit.truncateAddress(""), "");
  });
});

describe("SolanaWalletKit network methods — namespace guard", () => {
  const kit = createSolanaWalletKit();

  it("getNativeBalance rejects non-solana chains", async () => {
    await assert.rejects(
      () => kit.getNativeBalance(EXPECTED_ADDRESS, ethereumChain),
      /SolanaWalletKit: expected solana chain/,
    );
  });

  it("sendNativeTransfer rejects non-solana chains", async () => {
    await assert.rejects(
      () =>
        kit.sendNativeTransfer({
          wallet: { address: EXPECTED_ADDRESS } as never,
          to: EXPECTED_ADDRESS,
          amount: 1n,
          chain: ethereumChain,
        }),
      /SolanaWalletKit: expected solana chain/,
    );
  });

  it("exposes getSignerForWallet as a function (dwell-site delegation)", () => {
    assert.equal(typeof kit.getSignerForWallet, "function");
  });

  it("signX402SvmPayment is defined on SolanaWalletKit (M6 capability)", () => {
    // Path selector (task 41) presence-checks this method to route
    // Solana wallets down Path B-SVM. A typeof drift here would
    // silently break the selector without any other test catching it.
    assert.equal(typeof kit.signX402SvmPayment, "function");
  });

  it("signX402SvmPayment rejects a non-solana wallet namespace", async () => {
    await assert.rejects(
      () =>
        (kit.signX402SvmPayment as NonNullable<typeof kit.signX402SvmPayment>)({
          wallet: {
            address: VALID_EVM_ADDRESS,
            namespace: "eip155",
          } as never,
          cluster: "mainnet-beta",
          transaction: "AAAA",
        }),
      /expected solana wallet/,
    );
  });

  // TODO(Task 13+): live-wire a mocked `@solana/kit` RPC to exercise the
  // Solana happy path for `getNativeBalance` / `sendNativeTransfer` at
  // the kit surface. The primitives are already covered in
  // `services/chains/solana/transferService.test.ts`; the kit surface
  // only adds thin RPC construction + namespace-narrowing over them.
});

const solanaMainnetChain: ChainConfig = {
  namespace: "solana",
  cluster: "mainnet-beta",
  rpcUrl: "https://api.mainnet-beta.solana.com",
};

function blockchainRow(partial: Partial<TBlockchain>): TBlockchain {
  return {
    id: "row",
    name: "Row",
    chainId: null,
    chainSlug: null,
    rpcUrl: "",
    blockExplorer: "",
    isEVM: false,
    isActive: true,
    isTestnet: false,
    updatedAt: "",
    ...partial,
  } as TBlockchain;
}

describe("SolanaWalletKit — chain-agnostic capabilities", () => {
  const kit = createSolanaWalletKit();

  it("getAuthChainSlug maps cluster -> slug; null off-namespace", () => {
    assert.equal(kit.getAuthChainSlug?.(solanaDevnetChain), "solana-devnet");
    assert.equal(kit.getAuthChainSlug?.(solanaMainnetChain), "solana-mainnet");
    assert.equal(kit.getAuthChainSlug?.(ethereumChain), null);
  });

  it("advertises solana defaults", () => {
    assert.equal(kit.defaultAuthChainSlug, "solana-mainnet");
    assert.equal(kit.preferredPaymentRail, "solana");
  });

  it("matchesBlockchainRow matches by chainSlug + testnet parity", () => {
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaDevnetChain,
        blockchainRow({ chainSlug: "solana-devnet", isTestnet: true }),
      ),
      true,
    );
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaMainnetChain,
        blockchainRow({ chainSlug: "solana-mainnet", isTestnet: false }),
      ),
      true,
    );
  });

  it("matchesBlockchainRow rejects testnet mismatch, EVM rows, and sui rows", () => {
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaMainnetChain,
        blockchainRow({ chainSlug: "solana-devnet", isTestnet: true }),
      ),
      false,
    );
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaMainnetChain,
        blockchainRow({ isEVM: true, chainId: 1 }),
      ),
      false,
    );
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaMainnetChain,
        blockchainRow({ chainSlug: "sui-mainnet" }),
      ),
      false,
    );
  });

  it("matchesBlockchainRow falls back to name/rpc heuristic without chainSlug", () => {
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaMainnetChain,
        blockchainRow({
          name: "Solana",
          rpcUrl: "https://api.mainnet-beta.solana.com",
        }),
      ),
      true,
    );
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaMainnetChain,
        blockchainRow({
          name: "Sui",
          rpcUrl: "https://fullnode.mainnet.sui.io",
        }),
      ),
      false,
    );
  });
});

describe("SolanaWalletKit.estimateTransferFee", () => {
  const kit = createSolanaWalletKit();

  it("prices a native transfer at the single-signature base fee, no RPC needed", async () => {
    assert.deepEqual(
      await kit.estimateTransferFee?.({
        chain: solanaDevnetChain,
        from: "11111111111111111111111111111111",
        to: "11111111111111111111111111111111",
        amount: 1n,
      }),
      { feeNative: 5_000n, maxFeeNative: 5_000n },
    );
  });
});
