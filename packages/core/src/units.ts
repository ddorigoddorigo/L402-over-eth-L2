/**
 * Conversions between token base units and human-readable values.
 *
 * An L402-EL2 price is ALWAYS expressed in base units (for cbBTC: satoshis).
 * Never use floats for amounts: 0.1 + 0.2 !== 0.3, and this is money.
 */

/** base units -> decimal string (1500n with 8 decimals -> "0.000015"). */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** decimal string -> base units. Rejects more fractional digits than the token has. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === "." || trimmed === "-") {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const negative = trimmed.startsWith("-");
  const [wholeRaw = "0", fractionRaw = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  if (fractionRaw.length > decimals) {
    throw new Error(`"${value}" has more than ${decimals} decimals: funds would be lost`);
  }
  const padded = fractionRaw.padEnd(decimals, "0");
  const result = BigInt(wholeRaw || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return negative ? -result : result;
}

/** Shorthand for prices in satoshis (cbBTC/WBTC have 8 decimals). */
export const sats = (n: number | bigint): bigint => BigInt(n);

/** Rough USD value of an amount given the BTC price. For logs/UI only. */
export function toUsd(amount: bigint, decimals: number, btcPriceUsd: number): number {
  return Number(formatUnits(amount, decimals)) * btcPriceUsd;
}
