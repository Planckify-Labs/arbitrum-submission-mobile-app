import { ShoppingBag, Sparkles, Wallet } from "lucide-react-native";
import { CHAIN_LOCKDOWN_ACTIVE } from "@/services/walletKit/chainSupport";

export const ONBOARDING_SLIDE_DATA = [
  {
    icon: Sparkles,
    iconColor: "#c71c4b",
    iconBgColor: "#fef2f2",
    accentColor: "#c71c4b",
    title: "Meet Your AI Wallet Agent",
    description:
      "Your personal assistant for managing crypto and redeeming points through natural conversations.",
    features: [
      "Natural language transaction execution",
      "Optional wallet access, you decide what the agent can do",
      CHAIN_LOCKDOWN_ACTIVE
        ? "Arbitrum and Robinhood Chain support"
        : "Multi-chain blockchain support",
    ],
  },
  {
    icon: Wallet,
    iconColor: "#059669",
    iconBgColor: "#ecfdf5",
    accentColor: "#059669",
    title: "On-Chain Actions",
    description: CHAIN_LOCKDOWN_ACTIVE
      ? "Send tokens, check balances, and monitor gas fees on Arbitrum and Robinhood Chain."
      : "Send tokens, check balances, and monitor gas fees across multiple chains.",
    features: [
      CHAIN_LOCKDOWN_ACTIVE
        ? "Native token: ETH"
        : "Native tokens: ETH, MATIC, BNB",
      CHAIN_LOCKDOWN_ACTIVE
        ? "Stablecoin: USDG & more"
        : "ERC-20: USDT, USDC, DAI & more",
      ...(CHAIN_LOCKDOWN_ACTIVE ? [] : ["NFT transfers (ERC-721)"]),
      "Real-time gas estimates",
    ],
  },
  {
    icon: ShoppingBag,
    iconColor: "#7c3aed",
    iconBgColor: "#faf5ff",
    accentColor: "#7c3aed",
    title: "Redeem via Chat",
    description:
      "Explore services and redeem your points directly in your conversation.",
    features: [
      "Full product catalog access",
      "Filter by category & price",
      "One-command redemption",
    ],
  },
];
