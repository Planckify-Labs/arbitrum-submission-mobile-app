import { useQuery } from "@tanstack/react-query";
import { publicApi } from "@/constants/configs/ky";
import { filterSupportedTokens } from "@/services/tokens/tokenSupport";

export interface PaymentToken {
  id: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  decimals: number;
  isStablecoin: boolean;
  contractAddress: string | null;
  blockchain: {
    id: string;
    name: string;
    chainId: number | null;
  };
}

interface UsePaymentTokensOptions {
  blockchainId?: string;
  /**
   * Skip the stablecoin lockdown. For read-only lookups of a payment that
   * already happened (receipts), never for pickers.
   */
  includeUnsupported?: boolean;
}

async function fetchPaymentTokens(
  blockchainId?: string,
): Promise<PaymentToken[]> {
  const params = new URLSearchParams({
    isPaymentEnabled: "true",
    isActive: "true",
    take: "50",
  });
  if (blockchainId) {
    params.set("blockchainId", blockchainId);
  }
  return publicApi.get(`tokens/search?${params}`).json<PaymentToken[]>();
}

export function usePaymentTokens(options?: UsePaymentTokensOptions) {
  const blockchainId = options?.blockchainId;
  const includeUnsupported = options?.includeUnsupported ?? false;
  return useQuery<PaymentToken[]>({
    queryKey: ["payment-tokens", blockchainId ?? "all"],
    queryFn: () => fetchPaymentTokens(blockchainId),
    select: includeUnsupported ? undefined : filterSupportedTokens,
    staleTime: 5 * 60 * 1000,
  });
}
