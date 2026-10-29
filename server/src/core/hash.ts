import { createHash, randomBytes } from "node:crypto";

/** SHA-256 hex of the UTF-8 bytes of `text`. Synchronous so it runs inside `transactionSync`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `n` random bytes as base64url without padding. */
export function randomBase64Url(n: number): string {
  return randomBytes(n).toString("base64url");
}

export function randomHex(n: number): string {
  return randomBytes(n).toString("hex");
}
