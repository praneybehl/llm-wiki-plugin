// Minimal types for the `node:crypto` subset the Worker uses (nodejs_compat).
// The package does not depend on @types/node; keep this list small.
declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array, encoding?: "utf8"): Hash;
    digest(encoding: "hex" | "base64" | "base64url"): string;
  }
  interface RandomBuffer extends Uint8Array {
    toString(encoding: "hex" | "base64" | "base64url"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomBytes(size: number): RandomBuffer;
}
