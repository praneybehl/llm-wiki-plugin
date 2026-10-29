/** Registry: singleton Durable Object (name "registry") that lists the wikis of a deployment. */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { Result } from "../types";
import { REGISTRY_SCHEMA } from "./schema";
import { WIKI_ID_RE } from "./wiki";

interface WikiRow extends Record<string, SqlStorageValue> {
  id: string;
  created_at: string;
  created_by: string;
}

export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of REGISTRY_SCHEMA) this.sql.exec(statement);
    });
  }

  async createWiki(id: string, createdBy: string): Promise<Result<{ id: string; created: boolean }>> {
    if (typeof id !== "string" || !WIKI_ID_RE.test(id)) {
      return {
        ok: false,
        status: 400,
        error: { code: "bad_request", message: "wiki id must match ^[a-z0-9][a-z0-9-]{0,62}$" },
      };
    }
    const written = this.sql.exec(
      "INSERT OR IGNORE INTO wikis (id, created_at, created_by) VALUES (?, ?, ?)",
      id,
      new Date().toISOString(),
      typeof createdBy === "string" ? createdBy : "",
    ).rowsWritten;
    return { ok: true, value: { id, created: written > 0 } };
  }

  async listWikis(): Promise<{ id: string; created_at: string; created_by: string }[]> {
    return this.sql.exec<WikiRow>("SELECT id, created_at, created_by FROM wikis ORDER BY id").toArray();
  }

  async hasWiki(id: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 AS x FROM wikis WHERE id = ?", id).toArray().length > 0;
  }
}
