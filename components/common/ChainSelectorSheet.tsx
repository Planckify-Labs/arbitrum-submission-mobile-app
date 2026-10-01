/**
 * The network picker itself, with no opinion about what opens it.
 *
 * Split out because the app grew TWO network pickers: the home-screen
 * pill (`ChainSelector`) and a second, independently written one behind
 * the chain avatar in the agent's conversation list. They had already
 * drifted — only one had search and namespace grouping — and when the
 * "don't offer chains the user holds no wallet for" rule landed on the
 * first, the second carried on offering Sui to a private-key EVM user.
 *
 * That is the bug this file exists to make unrepeatable: the list, its
 * filtering, and its empty states live here exactly once, and a new
 * entry point supplies nothing but a trigger.
 */

import { Check, Plus, Search, X } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { BrandSwitch } from "@/components/common/BrandSwitch";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { useTokens } from "@/hooks/queries/useTokens";
import { useAddWalletPrompt } from "@/hooks/useAddWalletPrompt";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useWallet } from "@/hooks/useWallet";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { ownedNamespaces } from "@/services/walletPresence";

export type ChainSelectorSheetProps = {
  visible: boolean;
  onClose: () => void;
};

type ChainRowItem = {
  key: string;
  namespace: Namespace;
  label: string;
  symbol: string;
  iconUrl: string | undefined;
  isTestnet: boolean;
  evmChainId?: number;
  solanaCluster?: "mainnet-beta" | "devnet";
  suiNetwork?: "mainnet" | "testnet" | "devnet";
  stellarNetwork?: "mainnet" | "testnet";
  config: ChainConfig;
};

// Per-device preference, not per-wallet: it's about what the user wants to
// see in this list, and most users never need testnets at all.
const SHOW_TESTNETS_KEY = "chainSelector:showTestnets";

function capitalize(ns: string): string {
  return ns.charAt(0).toUpperCase() + ns.slice(1);
}

function sectionTitleForNamespace(ns: Namespace): string {
  // "EVM", not the kit's `displayName` ("Ethereum"): this group holds
  // Arbitrum, Base, BSC, Arc and friends, and labelling it "Ethereum" read
  // as if those were Ethereum itself.
  if (ns === "eip155") return "EVM";
  try {
    const kit = walletKitRegistry.get(ns);
    return kit.displayName ?? capitalize(ns);
  } catch {
    return capitalize(ns);
  }
}

function sortWithinGroup<T extends { isTestnet: boolean }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.isTestnet === b.isTestnet) return 0;
    return a.isTestnet ? 1 : -1;
  });
}

function ChainRowSkeleton() {
  return (
    <View className="flex-row items-center p-4 mb-2 rounded-xl bg-light">
      <SingleLoadingSekeleton
        width={24}
        height={24}
        borderRadius={12}
        style={{ marginRight: 12 }}
      />
      <View style={{ flex: 1 }}>
        <SingleLoadingSekeleton
          width="45%"
          height={14}
          style={{ marginBottom: 6 }}
        />
        <SingleLoadingSekeleton width="28%" height={12} />
      </View>
    </View>
  );
}

function ChainListSkeleton() {
  return (
    <View>
      {[0, 1].map((group) => (
        <View key={group} className="mb-2">
          <SingleLoadingSekeleton
            width={96}
            height={10}
            style={{ marginTop: 8, marginBottom: 12 }}
          />
          <ChainRowSkeleton />
          <ChainRowSkeleton />
          <ChainRowSkeleton />
        </View>
      ))}
    </View>
  );
}

