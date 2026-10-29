/**
 * Optional typed-decision layer (off by default).
 *
 * One client for the System One request format (`{state, questions}` in,
 * `{answers}` out) over four backends: Workers AI, TypeSafe, OpenRouter and
 * Liquid. Builders and readers for the checks that run on the server:
 * D1 search relevance gate, D2 graph evidence check, D5 untrusted-text screen.
 *
 * Every check fails open: a backend error never drops search rows, never
 * blocks a commit and never creates a finding by itself.
 */
import type { Env } from "../env";
import type {
  DecisionBackend,
  DecisionSettings,
  Result,
  SearchResponse,
  SearchRow,
} from "../types";
import questionsJson from "./decision-questions.json";

// ---------------------------------------------------------------------------
// Question templates (byte-identical copy of skills/llm-wiki/assets/decision-questions.json)
// ---------------------------------------------------------------------------

interface ChoiceTemplate {
  id: string;
  question: string;
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
  positive: string;
  default_threshold: number;
  max_text_chars: number;
  pool?: number;
}

interface EvidenceTemplate {
  id: string;
  question: string;
  type: "choice";
  instructions: string;
  none_key: string;
  none_criterion: string;
  sentence_key_prefix: string;
  default_threshold: number;
  max_sentences: number;
  max_sentence_chars: number;
}

interface QuestionsFile {
  version: number;
  checks: {
    relevance: ChoiceTemplate & { pool: number };
    evidence: EvidenceTemplate;
    relation: ChoiceTemplate;
    changes: ChoiceTemplate;
    orders_agent: ChoiceTemplate;
  };
}

export const QUESTIONS = questionsJson as QuestionsFile;

/** Number of search rows the relevance gate scores. */
export const DECISION_POOL: number = QUESTIONS.checks.relevance.pool;

// ---------------------------------------------------------------------------
// Backends and settings
// ---------------------------------------------------------------------------

export const DEFAULT_MODELS: Record<DecisionBackend, string> = {
  "workers-ai": "typesafe/jev-1.14.0",
  typesafe: "jev-1.14.0",
  openrouter: "typesafe/jev-1.14",
  liquid: "d1.1",
};

export const BACKEND_URLS: Record<Exclude<DecisionBackend, "workers-ai">, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
  liquid: "https://api.liquid.ai/decisions/v1/systemone",
};

const KEY_NAMES = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  liquid: "LIQUID_API_KEY",
} as const;

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  enabled: false,
  backend: "workers-ai",
  model: DEFAULT_MODELS["workers-ai"],
  search_gate: false,
  screen_writes: false,
  relevance_threshold: QUESTIONS.checks.relevance.default_threshold,
  screen_threshold: QUESTIONS.checks.orders_agent.default_threshold,
  timeout_ms: 4000,
};

export function defaultModel(backend: DecisionBackend): string {
  return DEFAULT_MODELS[backend];
}

export type DecisionErrorCode =
  | "disabled"
  | "unavailable"
  | "insufficient_credits"
  | "timeout"
  | "http"
  | "invalid_answer"
  | "bad_request";

export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly status?: number;

  constructor(code: DecisionErrorCode, message: string, status?: number) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
    this.status = status;
  }
}

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, unknown>;
}

export interface DecisionResponse {
  answers: Record<string, unknown>;
  backend: DecisionBackend;
  model: string;
  latency_ms: number;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeNoCredits(text: string): boolean {
  return /insufficient[^a-z]*(ai gateway )?credits|\b2021\b.*credit/i.test(text);
}

function toDecisionError(err: unknown): DecisionError {
  if (err instanceof DecisionError) return err;
  const text = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new DecisionError("timeout", "decision backend timed out");
  }
  if (looksLikeNoCredits(text)) return new DecisionError("insufficient_credits", text.slice(0, 300));
  return new DecisionError("unavailable", text.slice(0, 300));
}

function validateRequest(body: unknown): DecisionRequest {
  if (!isRecord(body)) throw new DecisionError("bad_request", "body must be an object with state and questions");
  const { state, questions } = body;
  if (state === undefined || state === null || !(typeof state === "string" || typeof state === "object")) {
    throw new DecisionError("bad_request", "state must be a string, object or array");
  }
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new DecisionError("bad_request", "questions must be a non-empty object");
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!isRecord(q) || typeof q.type !== "string" || typeof q.instructions !== "string") {
      throw new DecisionError("bad_request", `question ${name} needs type and instructions`);
    }
  }
  return { state, questions };
}

