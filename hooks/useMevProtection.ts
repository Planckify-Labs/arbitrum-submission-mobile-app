/**
 * Reactive hook for MEV settings.
 * Spec: docs/swap-capability-spec.md §9.2.
 */

import { useCallback } from "react";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import {
  getMevEnabled,
  MEV_SETTINGS_QUERY_KEY,
  setMevEnabled,
} from "@/services/swap/mevProtection";

export function useMevProtection() {
  const { data, setNewData } = useRQGlobalState<boolean>({
    queryKey: MEV_SETTINGS_QUERY_KEY,
    initialData: getMevEnabled(),
  });

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setMevEnabled(enabled);
      setNewData(enabled);
    },
    [setNewData],
  );

  return { mevEnabled: data ?? true, setMevEnabled: setEnabled };
}
