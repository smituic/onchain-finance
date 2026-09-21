import { concat, hexToBigInt, numberToHex, type Hex } from "viem";

/**
 * Mirrors @turnkey/viem's serializeSignature: Turnkey's `v` is a yParity
 * proxy (0/1), normalized here to Ethereum's 27/28 (0x1b/0x1c) convention.
 * r/s are parsed as bigints and re-padded to exactly 32 bytes each rather
 * than naively concatenated, since Turnkey does not guarantee left-zero-
 * padded hex strings.
 */
export function serializeTurnkeyRawSignature(result: { r: string; s: string; v: string }): Hex {
  const r = numberToHex(hexToBigInt(`0x${result.r}` as Hex), { size: 32 });
  const s = numberToHex(hexToBigInt(`0x${result.s}` as Hex), { size: 32 });
  const yParity = BigInt(result.v);
  if (yParity !== BigInt(0) && yParity !== BigInt(1)) {
    throw new Error("Turnkey signature v must be yParity 0 or 1.");
  }
  const v = (yParity === BigInt(0) ? "0x1b" : "0x1c") as Hex;
  return concat([r, s, v]);
}