function extractAnswers(raw: unknown): Record<string, unknown> {
  // Workers AI may wrap the payload in `result`.
  const payload = isRecord(raw) && !isRecord(raw.answers) && isRecord(raw.result) ? raw.result : raw;
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new DecisionError("invalid_answer", "backend response has no answers object");
  }
  return payload.answers;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DecisionError("timeout", `decision backend timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface AiRunner {
  run(model: string, inputs: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

async function callBackend(env: Env, settings: DecisionSettings, req: DecisionRequest): Promise<unknown> {
  const backend = settings.backend;
  const model = settings.model || DEFAULT_MODELS[backend];
  const controller = new AbortController();
  if (backend === "workers-ai") {
    if (!env.AI) throw new DecisionError("unavailable", "the AI binding is not configured");
    const ai = env.AI as unknown as AiRunner;
    return withTimeout(
      ai.run(model, { state: req.state, questions: req.questions }, { signal: controller.signal }),
      settings.timeout_ms,
      controller,
    );
  }
  const keyName = KEY_NAMES[backend];
  const key = env[keyName];
  if (!key) throw new DecisionError("unavailable", `secret ${keyName} is not set`);
  const run = async (): Promise<unknown> => {
    const res = await fetch(BACKEND_URLS[backend], {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, state: req.state, questions: req.questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = text.slice(0, 300);
      if (res.status === 402 || looksLikeNoCredits(detail)) {
        throw new DecisionError("insufficient_credits", `HTTP ${res.status}: ${detail}`, res.status);
      }
      throw new DecisionError("http", `HTTP ${res.status}: ${detail}`, res.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DecisionError("invalid_answer", "backend response is not JSON");
    }
  };
  return withTimeout(run(), settings.timeout_ms, controller);
}

/**
 * Send one System One request to the configured backend.
 * Throws `DecisionError`; callers that must fail open catch it.
 */
export async function decide(env: Env, settings: DecisionSettings, body: unknown): Promise<DecisionResponse> {
  if (!settings.enabled) throw new DecisionError("disabled", "decision models are not enabled for this wiki");
  const req = validateRequest(body);
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await callBackend(env, settings, req);
  } catch (err) {
    throw toDecisionError(err);
  }
  return {
    answers: extractAnswers(raw),
    backend: settings.backend,
    model: settings.model || DEFAULT_MODELS[settings.backend],
    latency_ms: Date.now() - started,
  };
}

/** `decide` mapped to the RPC `Result` shape for `POST /api/v1/decide`. */
export async function decideResult(env: Env, settings: DecisionSettings, body: unknown): Promise<Result<unknown>> {
  try {
    return { ok: true, value: await decide(env, settings, body) };
  } catch (err) {
    const e = toDecisionError(err);
    if (e.code === "disabled") return { ok: false, status: 403, error: { code: "forbidden", message: e.message } };
    if (e.code === "bad_request") return { ok: false, status: 400, error: { code: "bad_request", message: e.message } };
    return { ok: false, status: 503, error: { code: "unavailable", message: e.message, details: { reason: e.code } } };
  }
}

// ---------------------------------------------------------------------------
// Answer reading
// ---------------------------------------------------------------------------

/**
 * Read a `choice` answer and validate it against the option set the caller sent.
 * Probabilities are restricted to `keys` and renormalized.
 */
export function readChoice(answers: Record<string, unknown>, name: string, keys: string[]): ChoiceAnswer {
  const answer = answers[name];
  if (!isRecord(answer)) throw new DecisionError("invalid_answer", `no answer for ${name}`);
  const choice = answer.choice;
  if (typeof choice !== "string" || !keys.includes(choice)) {
    throw new DecisionError("invalid_answer", `answer for ${name} has an unknown choice`);
  }
  const probabilities: Record<string, number> = {};
  if (isRecord(answer.probabilities)) {
    let total = 0;
    for (const k of keys) {
      if (!(k in answer.probabilities)) continue;
      const p = answer.probabilities[k];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
        throw new DecisionError("invalid_answer", `answer for ${name} has an invalid probability for ${k}`);
      }
      probabilities[k] = p;
      total += p;
    }
    if (Object.keys(probabilities).length > 0) {
      if (!(total > 0) || !Number.isFinite(total)) {
        throw new DecisionError("invalid_answer", `answer for ${name} has probabilities that do not sum to a positive value`);
      }
      for (const k of Object.keys(probabilities)) probabilities[k] = probabilities[k]! / total;
    }
  }
  let confidence = NaN;
  if (answer.confidence !== undefined && answer.confidence !== null) {
    const c = answer.confidence;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      throw new DecisionError("invalid_answer", `answer for ${name} has a confidence outside 0 to 1`);
    }
    confidence = c;
  }
  if (Object.keys(probabilities).length === 0) {
    if (Number.isNaN(confidence)) throw new DecisionError("invalid_answer", `answer for ${name} has no probabilities`);
    probabilities[choice] = confidence;
    if (keys.length === 2) probabilities[keys.find((k) => k !== choice)!] = 1 - confidence;
  }
  if (Number.isNaN(confidence)) confidence = probabilities[choice] ?? 0;
  return { choice, confidence, probabilities };
}

/** Probability of `key` in a choice answer (0 when absent). */
export function probabilityOf(answer: ChoiceAnswer, key: string): number {
  return answer.probabilities[key] ?? 0;
}

// ---------------------------------------------------------------------------
// D1 relevance gate
// ---------------------------------------------------------------------------

export function relevanceRequest(input: { query: string; title: string; heading: string; text: string }): DecisionRequest {
  const t = QUESTIONS.checks.relevance;
  return {
    state: { query: input.query, title: input.title, heading: input.heading, text: input.text.slice(0, t.max_text_chars) },
    questions: { [t.question]: { type: t.type, instructions: t.instructions, criteria: t.criteria } },
  };
}

export function readRelevance(answers: Record<string, unknown>): number {
  const t = QUESTIONS.checks.relevance;
  return probabilityOf(readChoice(answers, t.question, Object.keys(t.criteria)), t.positive);
}

type GateDecision = NonNullable<SearchResponse["decision"]>;

/**
 * Score the first `DECISION_POOL` rows and keep those with P(relevant) >= threshold,
 * in their original order, then return the first `top`. Never throws: on any
 * backend failure it returns the first `top` ungated rows with `failed_open: true`.
 */
export async function gateSearchRows<T extends SearchRow>(
  env: Env,
  settings: DecisionSettings,
  query: string,
  rows: T[],
  opts: { top: number; threshold?: number; textOf?: (row: T) => string },
): Promise<{ rows: T[]; decision: GateDecision }> {
  const threshold = opts.threshold ?? settings.relevance_threshold;
  const pool = rows.slice(0, DECISION_POOL);
  const model = settings.model || DEFAULT_MODELS[settings.backend];
  const started = Date.now();
  const textOf = opts.textOf ?? ((row: T) => row.snippet);
  try {
    if (!settings.enabled) throw new DecisionError("disabled", "decision models are not enabled for this wiki");
    const scores = await Promise.all(
      pool.map(async (row) => {
        const res = await decide(env, settings, relevanceRequest({
          query,
          title: row.title,
          heading: row.heading_path.join(" > "),
          text: textOf(row),
        }));
        return readRelevance(res.answers);
      }),
    );
    const kept: T[] = [];
    pool.forEach((row, i) => {
      const relevant = scores[i]!;
      if (relevant >= threshold) {
        kept.push({ ...row, decision: { relevant: round4(relevant), backend: settings.backend, model } });
      }
    });
    return {
      rows: kept.slice(0, opts.top),
      decision: {
        backend: settings.backend,
        model,
        threshold,
        pool: pool.length,
        kept: kept.length,
        dropped: pool.length - kept.length,
        failed_open: false,
        latency_ms: Date.now() - started,
      },
    };
  } catch (err) {
    const e = toDecisionError(err);
    const out = rows.slice(0, opts.top);
    return {
      rows: out,
      decision: {
        backend: settings.backend,
        model,
        threshold,
        pool: pool.length,
        kept: out.length,
        dropped: 0,
        failed_open: true,
        latency_ms: Date.now() - started,
        error: e.code,
      },
    };
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// D2 evidence check
// ---------------------------------------------------------------------------

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when `evidence` occurs in `body` (whitespace-normalized, case-insensitive). */
export function evidenceInText(evidence: string, body: string): boolean {
  const needle = normalizeForMatch(evidence);
  if (!needle) return false;
  return normalizeForMatch(body).includes(needle);
}

const FENCE_RE = /^\s*(```|~~~)/;
const BLOCK_PREFIX_RE = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;
const SENTENCE_END_RE = /(?<=[.!?])\s+/;

