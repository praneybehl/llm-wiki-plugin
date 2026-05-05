import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import {
  ADAPTERS,
  HEARTBEAT_STANZA,
  HTTP_AGENT_SYSTEM_PROMPT,
} from "./snippets.js";

/**
 * Setup walkthrough — the loop the plugin closes between "I installed
 * the plugin" and "my agents actually use the wiki." The plugin's
 * sandbox can't auto-install the agent-side skill or modify each
 * agent's heartbeat instructions, so this view lays out the steps in
 * one place with copy-paste-ready blocks and a live verifier.
 */

interface VerifySetupPayload {
  wiki: { found: boolean; path: string | null; pageCount: number };
  tool: { registered: boolean };
  sample: { query: string; resultCount: number; durationMs: number };
}

export interface SetupViewProps {
  context: PluginHostContext;
}

export function SetupView({ context }: SetupViewProps): React.ReactElement {
  const { data, loading, error, refresh } = usePluginData<VerifySetupPayload>(
    "verifySetup",
    {
      companyId: context.companyId,
      projectId: context.projectId,
    },
  );

  return (
    <section className="llm-wiki-setup">
      <header>
        <h2>LLM Wiki — Setup</h2>
        <p className="llm-wiki-empty">
          The plugin runs read-only inside Paperclip's sandbox, so it can't
          install the agent-side skill or modify any agent's heartbeat
          instructions for you. Below is the runbook with copy-paste-ready
          blocks and a live verifier.
        </p>
      </header>

      <ChecklistItem
        n={1}
        title="Wiki content"
        status={
          error
            ? "error"
            : loading || !data
              ? "loading"
              : data.wiki.found
                ? "ok"
                : "missing"
        }
      >
        {data?.wiki.found ? (
          <p>
            Wiki found at <code>{data.wiki.path ?? "(unknown)"}</code> —{" "}
            <strong>{data.wiki.pageCount} pages</strong>.
          </p>
        ) : (
          <p>
            No wiki yet for this Company. From any agent in the Company, run{" "}
            <code>/wiki:init</code> (Claude Code) or invoke the{" "}
            <code>llm-wiki</code> skill by natural language ("initialize a
            wiki here") to scaffold it. The skill creates{" "}
            <code>wiki/</code> in the Company's primary workspace.
          </p>
        )}
      </ChecklistItem>

      <ChecklistItem
        n={2}
        title="The plugin's wiki.query tool — already wired"
        status={
          loading || !data
            ? "loading"
            : data.tool.registered && data.sample.resultCount >= 0
              ? "ok"
              : "warn"
        }
      >
        <p>
          The plugin registers <code>wiki.query</code> for every agent in
          this Company on install. No manual step.
        </p>
        {data ? (
          <p className="llm-wiki-empty">
            Sample query "{data.sample.query}" → {data.sample.resultCount}{" "}
            result(s) in {data.sample.durationMs} ms.
          </p>
        ) : null}
        <button
          type="button"
          className="llm-wiki-back"
          onClick={() => refresh()}
        >
          Re-run verifier
        </button>
      </ChecklistItem>

      <ChecklistItem
        n={3}
        title="Agent-side skill (for adapters that author the wiki)"
        status="info"
      >
        <p>
          Run the install command for whichever adapter your Company uses.
          The plugin can't reach <code>~/.claude/skills/</code> or other
          adapter dirs from inside Paperclip's sandbox, so this is on you.
        </p>
        <ul className="llm-wiki-setup-adapters">
          {ADAPTERS.map((a) => (
            <li key={a.id}>
              <div className="llm-wiki-setup-adapter-row">
                <strong>{a.displayName}</strong>
                <span className="llm-wiki-empty">→ {a.memoryFile}</span>
              </div>
              <CopyBlock
                value={a.installCommand}
                testId={`wiki-setup-install-${a.id}`}
              />
            </li>
          ))}
        </ul>
      </ChecklistItem>

      <ChecklistItem
        n={4}
        title="Heartbeat stanza"
        status="info"
      >
        <p>
          Append this to each agent's memory file (
          <code>CLAUDE.md</code> / <code>AGENTS.md</code> /{" "}
          <code>GEMINI.md</code>) so it's present every heartbeat:
        </p>
        <CopyBlock value={HEARTBEAT_STANZA} testId="wiki-setup-stanza" />
      </ChecklistItem>

      <ChecklistItem
        n={5}
        title="HTTP-only agents (no skill loaded)"
        status="info"
      >
        <p>
          For Hermes Agent or any custom HTTP/webhook agent that doesn't
          load the skill, the <code>wiki.query</code> tool is the only
          path. Add this to the agent's system prompt:
        </p>
        <CopyBlock
          value={HTTP_AGENT_SYSTEM_PROMPT}
          testId="wiki-setup-http-prompt"
        />
      </ChecklistItem>
    </section>
  );
}

function ChecklistItem({
  n,
  title,
  status,
  children,
}: {
  n: number;
  title: string;
  status: "ok" | "warn" | "missing" | "error" | "loading" | "info";
  children: React.ReactNode;
}): React.ReactElement {
  const symbol =
    status === "ok"
      ? "✅"
      : status === "warn" || status === "missing"
        ? "🟡"
        : status === "error"
          ? "❌"
          : status === "loading"
            ? "…"
            : "•";
  return (
    <section className="llm-wiki-setup-step" data-status={status}>
      <h3>
        <span aria-hidden="true">{symbol}</span> {n}. {title}
      </h3>
      <div className="llm-wiki-setup-step-body">{children}</div>
    </section>
  );
}

function CopyBlock({
  value,
  testId,
}: {
  value: string;
  testId: string;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API may be unavailable in some hosts; fall through.
    }
  }, [value]);
  return (
    <div className="llm-wiki-setup-copy" data-testid={testId}>
      <pre>
        <code>{value}</code>
      </pre>
      <button type="button" className="llm-wiki-back" onClick={onCopy}>
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}
