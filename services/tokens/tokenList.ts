/**
 * Bundled default token list + user preferences (pin/hide/add).
 * Persisted via expo-sqlite.
 */

import * as SQLite from "expo-sqlite";
import { filterSupportedTokens } from "./tokenSupport";
import type { TokenInfo } from "./types";

// ─── Default token list (top tokens per chain) ──────────────────────

const DEFAULT_TOKENS: TokenInfo[] = [
  // Ethereum Mainnet (chainId: 1)
  {
    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    chainId: 1,
  },
  {
    contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    chainId: 1,
  },
  {
    contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    chainId: 1,
  },
  {
    contractAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
    chainId: 1,
  },
  {
    contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    chainId: 1,
  },
  {
    contractAddress: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    symbol: "LINK",
    name: "Chainlink Token",
    decimals: 18,
    chainId: 1,
  },
  {
    contractAddress: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    symbol: "UNI",
    name: "Uniswap",
    decimals: 18,
    chainId: 1,
  },
  {
    contractAddress: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    symbol: "AAVE",
    name: "Aave Token",
    decimals: 18,
    chainId: 1,
  },
  {
    contractAddress: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    symbol: "stETH",
    name: "Lido Staked Ether",
    decimals: 18,
    chainId: 1,
  },
  {
    contractAddress: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    decimals: 18,
    chainId: 1,
  },
  // Polygon (chainId: 137)
  {
    contractAddress: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    chainId: 137,
  },
  {
    contractAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    chainId: 137,
  },
  {
    contractAddress: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    symbol: "WMATIC",
    name: "Wrapped Matic",
    decimals: 18,
    chainId: 137,
  },
  {
    contractAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    chainId: 137,
  },
  // BSC (chainId: 56)
  {
    contractAddress: "0x55d398326f99059fF775485246999027B3197955",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 18,
    chainId: 56,
  },
  {
    contractAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 18,
    chainId: 56,
  },
  {
    contractAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    symbol: "WBNB",
    name: "Wrapped BNB",
    decimals: 18,
    chainId: 56,
  },
  {
    contractAddress: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    symbol: "ETH",
    name: "Ethereum Token",
    decimals: 18,
    chainId: 56,
  },
];

// ─── Top 100 token names for Levenshtein comparison ─────────────────

export const TOP_100_NAMES = [
  "Bitcoin",
  "Ethereum",
  "Tether USD",
  "USD Coin",
  "BNB",
  "XRP",
  "Cardano",
  "Dogecoin",
  "Solana",
  "TRON",
  "Polkadot",
  "Polygon",
  "Litecoin",
  "Shiba Inu",
  "Dai Stablecoin",
  "Avalanche",
  "Wrapped BTC",
  "Chainlink Token",
  "Uniswap",
  "Cosmos",
  "Stellar",
  "Monero",
  "Ethereum Classic",
  "Filecoin",
  "Aptos",
  "Hedera",
  "Lido Staked Ether",
  "Arbitrum",
  "Optimism",
  "Near Protocol",
  "Aave Token",
  "The Graph",
  "Fantom",
  "Algorand",
  "Maker",
  "Compound",
  "Synthetix",
  "Curve DAO Token",
  "Decentraland",
  "Axie Infinity",
  "PancakeSwap",
  "SushiSwap",
  "1inch",
  "Enjin Coin",
  "Loopring",
  "Basic Attention Token",
  "Yearn Finance",
  "Convex Finance",
  "Rocket Pool",
  "Frax",
  "USDC",
  "USDT",
  "WETH",
  "WBTC",
  "DAI",
  "UNI",
  "LINK",
  "AAVE",
  "MKR",
  "COMP",
  "SNX",
  "CRV",
  "SUSHI",
  "BAT",
  "ENJ",
  "LRC",
  "YFI",
  "CVX",
  "RPL",
  "FRAX",
  "stETH",
  "wstETH",
  "rETH",
  "cbETH",
  "MATIC",
  "ARB",
  "OP",
  "APT",
  "SOL",
  "DOGE",
  "SHIB",
  "ADA",
  "DOT",
  "AVAX",
  "NEAR",
  "FTM",
  "ALGO",
  "MANA",
  "AXS",
  "GRT",
  "FIL",
  "XMR",
  "XLM",
  "ATOM",
  "HBAR",
  "TRX",
  "LTC",
  "BNB",
  "ETH",
  "BTC",
  "USDC.e",
];

// ─── SQLite persistence for user preferences ────────────────────────

let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync("token_prefs.db");
    db.execSync(
      "CREATE TABLE IF NOT EXISTS user_tokens (" +
        "contract_address TEXT NOT NULL, " +
        "chain_id INTEGER NOT NULL, " +
        "symbol TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "decimals INTEGER NOT NULL, " +
        "logo_uri TEXT, " +
        "PRIMARY KEY (contract_address, chain_id)" +
        ");",
    );
    db.execSync(
      "CREATE TABLE IF NOT EXISTS token_prefs (" +
        "contract_address TEXT NOT NULL, " +
        "chain_id INTEGER NOT NULL, " +
        "is_pinned INTEGER DEFAULT 0, " +
        "is_hidden INTEGER DEFAULT 0, " +
        "is_spam INTEGER DEFAULT 0, " +
        "PRIMARY KEY (contract_address, chain_id)" +
        ");",
    );
  }
  return db;
}

