import * as React from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { wikiHref } from "../href.js";
import { HostLink } from "../HostLink.js";

/**
 * Sidebar entry point — a single nav row that visually matches
 * Paperclip's own SidebarNavItem (Dashboard / Inbox / Issues / …):
 * same Tailwind classes for spacing, typography, and hover/active
 * states, same `h-4 w-4` Lucide-style icon, same active-route
 * highlighting. Anything richer (search, recents, browse, health)
 * lives in the workspace itself.
 *
 * The Tailwind classes used here (`text-foreground/80`, `bg-accent`,
 * etc.) are already compiled into the host's stylesheet because
 * `SidebarNavItem` references them — we can borrow the same names
 * without re-shipping any CSS.
 */

const NAV_BASE =
  "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors";
const NAV_INACTIVE = "text-foreground/80 hover:bg-accent/50 hover:text-foreground";
const NAV_ACTIVE = "bg-accent text-foreground";

function isCurrentRoute(
  pathname: string,
  companyPrefix: string | null,
): boolean {
  if (companyPrefix === null) return false;
  const base = `/${companyPrefix}/llm-wiki`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

function useIsCurrent(companyPrefix: string | null): boolean {
  const read = React.useCallback(
    () =>
      typeof window === "undefined"
        ? false
        : isCurrentRoute(window.location.pathname, companyPrefix),
    [companyPrefix],
  );
  const [isCurrent, setIsCurrent] = React.useState(read);
  React.useEffect(() => {
    function update(): void {
      setIsCurrent(read());
    }
    update();
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, [read]);
  return isCurrent;
}

export interface LauncherProps {
  context: PluginHostContext;
}

export function Launcher({ context }: LauncherProps): React.ReactElement | null {
  const isCurrent = useIsCurrent(context.companyPrefix);
  if (context.companyId === null) return null;
  const className = `${NAV_BASE} ${isCurrent ? NAV_ACTIVE : NAV_INACTIVE}`;
  return (
    <HostLink
      href={wikiHref(context.companyPrefix, { kind: "landing" })}
      className={className}
      aria-current={isCurrent ? "page" : undefined}
      data-testid="wiki-open"
    >
      <span className="relative shrink-0" aria-hidden="true">
        <BookIcon />
      </span>
      <span className="flex-1 truncate">LLM Wiki</span>
    </HostLink>
  );
}

/**
 * Lucide-style "book" icon, inlined because lucide-react is not
 * exposed by the Paperclip plugin React shim. The path data and
 * stroke conventions mirror lucide@0.x's book icon so the visual
 * weight matches the host's other nav icons.
 */
function BookIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