function ChainSelectorSheetBase({ visible, onClose }: ChainSelectorSheetProps) {
  const { activeChain, changeActiveChain, changeActiveChainToConfig, wallets } =
    useWallet();
  const [searchQuery, setSearchQuery] = useState("");
  const [switchingRowKey, setSwitchingRowKey] = useState<string | null>(null);
  const [showTestnets, setShowTestnets] = useState<boolean>(
    () => storage.getBoolean(SHOW_TESTNETS_KEY) ?? false,
  );
  const handleToggleTestnets = useCallback((value: boolean) => {
    setShowTestnets(value);
    storage.set(SHOW_TESTNETS_KEY, value);
  }, []);
  const { promptFor, sheet: addWalletSheet } = useAddWalletPrompt();

  // Which namespaces the device can actually act on. Scoped to every
  // wallet, not just the active account's, because `pickWalletForChain`
  // will happily resolve a wallet from another account when switching —
  // so a Sui wallet in a second account genuinely does make Sui
  // reachable.
  //
  // `null` means "don't know yet": `wallets` is empty while it hydrates
  // out of SecureStore, and treating that as "owns nothing" would blank
  // the entire network list and replace it with four add-wallet rows for
  // a frame.
  const reachable = useMemo<Set<Namespace> | null>(
    () => (wallets.length === 0 ? null : new Set(ownedNamespaces(wallets))),
    [wallets],
  );

  const { data: blockchains, isLoading: isLoadingBlockchains } =
    useBlockchainsWithStorage({ isActive: true });

  const { data: nativeTokens, isLoading: isLoadingTokens } = useTokens({
    isNativeCurrency: true,
    isActive: true,
  });

  const isLoading = isLoadingBlockchains || isLoadingTokens;

  const grouped = useMemo<Map<Namespace, ChainRowItem[]>>(() => {
    const order: Namespace[] = walletKitRegistry
      .getAll()
      .map((kit) => kit.namespace);

    const groups = new Map<Namespace, ChainRowItem[]>();
    for (const ns of order) groups.set(ns, []);

    if (blockchains && nativeTokens) {
      for (const blockchain of blockchains) {
        const token =
          blockchain.tokens?.find((t) => t.isNativeCurrency) ??
          blockchain.tokens?.[0];
        const config = buildChainConfigFromBlockchain(blockchain);
        let row: ChainRowItem;
        // Exhaustive switch (not if/else-if/else) so a future 5th
        // namespace fails loud at compile time instead of silently
        // falling into whatever the last `else` branch happened to be —
        // exactly the bug that mis-filed Stellar rows under "sui" here
        // (the old `else` hard-coded `namespace: "sui"` for anything
        // that wasn't eip155/solana).
        switch (config.namespace) {
          case "eip155":
            row = {
              key: `eip155:${blockchain.chainId ?? "unknown"}`,
              namespace: "eip155",
              label: blockchain.name,
              symbol: token?.symbol ?? "",
              iconUrl: token?.logoUrl ?? undefined,
              isTestnet: Boolean(config.isTestnet),
              evmChainId: blockchain.chainId ?? undefined,
              config,
            };
            break;
          case "solana":
            row = {
              key: `solana:${config.cluster}`,
              namespace: "solana",
              label: blockchain.name,
              symbol: token?.symbol ?? "",
              iconUrl: token?.logoUrl ?? config.iconUrl,
              isTestnet: Boolean(config.isTestnet),
              solanaCluster: config.cluster,
              config,
            };
            break;
          case "sui":
            row = {
              key: `sui:${config.network}`,
              namespace: "sui",
              label: blockchain.name,
              symbol: token?.symbol ?? "SUI",
              iconUrl: token?.logoUrl ?? config.iconUrl,
              isTestnet: Boolean(config.isTestnet),
              suiNetwork: config.network,
              config,
            };
            break;
          case "stellar":
            row = {
              key: `stellar:${config.network}`,
              namespace: "stellar",
              label: blockchain.name,
              symbol: token?.symbol ?? "XLM",
              iconUrl: token?.logoUrl ?? config.iconUrl,
              isTestnet: Boolean(config.isTestnet),
              stellarNetwork: config.network,
              config,
            };
            break;
          default: {
            const _exhaustive: never = config;
            throw new Error(
              `ChainSelector: unhandled chain namespace ${JSON.stringify(_exhaustive)}`,
            );
          }
        }
        const bucket = groups.get(row.namespace);
        if (bucket) bucket.push(row);
        else groups.set(row.namespace, [row]);
      }
    }

    const final = new Map<Namespace, ChainRowItem[]>();
    for (const [ns, rows] of groups) {
      if (rows.length === 0) continue;
      final.set(ns, sortWithinGroup(rows));
    }
    return final;
  }, [blockchains, nativeTokens]);

  const handleChainSelect = useCallback(
    async (row: ChainRowItem) => {
      setSwitchingRowKey(row.key);

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );

      try {
        if (row.namespace === "eip155" && typeof row.evmChainId === "number") {
          await changeActiveChain(row.evmChainId);
        } else {
          await changeActiveChainToConfig(row.config);
        }
      } finally {
        setSwitchingRowKey(null);
        onClose();
      }
    },
    [changeActiveChain, changeActiveChainToConfig, onClose],
  );

  const handleAddWallet = useCallback(
    (ns: Namespace) => {
      // Close this picker before opening the add-wallet sheet. Both are
      // modals, and stacking them gives the user two backdrops and two
      // drag handles for one decision.
      onClose();
      promptFor(ns);
    },
    [promptFor, onClose],
  );

  const isRowActive = useCallback(
    (row: ChainRowItem): boolean => {
      if (row.namespace === "eip155" && activeChain.namespace === "eip155") {
        return activeChain.chain.id === row.evmChainId;
      }
      if (row.namespace === "solana" && activeChain.namespace === "solana") {
        return activeChain.cluster === row.solanaCluster;
      }
      if (row.namespace === "sui" && activeChain.namespace === "sui") {
        return activeChain.network === row.suiNetwork;
      }
      if (row.namespace === "stellar" && activeChain.namespace === "stellar") {
        return activeChain.network === row.stellarNetwork;
      }
      return false;
    },
    [activeChain],
  );

  /**
   * Chains the user can actually switch to. Selecting a namespace with no
   * wallet behind it used to move `activeChain` while `activeWallet`
   * stayed put — `pickWalletForChain` returns null and the caller leaves
   * state as-is — which left the app wedged: Send spun on "Switching
   * network…" forever and balances rendered "—" until the user guessed
   * that switching back was the fix.
   */
  /**
   * Every chain the backend serves, reachable or not. Unreachable ones are
   * NOT filtered out — `renderChainItem` dims them and swaps the tap for a
   * "get a wallet" prompt. Hiding them made a chain the user knows exists
   * look unsupported, and moving them to a separate bucket pushed real
   * networks off screen as the namespace count grew.
   */
  const { filteredGrouped, hiddenTestnetMatches } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const out = new Map<Namespace, ChainRowItem[]>();
    let hidden = 0;
    for (const [ns, rows] of grouped) {
      const hits: ChainRowItem[] = [];
      for (const r of rows) {
        const matches =
          q.length === 0 ||
          r.label.toLowerCase().includes(q) ||
          r.symbol.toLowerCase().includes(q);
        if (!matches) continue;
        // Testnets are hidden unless opted in, but the active chain always
        // stays listed: a user sitting on a testnet must still see where
        // they are and the check mark on it.
        if (r.isTestnet && !showTestnets && !isRowActive(r)) {
          hidden++;
          continue;
        }
        hits.push(r);
      }
      if (hits.length > 0) out.set(ns, hits);
    }
    // Only worth surfacing while searching: someone typing "sepolia" wants
    // it found, not a silent "no match" because of a toggle they forgot.
    return {
      filteredGrouped: out,
      hiddenTestnetMatches: q.length > 0 ? hidden : 0,
    };
  }, [grouped, searchQuery, showTestnets, isRowActive]);

  const renderChainItem = useCallback(
    (row: ChainRowItem) => {
      const isActive = isRowActive(row);
      const isThisSwitching = switchingRowKey === row.key;
      const isAnySwitching = switchingRowKey !== null;
      // Reachable = the device holds a key on this row's namespace. Rows that
      // aren't stay in place rather than moving to a separate bucket: a user
      // looking for "Sui" should find it where they expect, learn why it's
      // unavailable, and be offered the fix — not silently not see it.
      const unreachable = reachable !== null && !reachable.has(row.namespace);

      return (
        <Pressable
          key={row.key}
          className={`flex-row items-center p-4 mb-2 rounded-xl ${
            isActive ? "bg-light-primary-red/10" : "bg-light"
          } ${isAnySwitching && !isThisSwitching ? "opacity-40" : ""}`}
          onPress={() => {
            if (isAnySwitching) return;
            // Never switch to a chain with no wallet behind it: that used to
            // move `activeChain` while `activeWallet` stayed put and wedged
            // the app. Explain and offer a wallet instead.
            if (unreachable) return handleAddWallet(row.namespace);
            handleChainSelect(row);
          }}
        >
          <Image
            source={{ uri: row.iconUrl }}
            style={{ width: 24, height: 24 }}
            className={`mr-3 rounded-full ${unreachable ? "opacity-40" : ""}`}
            defaultSource={require("@/assets/images/takumipay-logo.png")}
          />

          <View className="flex-1">
            <Text
              className={`font-bold ${
                unreachable
                  ? "text-light-matte-black/50"
                  : "text-light-matte-black"
              }`}
            >
              {row.label}
            </Text>
            <Text
              className={`text-sm ${
                unreachable
                  ? "text-light-matte-black/40"
                  : "text-light-matte-black/70"
              }`}
            >
              {isThisSwitching
                ? "Switching…"
                : unreachable
                  ? "No wallet yet"
                  : row.symbol || "N/A"}
            </Text>
          </View>

          {row.isTestnet && !isThisSwitching && (
            <View
              className={`bg-yellow-500/20 px-2 py-1 rounded-full mr-2 ${
                unreachable ? "opacity-50" : ""
              }`}
            >
              <Text className="text-yellow-700 text-xs font-medium">
                Testnet
              </Text>
            </View>
          )}

          {isThisSwitching ? (
            <ActivityIndicator size="small" color="#c71c4b" />
          ) : unreachable ? (
            <View className="flex-row items-center">
              <Plus size={14} color="#c71c4b" strokeWidth={2.5} />
              <Text className="text-light-primary-red text-xs font-bold ml-1">
                Get
              </Text>
            </View>
          ) : isActive ? (
            <View className="w-6 h-6 rounded-full bg-light-primary-red/10 items-center justify-center">
              <Check size={14} color="#c71c4b" strokeWidth={3} />
            </View>
          ) : null}
        </Pressable>
      );
    },
    [
      isRowActive,
      handleChainSelect,
      handleAddWallet,
      switchingRowKey,
      reachable,
    ],
  );

  return (
    <>
      <BaseModal
        visible={visible}
        onClose={onClose}
        onClosed={() => setSearchQuery("")}
        height="67%"
        contentClassName="px-6"
      >
        <ModalHeader title="Select Network" />

        <View className="flex-row items-center bg-light rounded-2xl px-3 py-2 mb-3">
          <Search size={16} color="#20222c80" />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search networks"
            placeholderTextColor="#20222c80"
            autoCorrect={false}
            autoCapitalize="none"
            className="flex-1 ml-2 text-light-matte-black"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery("")}>
              <X size={14} color="#20222c80" />
            </Pressable>
          )}
        </View>

        <View className="flex-row items-center justify-between mb-2">
          <Text className="text-light-matte-black/70 text-sm font-medium">
            Show testnets
          </Text>
          <BrandSwitch
            value={showTestnets}
            onValueChange={handleToggleTestnets}
            accessibilityLabel="Show testnets"
          />
        </View>

        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 }}
        >
          {isLoading ? (
            <ChainListSkeleton />
          ) : filteredGrouped.size === 0 ? (
            <View className="items-center justify-center py-8">
              <Text className="text-light-matte-black/60 text-sm text-center">
                {searchQuery.trim().length > 0
                  ? `No networks match "${searchQuery}"`
                  : "No networks available"}
              </Text>
            </View>
          ) : (
            Array.from(filteredGrouped.entries()).map(([ns, rows]) => (
              <View key={ns} className="mb-2">
                <Text className="text-light-matte-black/60 text-xs font-semibold uppercase mb-2 mt-2">
                  {sectionTitleForNamespace(ns)}
                </Text>
                {rows.map(renderChainItem)}
              </View>
            ))
          )}

          {!isLoading && hiddenTestnetMatches > 0 && (
            <Pressable
              onPress={() => handleToggleTestnets(true)}
              className="items-center py-3"
              accessibilityRole="button"
            >
              <Text className="text-light-matte-black/60 text-xs text-center">
                {hiddenTestnetMatches === 1
                  ? "1 testnet matches."
                  : `${hiddenTestnetMatches} testnets match.`}{" "}
                <Text className="text-light-primary-red font-bold">
                  Show testnets
                </Text>
              </Text>
            </Pressable>
          )}
        </ScrollView>
      </BaseModal>

      {/* Sibling, not child: the picker above closes before this opens. */}
      {addWalletSheet}
    </>
  );
}

const ChainSelectorSheet = memo(ChainSelectorSheetBase);

export default ChainSelectorSheet;
export { ChainSelectorSheet };
