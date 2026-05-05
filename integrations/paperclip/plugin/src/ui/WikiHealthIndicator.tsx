import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { injectWikiStyles } from "./styles.js";
import { wikiHref } from "./href.js";

/**
 * Operators see this on the dashboard. Four auto-detectable signals
 * answer "is your wiki set up well enough that agents will get good
 * results?":
 *
 *   1. Wiki resolvable (path exists)
 *   2. Wiki has at least one page
 *   3. The plugin's wiki.query agent tool is registered (always true
 *      once the plugin loads — counts toward N because operators
 *      should know it's already wired and not have to do anything)
 *   4. Lint status is "pass"
 *
 * The badge stays until the user dismisses it once the four are
 * complete. Dismissal is sessionStorage-scoped so it doesn't leak
 * across browser sessions; if anything regresses (lint fails on a new
 * page, etc.) it reappears.
 */

const SETUP_DISMISSED_KEY = "llm-wiki:setup-dismissed";

interface SetupStep {
  label: string;
  ok: boolean;
}

function setupSteps(data: WikiHealth): SetupStep[] {
  return [
    { label: "Wiki resolved", ok: !data.wikiPathMissing },
    { label: "At least one page", ok: data.pageCount > 0 },
    { label: "Tool registered", ok: true },
    { label: "Lint passing", ok: data.lintStatus === "pass" },
  ];
}

interface WikiHealth {
  pageCount: number;
  indexLines: number;
  linkDensity: number;
  scalingMessages: string[];
  lintStatus: "pass" | "warn" | "fail";
  lintFindings: { totalPages?: number } | null;
  wikiPathMissing: boolean;
  lintCheckIntervalMinutes: number;
}

function HealthCard({ context }: PluginWidgetProps): React.ReactElement {
  const { data, loading, error, refresh } = usePluginData<WikiHealth>(
    "wikiHealth",
    {
      companyId: context.companyId,
      projectId: context.projectId,
    },
  );

  // Auto-refresh on the operator-configured interval. The worker
  // includes the value in the payload (sourced from
  // instanceConfigSchema.lint_check_interval_minutes, default 60,
  // clamped >= 5). We only schedule once data arrives — no point
  // polling while loading or in error state.
  const intervalMinutes = data?.lintCheckIntervalMinutes;
  React.useEffect(() => {
    if (intervalMinutes === undefined) return;
    const ms = Math.max(60_000, intervalMinutes * 60_000);
    const id = setInterval(() => refresh(), ms);
    return () => clearInterval(id);
  }, [intervalMinutes, refresh]);

  if (context.companyId === null) {
    return (
      <div className="llm-wiki-health">
        <header>Wiki health</header>
        <p>No Company is currently in scope.</p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="llm-wiki-health" data-state="error">
        <header>Wiki health</header>
        <p className="llm-wiki-error">Error: {error.message}</p>
      </div>
    );
  }

  if (loading || data === null) {
    return (
      <div className="llm-wiki-health" data-state="loading">
        <header>Wiki health</header>
        <p>Loading…</p>
      </div>
    );
  }

  if (data.wikiPathMissing) {
    return (
      <div className="llm-wiki-health" data-state="missing">
        <header>Wiki health</header>
        <p>Wiki path not configured for this Company.</p>
        <p className="llm-wiki-hint">
          Run <code>/wiki:init</code> from any agent in this Company, or open{" "}
          <a
            href={wikiHref(context.companyPrefix, { kind: "setup" })}
            data-testid="wiki-health-missing-setup-link"
          >
            Setup
          </a>{" "}
          for the full runbook.
        </p>
      </div>
    );
  }

  return (
    <div className="llm-wiki-health" data-state="ok">
      <header>Wiki health</header>
      <SetupStatusBanner
        data={data}
        companyPrefix={context.companyPrefix}
      />
      <dl className="llm-wiki-health-stats">
        <dt>Pages</dt>
        <dd>{data.pageCount}</dd>
        <dt>Lint</dt>
        <dd>
          <span
            className="llm-wiki-status-badge"
            data-lint-status={data.lintStatus}
          >
            {data.lintStatus}
          </span>
        </dd>
        <dt>Link density</dt>
        <dd>{data.linkDensity.toFixed(1)} per page</dd>
      </dl>
      {data.scalingMessages.length > 0 ? (
        <ul className="llm-wiki-scaling-messages">
          {data.scalingMessages.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SetupStatusBanner({
  data,
  companyPrefix,
}: {
  data: WikiHealth;
  companyPrefix: string | null;
}): React.ReactElement | null {
  const steps = setupSteps(data);
  const completed = steps.filter((s) => s.ok).length;
  const total = steps.length;
  const allOk = completed === total;

  const [dismissed, setDismissed] = React.useState<boolean>(() =>
    isDismissed(),
  );

  if (allOk && dismissed) return null;

  if (allOk) {
    return (
      <div
        className="llm-wiki-health-setup llm-wiki-health-setup-ok"
        data-testid="wiki-health-setup-banner"
      >
        <span
          className="llm-wiki-status-badge"
          data-lint-status="pass"
          data-testid="wiki-health-setup-badge"
        >
          ✅ Setup complete
        </span>
        <button
          type="button"
          className="llm-wiki-back"
          onClick={() => {
            window.sessionStorage.setItem(SETUP_DISMISSED_KEY, "1");
            setDismissed(true);
          }}
          data-testid="wiki-health-setup-dismiss"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      className="llm-wiki-health-setup llm-wiki-health-setup-incomplete"
      data-testid="wiki-health-setup-banner"
    >
      <span
        className="llm-wiki-status-badge"
        data-lint-status="warn"
        data-testid="wiki-health-setup-badge"
      >
        🟡 Setup: {completed}/{total} steps complete
      </span>
      <a
        href={wikiHref(companyPrefix, { kind: "setup" })}
        data-testid="wiki-health-setup-link"
      >
        Open setup →
      </a>
    </div>
  );
}

function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SETUP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function WikiHealthIndicator(
  props: PluginWidgetProps,
): React.ReactElement {
  React.useEffect(() => injectWikiStyles(), []);
  return (
    <ErrorBoundary>
      <HealthCard {...props} />
    </ErrorBoundary>
  );
}
