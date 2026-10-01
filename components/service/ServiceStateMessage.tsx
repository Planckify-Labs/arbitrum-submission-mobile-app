import { CloudOff, PackageOpen, SearchX } from "lucide-react-native";
import React from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

export type TServiceStateVariant = "error" | "empty" | "noResults";

type TProps = {
  variant: TServiceStateVariant;
  onRetry?: () => void;
  isRetrying?: boolean;
};

// Fixed copy only. This component never receives the failure itself, so
// nothing from the API or the transport can reach the screen.
const COPY: Record<TServiceStateVariant, { title: string; body: string }> = {
  error: {
    title: "Couldn't load services",
    body: "Something went wrong while loading services. Please try again.",
  },
  empty: {
    title: "No services available",
    body: "Services aren't available right now. Please check back soon.",
  },
  noResults: {
    title: "No results found",
    body: "Try a different keyword.",
  },
};

const ICON_COLOR = "#c71c4b";

export default function ServiceStateMessage({
  variant,
  onRetry,
  isRetrying = false,
}: TProps) {
  const { title, body } = COPY[variant];
  const Icon =
    variant === "error"
      ? CloudOff
      : variant === "noResults"
        ? SearchX
        : PackageOpen;

  return (
    <View className="flex-1 items-center justify-center px-8 py-20">
      <View
        className="w-20 h-20 rounded-full items-center justify-center mb-4"
        style={{ backgroundColor: "#c71c4b12" }}
      >
        <Icon size={36} color={ICON_COLOR} />
      </View>
      <Text className="text-light-matte-black font-bold text-xl mb-2 text-center">
        {title}
      </Text>
      <Text className="text-light-matte-black/50 text-center text-sm">
        {body}
      </Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          disabled={isRetrying}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          className="mt-6 h-11 min-w-[140px] items-center justify-center rounded-full px-6"
          style={{ backgroundColor: ICON_COLOR, opacity: isRetrying ? 0.6 : 1 }}
        >
          {isRetrying ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text className="text-white font-semibold text-sm">Try again</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
