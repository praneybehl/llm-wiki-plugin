import { env, runInDurableObject } from "cloudflare:test";
import corpus from "../core/fixtures/corpus.json";
import type { VectorBackend, VectorMatch } from "../../src/core/vectors";
import type { WikiDO } from "../../src/do/wiki";
import type { CommitOp } from "../../src/types";

type Failure = { ok: false; status: number; error: { code: string; message: string; details?: unknown } };

/**
 * RPC stubs type the failure branch of `Result` as `never` (its `details: unknown`
 * is not RPC-serializable in workers-types). These helpers read it anyway.
 */
export function failure(result: unknown): Failure {
  return result as Failure;
}

export function statusOf(result: unknown): number {
  const r = result as { ok: true } | Failure;
  return r.ok ? 0 : r.status;
}

let counter = 0;

/** A fresh, set-up wiki stub with a unique id. */
export async function freshWiki(prefix = "t"): Promise<{ id: string; wiki: DurableObjectStub<WikiDO> }> {
  const id = `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const wiki = env.WIKI.get(env.WIKI.idFromName(id));
  await wiki.setup(id);
  return { id, wiki };
}

export const corpusFiles = corpus.files as Record<string, string>;

export async function importCorpus(wiki: DurableObjectStub<WikiDO>): Promise<void> {
  const ops: CommitOp[] = Object.entries(corpusFiles).map(([path, content]) => ({ op: "upsert", path, content }));
  const result = await wiki.commit("importer", { message: "import corpus", ops });
  if (!result.ok) throw new Error(JSON.stringify(failure(result).error));
}

const DIM = 64;

function embedText(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
    vector[(h >>> 0) % DIM]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/** In-memory Vectorize + embedding model: hashed bag of words, cosine similarity. */
export class FakeVectors implements VectorBackend {
  readonly store = new Map<string, { namespace: string; values: number[] }>();
  embedCalls = 0;
  upsertCalls = 0;
  failNext = false;
  /** Accept the next upsert calls without storing them, like the lost Vectorize mutation. */
  dropUpserts = 0;
  /** Optional override for query results (ids with scores), used to pin ranks. */
  pinned: VectorMatch[] | null = null;

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake embedding failure");
    }
    return texts.map(embedText);
  }

  async upsert(namespace: string, items: { id: string; values: number[] }[]): Promise<void> {
    this.upsertCalls++;
    if (this.dropUpserts > 0) {
      this.dropUpserts--;
      return;
    }
    for (const item of items) this.store.set(item.id, { namespace, values: item.values });
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.store.delete(id);
  }

  async getByIds(ids: string[]): Promise<string[]> {
    return ids.filter((id) => this.store.has(id));
  }

  async query(namespace: string, vector: number[], topK: number): Promise<VectorMatch[]> {
    if (this.pinned) return this.pinned;
    // Hashed bag-of-words cosine is low for short queries; map it into
    // [0.65, 1] so every stored vector passes the similarity floor.
    return [...this.store.entries()]
      .filter(([, v]) => v.namespace === namespace)
      .map(([id, v]) => ({ id, score: 0.65 + 0.35 * v.values.reduce((sum, x, i) => sum + x * vector[i]!, 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** Moves the send and check times of sent (unconfirmed) vectors back by `ms`, as if that time had passed. */
export async function ageSentVectors(wiki: DurableObjectStub<WikiDO>, ms: number): Promise<void> {
  await runInDurableObject(wiki, (_instance: WikiDO, state) => {
    state.storage.sql.exec("UPDATE sections SET vec_sent_at = vec_sent_at - ?, vec_checked_at = vec_checked_at - ? WHERE vec_state = 1", ms, ms);
  });
}

export async function attachVectors(wiki: DurableObjectStub<WikiDO>, backend: VectorBackend | null): Promise<void> {
  await runInDurableObject(wiki, (instance: WikiDO) => {
    instance.useVectorBackend(backend);
  });
}

export async function sql<T = Record<string, unknown>>(wiki: DurableObjectStub<WikiDO>, query: string, ...args: unknown[]): Promise<T[]> {
  return runInDurableObject(wiki, (_instance: WikiDO, state) => state.storage.sql.exec(query, ...args).toArray() as T[]);
}