/**
 * Split Markdown text into sentences. Headings, list items and quotes are their own
 * blocks; other consecutive lines form one paragraph. Fenced code and frontmatter
 * delimiters are skipped. Mirrors `split_sentences` in `wiki_decide.py`.
 */
export function splitSentences(text: string, max = 60, maxChars = 300): string[] {
  const blocks: string[] = [];
  let para: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (para.length) blocks.push(para.join(" "));
    para = [];
  };
  for (const rawLine of text.split("\n")) {
    if (FENCE_RE.test(rawLine)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.trim();
    if (!line || line === "---") {
      flush();
      continue;
    }
    if (BLOCK_PREFIX_RE.test(line)) {
      flush();
      blocks.push(line.replace(BLOCK_PREFIX_RE, ""));
      continue;
    }
    para.push(line);
  }
  flush();
  const out: string[] = [];
  for (const block of blocks) {
    for (const piece of block.split(SENTENCE_END_RE)) {
      const s = piece.replace(/\s+/g, " ").trim();
      if (!s) continue;
      out.push(s.slice(0, maxChars));
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function evidenceRequest(input: { claim: string; evidence: string; sentences: string[] }): DecisionRequest {
  const t = QUESTIONS.checks.evidence;
  const criteria: Record<string, string> = {};
  input.sentences.forEach((s, i) => {
    criteria[`${t.sentence_key_prefix}${i + 1}`] = s;
  });
  criteria[t.none_key] = t.none_criterion;
  return {
    state: { claim: input.claim, evidence: input.evidence },
    questions: { [t.question]: { type: t.type, instructions: t.instructions, criteria } },
  };
}

export type EvidenceVerdict =
  | {
      supported: boolean;
      choice: string;
      confidence: number;
      sentence: string | null;
      threshold: number;
      backend: string;
      model: string;
      latency_ms: number;
    }
  | { error: string };

/**
 * D2: ask which source sentence states the claim. `supported` is false when
 * `none` wins or the confidence is below the threshold. Never throws.
 */
export async function checkEvidence(
  env: Env,
  settings: DecisionSettings,
  input: { source: string; body: string; evidence: string; edge: string; threshold?: number },
): Promise<EvidenceVerdict> {
  const t = QUESTIONS.checks.evidence;
  const threshold = input.threshold ?? t.default_threshold;
  const model = settings.model || DEFAULT_MODELS[settings.backend];
  if (evidenceInText(input.evidence, input.body)) {
    return { supported: true, choice: "quote", confidence: 1, sentence: null, threshold, backend: settings.backend, model, latency_ms: 0 };
  }
  const sentences = splitSentences(input.body, t.max_sentences, t.max_sentence_chars);
  if (sentences.length === 0) {
    return { supported: false, choice: t.none_key, confidence: 1, sentence: null, threshold, backend: settings.backend, model, latency_ms: 0 };
  }
  try {
    const req = evidenceRequest({ claim: input.edge, evidence: input.evidence, sentences });
    const res = await decide(env, settings, req);
    const keys = [...sentences.map((_, i) => `${t.sentence_key_prefix}${i + 1}`), t.none_key];
    const ans = readChoice(res.answers, t.question, keys);
    const idx = ans.choice === t.none_key ? -1 : Number(ans.choice.slice(t.sentence_key_prefix.length)) - 1;
    return {
      supported: ans.choice !== t.none_key && ans.confidence >= threshold,
      choice: ans.choice,
      confidence: round4(ans.confidence),
      sentence: idx >= 0 ? sentences[idx] ?? null : null,
      threshold,
      backend: res.backend,
      model: res.model,
      latency_ms: res.latency_ms,
    };
  } catch (err) {
    return { error: toDecisionError(err).code };
  }
}

// ---------------------------------------------------------------------------
// D5 untrusted-text screen
// ---------------------------------------------------------------------------

export function screenRequest(input: { path: string; text: string }): DecisionRequest {
  const t = QUESTIONS.checks.orders_agent;
  return {
    state: { path: input.path, text: input.text.slice(0, t.max_text_chars) },
    questions: { [t.question]: { type: t.type, instructions: t.instructions, criteria: t.criteria } },
  };
}

export function readScreen(answers: Record<string, unknown>): number {
  const t = QUESTIONS.checks.orders_agent;
  return probabilityOf(readChoice(answers, t.question, Object.keys(t.criteria)), t.positive);
}

/**
 * D5: P(text gives orders to an AI system). Returns null when decisions are off or
 * the backend fails. The caller creates an `untrusted_text` review flag when
 * `flagged`; it never blocks a commit.
 */
export async function screenText(
  env: Env,
  settings: DecisionSettings,
  input: { path: string; text: string },
): Promise<{ score: number; flagged: boolean; threshold: number; backend: string; model: string; latency_ms: number } | null> {
  if (!settings.enabled) return null;
  try {
    const res = await decide(env, settings, screenRequest(input));
    const score = readScreen(res.answers);
    return {
      score: round4(score),
      flagged: score >= settings.screen_threshold,
      threshold: settings.screen_threshold,
      backend: res.backend,
      model: res.model,
      latency_ms: res.latency_ms,
    };
  } catch {
    return null;
  }
}
