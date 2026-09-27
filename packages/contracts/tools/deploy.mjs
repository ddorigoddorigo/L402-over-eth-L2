#!/usr/bin/env node
/**
 * Deploys the escrow without Foundry, using viem.
 *
 *   DEPLOYER_PRIVATE_KEY=0x... CHAIN=base-sepolia RPC_URL=https://... \
 *   ESCROW_OWNER=0x... node tools/deploy.mjs
 *
 * Variables left empty (or set to the `0x` placeholder of .env.example) fall back
 * to their defaults: owner = deployer, fee recipient = owner, fee = 0.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(resolve(HERE, "../artifacts/L402Escrow.json"), "utf8"));

const CHAIN_ALIASES = {
  base: chains.base,
  "base-sepolia": chains.baseSepolia,
  arbitrum: chains.arbitrum,
  "arbitrum-sepolia": chains.arbitrumSepolia,
  optimism: chains.optimism,
  "optimism-sepolia": chains.optimismSepolia,
};

/** Reads an env var, treating "" and the `0x` placeholder as "not set". */
function env(name) {
  const value = process.env[name]?.trim();
  return value && value !== "0x" ? value : undefined;
}

function addressFromEnv(name, fallback) {
  const value = env(name);
  if (value === undefined) return fallback;
  if (!isAddress(value)) throw new Error(`${name} is not a valid address: ${value}`);
  return getAddress(value);
}

const chainKey = env("CHAIN") ?? "base-sepolia";
const chain = CHAIN_ALIASES[chainKey];
if (!chain) throw new Error(`Unknown CHAIN: ${chainKey}. Valid values: ${Object.keys(CHAIN_ALIASES).join(", ")}`);

const privateKey = env("DEPLOYER_PRIVATE_KEY");
if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is missing");

const account = privateKeyToAccount(privateKey);
const owner = addressFromEnv("ESCROW_OWNER", account.address);
const feeRecipient = addressFromEnv("FEE_RECIPIENT", owner);
const feeBps = Number(env("PROTOCOL_FEE_BPS") ?? 0);
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500) {
  throw new Error(`PROTOCOL_FEE_BPS must be an integer between 0 and 500, got ${env("PROTOCOL_FEE_BPS")}`);
}

const transport = http(env("RPC_URL"));
const publicClient = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

console.log(`Deploying L402Escrow on ${chain.name} (chainId ${chain.id})`);
console.log(`  deployer      ${account.address}`);
console.log(`  owner         ${owner}`);
console.log(`  feeRecipient  ${feeRecipient}`);
console.log(`  feeBps        ${feeBps}`);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [owner, feeRecipient, feeBps],
});
console.log(`  tx            ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`Deployment reverted (tx ${hash})`);
console.log(`\n✅ L402Escrow: ${receipt.contractAddress}`);
console.log(`   gas used: ${receipt.gasUsed}`);
console.log(`\nAdd to your .env:\n  ESCROW_ADDRESS=${receipt.contractAddress}\n  CHAIN_ID=${chain.id}`);
