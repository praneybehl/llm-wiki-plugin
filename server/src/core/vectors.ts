/**
 * Vector leg seam. The WikiDO talks to this interface; production uses
 * Workers AI + Vectorize, tests inject a fake.
 */

import type { Env } from "../env";
import { sha256Hex } from "./hash";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBED_MAX_CHARS = 2000;
/** `MAX_COSINE_DISTANCE = 0.35` in wiki_search.py: keep similarity >= 0.65. */
export const MIN_SIMILARITY = 0.65;
export const VECTOR_QUERY_TOP_K = 100;

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorBackend {
  /** Embeds texts into L2-normalized vectors. */
  embed(texts: string[]): Promise<number[][]>;
  upsert(namespace: string, items: { id: string; values: number[]; metadata: Record<string, string | number> }[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  query(namespace: string, vector: number[], topK: number): Promise<VectorMatch[]>;
}

export function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

export function sectionContentHash(searchable: string): string {
  return sha256Hex(`${EMBED_MODEL}\n${searchable}`);
}

export function sectionVectorId(wiki: string, path: string, sectionIndex: number, contentHash: string): string {
  return sha256Hex(`${wiki}\x1f${path}\x1f${sectionIndex}\x1f${contentHash}`);
}

function isEmbeddingOutput(value: unknown): value is { data: number[][] } {
  return typeof value === "object" && value !== null && "data" in value && Array.isArray(value.data);
}

/** Workers AI + Vectorize backend, or null when either binding is absent. */
export function workersVectorBackend(env: Env): VectorBackend | null {
  const ai = env.AI;
  const index = env.VECTORIZE;
  if (!ai || !index) return null;
  return {
    async embed(texts) {
      const output: unknown = await ai.run(EMBED_MODEL, {
        text: texts.map((text) => text.slice(0, EMBED_MAX_CHARS)),
        pooling: "cls",
      });
      if (!isEmbeddingOutput(output) || output.data.length !== texts.length) {
        throw new Error("embedding model returned an unexpected shape");
      }
      return output.data.map(l2Normalize);
    },
    async upsert(namespace, items) {
      if (items.length === 0) return;
      await index.upsert(items.map((item) => ({ ...item, namespace })));
    },
    async deleteByIds(ids) {
      if (ids.length === 0) return;
      await index.deleteByIds(ids);
    },
    async query(namespace, vector, topK) {
      const result = await index.query(vector, { topK, namespace });
      return result.matches.map((match) => ({ id: match.id, score: match.score }));
    },
  };
}
