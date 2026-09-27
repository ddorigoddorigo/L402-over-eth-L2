import type { Address } from "viem";
import { base, baseSepolia, arbitrum, optimism } from "viem/chains";
import type { PaymentNetwork } from "./types.js";

/**
 * Wrapped BTC tokens per chain.
 *
 * cbBTC (Coinbase Wrapped BTC) is the default choice on Base: 8 decimals like BTC
 * and EIP-2612/EIP-3009 support, which allows single-signature deposits.
 * Classic WBTC does not implement permit: it needs `approve` + `openChannel`,
 * ideally inside one ERC-4337 batch transaction.
 *
 * ⚠️ Always double-check addresses on the chain explorer before going to
 * mainnet: these are convenience values, not a source of truth.
 * cbBTC su Base: https://basescan.org/token/0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
 * WBTC su Arbitrum: https://arbiscan.io/token/0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f
 */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** true if the token exposes `permit` (EIP-2612). */
  permit: boolean;
  /** true if the token exposes `receiveWithAuthorization` (EIP-3009). */
  authorization: boolean;
}

export const TOKENS: Record<number, Record<string, TokenInfo>> = {
  [base.id]: {
    cbBTC: {
      address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      symbol: "cbBTC",
      decimals: 8,
      permit: true,
      authorization: true,
    },
    tBTC: {
      address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",
      symbol: "tBTC",
      decimals: 18,
      permit: true,
      authorization: false,
    },
  },
  [arbitrum.id]: {
    WBTC: {
      address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      symbol: "WBTC",
      decimals: 8,
      permit: false,
      authorization: false,
    },
    tBTC: {
      address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
      symbol: "tBTC",
      decimals: 18,
      permit: true,
      authorization: false,
    },
  },
  [optimism.id]: {
    WBTC: {
      address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
      symbol: "WBTC",
      decimals: 8,
      permit: false,
      authorization: false,
    },
  },
  [baseSepolia.id]: {
    // On testnets use a MockBTC you deployed yourself: set TOKEN_ADDRESS in .env.
  },
};

export const SUPPORTED_CHAINS = [base, baseSepolia, arbitrum, optimism];

export function getChain(chainId: number) {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);
  return chain;
}

export function getToken(chainId: number, symbol: string): TokenInfo {
  const token = TOKENS[chainId]?.[symbol];
  if (!token) {
    throw new Error(
      `Token ${symbol} is not configured for chain ${chainId}. Pass its address explicitly in the config.`,
    );
  }
  return token;
}

export function buildNetwork(chainId: number, escrow: Address, token: TokenInfo): PaymentNetwork {
  return {
    chainId,
    escrow,
    token: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
  };
}
