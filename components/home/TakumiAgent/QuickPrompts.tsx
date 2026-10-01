import { FlashList } from "@shopify/flash-list";
import React, { useMemo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useRecommendations } from "@/hooks/queries/useProducts";
import { useAddressBook } from "@/hooks/useAddressBook";
import { CHAIN_LOCKDOWN_ACTIVE } from "@/services/walletKit/chainSupport";

export interface QuickPromptsProps {
  onSelectPrompt: (prompt: string) => void;
}

export default function QuickPrompts({ onSelectPrompt }: QuickPromptsProps) {
  const { allContacts } = useAddressBook();
  const { data: recommendations } = useRecommendations(1);

  const prompts = useMemo(() => {
    const latestContact = allContacts.length
      ? [...allContacts].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0]
      : null;

    const transferPrompt = latestContact
      ? [
          {
            id: "transfer-1",
            prompt: `Transfer ${CHAIN_LOCKDOWN_ACTIVE ? "USDG" : "USDT"} to ${latestContact.label}`,
          },
        ]
      : [];

    const redeemPrompt = recommendations?.[0]
      ? [
          {
            id: "redeem-1",
            prompt: `Redeem ${recommendations[0].name} with my points`,
          },
        ]
      : [];

    const staticPrompts = [
      { id: "static-1", prompt: "how many points do i have?" },
      { id: "static-2", prompt: "items i can redeem with my points" },
      {
        id: "static-3",
        prompt: CHAIN_LOCKDOWN_ACTIVE
          ? "Swap 0.01 ETH for USDG"
          : "Swap 1 ETH for USDC",
      },
      { id: "static-4", prompt: "Set up a DeFi strategy" },
    ];

    return [...transferPrompt, ...redeemPrompt, ...staticPrompts].slice(0, 5);
  }, [allContacts, recommendations]);

  return (
    <View className="py-5 bg-light-main-container mb-[47px]">
      <Text className="text-lg font-semibold text-light-matte-black/80 mx-4 mb-2">
        What can I help you with?
      </Text>

      <FlashList
        data={prompts}
        nestedScrollEnabled
        renderItem={({ item }) => (
          <TouchableOpacity
            className="min-w-[140px] border border-light-matte-black/10 max-w-[200px]- px-3 py-3 rounded-full bg-light/10 justify-center items-center"
            onPress={() => onSelectPrompt(item.prompt)}
          >
            <Text
              className="text-sm font-bold text-light-matte-black/40 text-center leading-tight"
              numberOfLines={2}
            >
              {item.prompt}
            </Text>
          </TouchableOpacity>
        )}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16 }}
        ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
        numColumns={1}
      />
    </View>
  );
}
