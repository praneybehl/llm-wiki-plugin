import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Registry } from "./do/registry";
import type { WikiDO } from "./do/wiki";

/** Bindings for the LLM Wiki Worker. Optional bindings degrade features, never break them. */
export interface Env {
  WIKI: DurableObjectNamespace<WikiDO>;
  REGISTRY: DurableObjectNamespace<Registry>;
  OAUTH_KV: KVNamespace;
  /** Raw source storage. Absent: raw endpoints answer 503 and raw stays on agent machines. */
  RAW?: R2Bucket;
  /** Vector leg of hybrid search. Absent: search is lexical only. */
  VECTORIZE?: VectorizeIndex;
  /** Embeddings and the optional Jev decision backend. */
  AI?: Ai;
  ADMIN_TOKEN: string;
  /** Optional decision backend keys (only for non-Workers-AI backends). */
  TYPESAFE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  LIQUID_API_KEY?: string;
  /** Optional override of the delay between alarm steps, in milliseconds. */
  LLM_WIKI_ALARM_DELAY_MS?: string;
  /** Injected by OAuthProvider for the default handler. */
  OAUTH_PROVIDER?: OAuthHelpers;
}
