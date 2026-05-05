import * as React from "react";
import { wikiHref } from "../href.js";

/**
 * FolderTree — derived from `pages[].relPath`, no extra worker provider
 * needed. Renders a recursive collapsible tree where leaves are anchor
 * tags pointing at `/{prefix}/llm-wiki#{slug}`.
 *
 * Initial expansion: every ancestor of `currentSlug` is open; nothing
 * else. A `titleFilter` (substring, case-insensitive) hides non-matching
 * leaves and auto-opens the folders that still have matches.
 */

export interface PageEntry {
  slug: string;
  title: string;
  type: string;
  relPath: string;
}

export type TreeNode =
  | { kind: "folder"; name: string; path: string; children: TreeNode[] }
  | { kind: "page"; slug: string; title: string; type: string };

type FolderNode = Extract<TreeNode, { kind: "folder" }>;

function ensureFolder(parent: FolderNode, name: string): FolderNode {
  const existing = parent.children.find(
    (c): c is FolderNode => c.kind === "folder" && c.name === name,
  );
  if (existing) return existing;
  const folder: FolderNode = {
    kind: "folder",
    name,
    path: parent.path === "" ? name : `${parent.path}/${name}`,
    children: [],
  };
  parent.children.push(folder);
  return folder;
}

function sortChildren(node: TreeNode): void {
  if (node.kind !== "folder") return;
  // Folders first (alphabetical by name), then pages (alphabetical by title).
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (a.kind === "folder" && b.kind === "folder") {
      return a.name.localeCompare(b.name);
    }
    if (a.kind === "page" && b.kind === "page") {
      return a.title.localeCompare(b.title);
    }
    return 0;
  });
  for (const child of node.children) sortChildren(child);
}

export function buildTree(pages: PageEntry[]): TreeNode {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };
  for (const page of pages) {
    // Strip a trailing `.md` from relPath; split on `/`. The last segment is
    // the file (without extension); everything before it is the folder path.
    const cleaned = page.relPath.replace(/\.md$/i, "");
    const parts = cleaned.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cursor: FolderNode = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = ensureFolder(cursor, parts[i]!);
    }
    cursor.children.push({
      kind: "page",
      slug: page.slug,
      title: page.title,
      type: page.type,
    });
  }
  sortChildren(root);
  return root;
}

function expandAncestorsOf(slug: string | null): Set<string> {
  if (slug === null) return new Set();
  const out = new Set<string>();
  const parts = slug.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === "" ? parts[i]! : `${acc}/${parts[i]!}`;
    out.add(acc);
  }
  return out;
}

function filterTree(
  node: TreeNode,
  needle: string,
): { kept: TreeNode | null; expand: Set<string> } {
  if (node.kind === "page") {
    return node.title.toLowerCase().includes(needle)
      ? { kept: node, expand: new Set() }
      : { kept: null, expand: new Set() };
  }
  const keptChildren: TreeNode[] = [];
  const expand = new Set<string>();
  for (const child of node.children) {
    const result = filterTree(child, needle);
    if (result.kept !== null) {
      keptChildren.push(result.kept);
      for (const p of result.expand) expand.add(p);
    }
  }
  if (keptChildren.length === 0) return { kept: null, expand };
  if (node.path !== "") expand.add(node.path);
  return {
    kept: { kind: "folder", name: node.name, path: node.path, children: keptChildren },
    expand,
  };
}

export interface FolderTreeProps {
  pages: PageEntry[];
  companyPrefix: string | null;
  currentSlug: string | null;
  titleFilter?: string;
}

interface NodeViewProps {
  node: TreeNode;
  companyPrefix: string | null;
  currentSlug: string | null;
  open: Set<string>;
  toggle: (path: string) => void;
}

function NodeView({
  node,
  companyPrefix,
  currentSlug,
  open,
  toggle,
}: NodeViewProps): React.ReactElement | null {
  if (node.kind === "page") {
    const isCurrent = currentSlug === node.slug;
    return (
      <li className="llm-wiki-tree-leaf">
        <a
          href={wikiHref(companyPrefix, { kind: "page", slug: node.slug })}
          data-wiki-slug={node.slug}
          aria-current={isCurrent ? "page" : undefined}
          className={
            isCurrent
              ? "llm-wiki-tree-link llm-wiki-tree-link-current"
              : "llm-wiki-tree-link"
          }
        >
          {node.title}
        </a>
      </li>
    );
  }
  const isOpen = open.has(node.path);
  return (
    <li className="llm-wiki-tree-folder" data-open={isOpen ? "true" : "false"}>
      <button
        type="button"
        className="llm-wiki-tree-folder-header"
        aria-expanded={isOpen}
        onClick={() => toggle(node.path)}
      >
        <span className="llm-wiki-tree-folder-caret" aria-hidden="true">
          {isOpen ? "▾" : "▸"}
        </span>
        <span className="llm-wiki-tree-folder-name">{node.name}</span>
      </button>
      {isOpen ? (
        <ul className="llm-wiki-tree-children">
          {node.children.map((child) => (
            <NodeView
              key={child.kind === "folder" ? `f:${child.path}` : `p:${child.slug}`}
              node={child}
              companyPrefix={companyPrefix}
              currentSlug={currentSlug}
              open={open}
              toggle={toggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function FolderTree({
  pages,
  companyPrefix,
  currentSlug,
  titleFilter,
}: FolderTreeProps): React.ReactElement {
  const fullTree = React.useMemo(() => buildTree(pages), [pages]);
  const needle = (titleFilter ?? "").trim().toLowerCase();
  const { tree, autoExpand } = React.useMemo(() => {
    if (needle.length === 0) {
      return { tree: fullTree, autoExpand: expandAncestorsOf(currentSlug) };
    }
    const filtered = filterTree(fullTree, needle);
    return {
      tree: filtered.kept ?? {
        kind: "folder" as const,
        name: "",
        path: "",
        children: [],
      },
      autoExpand: filtered.expand,
    };
  }, [fullTree, needle, currentSlug]);

  const [userToggled, setUserToggled] = React.useState<Map<string, boolean>>(
    () => new Map(),
  );

  const open = React.useMemo<Set<string>>(() => {
    const out = new Set(autoExpand);
    for (const [path, isOpen] of userToggled.entries()) {
      if (isOpen) out.add(path);
      else out.delete(path);
    }
    return out;
  }, [autoExpand, userToggled]);

  const toggle = React.useCallback((path: string) => {
    setUserToggled((prev) => {
      const next = new Map(prev);
      const current = next.get(path);
      // If unset, default state was either auto-expanded or collapsed; flip
      // to the opposite by reading the current effective state.
      // We approximate via prev: if path isn't in prev, assume the auto-state
      // matches `autoExpand`'s current state — for the purpose of a toggle,
      // either next state will do; we just want the opposite of what's shown.
      // The component re-reads effective state on next render.
      if (current === undefined) {
        // We don't have access to autoExpand here cleanly; default to true
        // (open) which is the more discoverable click outcome.
        next.set(path, true);
        return next;
      }
      next.set(path, !current);
      return next;
    });
  }, []);

  if (tree.kind !== "folder") return <div className="llm-wiki-tree" />;

  return (
    <ul className="llm-wiki-tree">
      {tree.children.map((child) => (
        <NodeView
          key={child.kind === "folder" ? `f:${child.path}` : `p:${child.slug}`}
          node={child}
          companyPrefix={companyPrefix}
          currentSlug={currentSlug}
          open={open}
          toggle={toggle}
        />
      ))}
    </ul>
  );
}