// ─── Public API ──────────────────────────────────────────────────────

export function getDefaultTokens(chainId: number): TokenInfo[] {
  return filterSupportedTokens(
    DEFAULT_TOKENS.filter((t) => t.chainId === chainId),
  );
}

export function getAllDefaultTokens(): TokenInfo[] {
  return filterSupportedTokens([...DEFAULT_TOKENS]);
}

export function isDefaultToken(
  contractAddress: string,
  chainId: number,
): boolean {
  return DEFAULT_TOKENS.some(
    (t) =>
      t.contractAddress.toLowerCase() === contractAddress.toLowerCase() &&
      t.chainId === chainId,
  );
}

export function addUserToken(token: TokenInfo): void {
  const database = getDb();
  database.runSync(
    "INSERT OR REPLACE INTO user_tokens (contract_address, chain_id, symbol, name, decimals, logo_uri) VALUES (?, ?, ?, ?, ?, ?)",
    [
      token.contractAddress,
      token.chainId,
      token.symbol,
      token.name,
      token.decimals,
      token.logoURI ?? null,
    ],
  );
}

export function getUserTokens(chainId?: number): TokenInfo[] {
  const database = getDb();
  const query = chainId
    ? "SELECT * FROM user_tokens WHERE chain_id = ?"
    : "SELECT * FROM user_tokens";
  const params = chainId ? [chainId] : [];
  const rows = database.getAllSync<{
    contract_address: string;
    chain_id: number;
    symbol: string;
    name: string;
    decimals: number;
    logo_uri: string | null;
  }>(query, params);

  return rows.map((r) => ({
    contractAddress: r.contract_address,
    chainId: r.chain_id,
    symbol: r.symbol,
    name: r.name,
    decimals: r.decimals,
    logoURI: r.logo_uri ?? undefined,
  }));
}

export function pinToken(contractAddress: string, chainId: number): void {
  const database = getDb();
  database.runSync(
    "INSERT INTO token_prefs (contract_address, chain_id, is_pinned) VALUES (?, ?, 1) " +
      "ON CONFLICT(contract_address, chain_id) DO UPDATE SET is_pinned = 1",
    [contractAddress, chainId],
  );
}

export function hideToken(contractAddress: string, chainId: number): void {
  const database = getDb();
  database.runSync(
    "INSERT INTO token_prefs (contract_address, chain_id, is_hidden) VALUES (?, ?, 1) " +
      "ON CONFLICT(contract_address, chain_id) DO UPDATE SET is_hidden = 1",
    [contractAddress, chainId],
  );
}

export function unhideToken(contractAddress: string, chainId: number): void {
  const database = getDb();
  database.runSync(
    "UPDATE token_prefs SET is_hidden = 0 WHERE contract_address = ? AND chain_id = ?",
    [contractAddress, chainId],
  );
}

export function markAsSpam(contractAddress: string, chainId: number): void {
  const database = getDb();
  database.runSync(
    "INSERT INTO token_prefs (contract_address, chain_id, is_spam, is_hidden) VALUES (?, ?, 1, 1) " +
      "ON CONFLICT(contract_address, chain_id) DO UPDATE SET is_spam = 1, is_hidden = 1",
    [contractAddress, chainId],
  );
}

export interface TokenPrefs {
  isPinned: boolean;
  isHidden: boolean;
  isSpam: boolean;
}

export function getTokenPrefs(
  contractAddress: string,
  chainId: number,
): TokenPrefs {
  const database = getDb();
  const row = database.getFirstSync<{
    is_pinned: number;
    is_hidden: number;
    is_spam: number;
  }>(
    "SELECT is_pinned, is_hidden, is_spam FROM token_prefs WHERE contract_address = ? AND chain_id = ?",
    [contractAddress, chainId],
  );
  return {
    isPinned: row?.is_pinned === 1,
    isHidden: row?.is_hidden === 1,
    isSpam: row?.is_spam === 1,
  };
}

export function getAllTokenPrefs(): Map<string, TokenPrefs> {
  const database = getDb();
  const rows = database.getAllSync<{
    contract_address: string;
    chain_id: number;
    is_pinned: number;
    is_hidden: number;
    is_spam: number;
  }>("SELECT * FROM token_prefs");

  const map = new Map<string, TokenPrefs>();
  for (const r of rows) {
    map.set(`${r.contract_address.toLowerCase()}:${r.chain_id}`, {
      isPinned: r.is_pinned === 1,
      isHidden: r.is_hidden === 1,
      isSpam: r.is_spam === 1,
    });
  }
  return map;
}
