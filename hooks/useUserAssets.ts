import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TCryptoAsset } from "@/constants/types/assetTypes";
import { filterSupportedTokens } from "@/services/tokens/tokenSupport";
import {
  addAsset,
  addCustomToken,
  addMultipleAssets,
  filterAssets,
  removeAsset,
} from "@/utils/assetUtils";
import { useActiveNetwork } from "./useAssetExplorerState";
import useRQGlobalState from "./useRQGlobalState";
import { useWallet } from "./useWallet";

export const useUserAssets = () => {
  const { wallets, activeWalletIndex } = useWallet();
  const activeWallet = wallets[activeWalletIndex];
  const { activeNetwork } = useActiveNetwork();

  const queryKey = useMemo(
    () => ["userAssets", activeWallet?.address, activeNetwork] as const,
    [activeWallet?.address, activeNetwork],
  );

  const { data: userAssets, setNewData: setUserAssets } = useRQGlobalState<
    TCryptoAsset[]
  >({
    queryKey,
    initialData: [],
  });

  const isLoadingRef = useRef(false);
  const previousKeyRef = useRef<string | null>(null);

  const getStorageKey = useCallback(() => {
    return `wallet_assets_${activeWallet?.address}_${activeNetwork}`;
  }, [activeWallet?.address, activeNetwork]);

  const loadUserAssets = useCallback(async () => {
    const storageKey = getStorageKey();
    isLoadingRef.current = true;

    try {
      const storedAssets = await AsyncStorage.getItem(storageKey);

      if (storedAssets) {
        setUserAssets(JSON.parse(storedAssets));
      } else {
        setUserAssets([]);
      }
    } catch (error) {
      console.error("Failed to load assets:", error);
      setUserAssets([]);
    } finally {
      isLoadingRef.current = false;
      previousKeyRef.current = storageKey;
    }
  }, [getStorageKey, setUserAssets]);

  const saveUserAssets = useCallback(
    async (assets: TCryptoAsset[]) => {
      const storageKey = getStorageKey();

      if (isLoadingRef.current || previousKeyRef.current !== storageKey) {
        return;
      }

      try {
        await AsyncStorage.setItem(storageKey, JSON.stringify(assets));
      } catch (error) {
        console.error("Failed to save assets:", error);
      }
    },
    [getStorageKey],
  );

  useEffect(() => {
    if (activeWallet?.address && activeNetwork) {
      loadUserAssets();
    }
  }, [activeWallet?.address, activeNetwork, loadUserAssets]);

  const handleAddAsset = useCallback(
    (asset: TCryptoAsset) => {
      const updatedAssets = addAsset(userAssets ?? [], asset);
      setUserAssets(updatedAssets);
      saveUserAssets(updatedAssets);
    },
    [userAssets, setUserAssets, saveUserAssets],
  );

  const handleRemoveAsset = useCallback(
    (assetId: string) => {
      const updatedAssets = removeAsset(userAssets ?? [], assetId);
      setUserAssets(updatedAssets);
      saveUserAssets(updatedAssets);
    },
    [userAssets, setUserAssets, saveUserAssets],
  );

  const handleAddCustomToken = useCallback(
    async (tokenAddress: string) => {
      const updatedAssets = await addCustomToken(
        userAssets ?? [],
        tokenAddress,
      );
      setUserAssets(updatedAssets);
      saveUserAssets(updatedAssets);
    },
    [userAssets, setUserAssets, saveUserAssets],
  );

  const handleAddMultipleAssets = useCallback(
    (assetsToAdd: TCryptoAsset[]) => {
      const updatedAssets = addMultipleAssets(userAssets ?? [], assetsToAdd);
      setUserAssets(updatedAssets);
      saveUserAssets(updatedAssets);
    },
    [userAssets, setUserAssets, saveUserAssets],
  );

  const isAssetAdded = useCallback(
    (assetId: string) => {
      return (userAssets ?? []).some((asset) => asset.id === assetId);
    },
    [userAssets],
  );

  // Stablecoin lockdown is applied on the read only: the saved list keeps
  // every asset, so nothing is lost when the flag flips off.
  const visibleUserAssets = useMemo(
    () => filterSupportedTokens(userAssets ?? []),
    [userAssets],
  );

  const getFilteredAssets = useCallback(
    (searchQuery: string) => {
      return filterAssets(visibleUserAssets, searchQuery);
    },
    [visibleUserAssets],
  );

  return {
    userAssets: visibleUserAssets,
    addAsset: handleAddAsset,
    removeAsset: handleRemoveAsset,
    addCustomToken: handleAddCustomToken,
    addMultipleAssets: handleAddMultipleAssets,
    isAssetAdded,
    getFilteredAssets,
  };
};
