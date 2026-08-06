#!/usr/bin/env python3
"""
init_wiki.py — Bootstrap or upgrade an LLM Wiki structure in a project.

Plain init creates the directory layout and drops in templates for SCHEMA.md,
index.md, log.md, the page template, and the optional graph layer
(graph/ontology.yaml, graph/README.md, graph/.gitignore). It is idempotent:
re-running won't clobber existing files.
Both modes then install and verify the pinned local runtime, model cache,
parse cache, and vectors for every current wiki section through `uv`.

`--upgrade` mode is for wikis bootstrapped under an older plugin version. It
does the same idempotent file creation, then inspects the existing SCHEMA.md
for sections introduced in newer versions and prints clear instructions for
what to merge by hand. It never overwrites SCHEMA.md — the schema is
co-evolved with the user.

Usage:
    python init_wiki.py <project-root> [--wiki-dir wiki] [--raw-dir raw] [--upgrade]

Examples:
    python init_wiki.py .
    python init_wiki.py . --upgrade
    python init_wiki.py ~/research --wiki-dir kb --raw-dir sources
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from datetime import date

from wiki_markdown import configure_utf8_streams

configure_utf8_streams()


SKILL_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = SKILL_ROOT / "assets"


SUBDIRS = ["sources", "entities", "concepts", "synthesis", "graph"]

# Mirrors wiki_search.VECTOR_INDEX_NAME. Duplicated rather than imported so this
# bootstrap script stays runnable before any dependency exists.
VECTOR_INDEX_NAME = "embeddings.sqlite"
INDEX_UNIGNORE_RULE = f"!{VECTOR_INDEX_NAME}"
# The exact rule set older versions generated, before the vector index became a
# tracked artifact. Only this shape is migrated automatically.
LEGACY_WIKI_CACHE_IGNORE = ["*", "!.gitignore"]


# Markers used by --upgrade to detect SCHEMA.md sections introduced in
# specific plugin versions. Each entry: (heading_marker, version_label,
# template_anchor, blurb).
SCHEMA_SECTION_MARKERS = [
    {
        "marker": "## Optional graph metadata",
        "version": "0.3.0",
        "anchor": "## Optional graph metadata",
        "label": "Optional graph metadata (Frontmatter section)",
    },
    {
        "marker": "## Graph layer",
        "version": "0.3.0",
        "anchor": "## Graph layer",
        "label": "Graph layer (canonical-vs-generated artifact policy)",
    },
    {
        "marker": "Graph lint + extract",
        "version": "0.3.0",
        "anchor": "- Graph lint + extract: after every ingest that adds typed `graph.relationships`.",
        "label": "Graph lint + extract cadence (Lint cadence section)",
    },
    {
        "marker": "## Retrieval",
        "version": "2.0.0",
        "anchor": "## Retrieval",
        "label": "Retrieval (section search and cache)",
    },
    {
        "marker": "- Semantic backend: local FastEmbed + sqlite-vec",
        "version": "3.0.0",
        "anchor": "- Semantic backend: local FastEmbed + sqlite-vec",
        "label": "Local semantic retrieval (FastEmbed + sqlite-vec)",
    },
]


def copy_template(src: Path, dst: Path, substitutions: dict | None = None) -> bool:
    """Copy a template file to dst. Returns True if file was created, False if it already existed."""
    if dst.exists():
        return False
    text = src.read_text()
    if substitutions:
        for key, value in substitutions.items():
            text = text.replace(key, value)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text)
    return True


def migrate_wiki_cache_gitignore(path: Path) -> str:
    """Teach an older `.wiki-cache/.gitignore` that the vector index is tracked.

    Older versions generated `*` + `!.gitignore`, which was right when everything
    under `.wiki-cache/` was disposable. Now the vector index is a tracked
    artifact, and that rule set silently hides it: the upgrade builds the index,
    then git refuses to add it without `-f`. `copy_template()` cannot fix this —
    it returns untouched when the destination exists, which is the correct
    behaviour for a file the user may have edited.

    So the migration is surgical: only the known generated shape is rewritten,
    and only by appending. Anything the user has customized is reported instead
    of being edited under them.

    Returns "absent", "current", "migrated", "custom", or "unreadable: <reason>".
    """
    if not path.exists():
        return "absent"
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"unreadable: {exc}"
    rules = [line.strip() for line in text.splitlines()
             if line.strip() and not line.strip().startswith("#")]
    if INDEX_UNIGNORE_RULE in rules:
        return "current"
    if rules != LEGACY_WIKI_CACHE_IGNORE:
        return "custom"
    separator = "" if text.endswith("\n") else "\n"
    try:
        path.write_text(
            f"{text}{separator}\n"
            "# The vector index is tracked: it is expensive to build and cheap to\n"
            "# carry, so a fresh clone queries immediately. Added by --upgrade.\n"
            f"{INDEX_UNIGNORE_RULE}\n",
            encoding="utf-8",
        )
    except OSError as exc:
        return f"unreadable: {exc}"
    return "migrated"


def index_ignore_rule(project_root: Path, index_path: Path) -> str | None:
    """Return the gitignore rule hiding the vector index, or None if it is trackable.

    Asking git is the only honest check: the rule can live in the wiki's own
    `.gitignore`, the repository root's, or a global excludes file, and only git
    knows which one wins.

    Two calls, deliberately. `-q` alone carries the verdict: 0 = ignored,
    1 = not ignored, 128 = not a git repository. `-v` cannot be used for the
    verdict, because it also reports a path that matched a *negated* pattern and
    still exits 0 — so `!embeddings.sqlite`, the rule that makes the index
    trackable, would be read as the rule hiding it. `-v` is only asked for the
    rule text once `-q` has already said the index is ignored.
    """
    git = shutil.which("git")
    if not git:
        return None

    def check(*flags: str) -> subprocess.CompletedProcess | None:
        try:
            return subprocess.run(
                [git, "check-ignore", *flags, "--", str(index_path)],
                cwd=project_root, capture_output=True, text=True,
            )
        except OSError:
            return None

    verdict = check("-q")
    if verdict is None or verdict.returncode != 0:
        return None
    detail = check("-v")
    if detail is not None and detail.stdout.strip():
        return detail.stdout.strip().splitlines()[0]
    return f"(an ignore rule matches {index_path})"


def detect_schema_gaps(schema_path: Path) -> list[dict]:
    """Return the SCHEMA_SECTION_MARKERS entries missing from the user's SCHEMA.md."""
    if not schema_path.exists():
        return []
    text = schema_path.read_text(encoding="utf-8")

    def marker_present(marker: str) -> bool:
        if marker.startswith("## "):
            return any(line.strip() == marker for line in text.splitlines())
        return marker in text

    return [entry for entry in SCHEMA_SECTION_MARKERS if not marker_present(entry["marker"])]


def print_schema_upgrade_guidance(schema_path: Path, gaps: list[dict]) -> None:
    template_path = TEMPLATES / "SCHEMA.md.template"
    print()
    print("=" * 64)
    print(f"Upgrade required: {schema_path}")
    print("=" * 64)
    print(
        "Your SCHEMA.md predates one or more sections or policy markers\n"
        "introduced by newer plugin versions. Merge the items below by hand.\n"
        "SCHEMA.md is co-evolved with you — this script never overwrites it."
    )
    print()
    print("Missing sections:")
    for m in gaps:
        print(f"  - [{m['version']}] {m['label']}")
    print()
    print(f"Reference template: {template_path}")
    print(
        "Diff your SCHEMA.md against the template and copy the missing\n"
        "sections in. Or run /wiki:upgrade and Claude will propose the edits\n"
        "interactively (one section at a time, never silent)."
    )


def report_ignored_index(index_path: Path, rule: str, ignore_status: str,
                         cache_ignore: Path) -> None:
    """Explain that the built index cannot be committed, and how to unblock it."""
    stream = sys.stderr
    print(file=stream)
    print("=" * 64, file=stream)
    print("Blocked: the vector index is git-ignored", file=stream)
    print("=" * 64, file=stream)
    print(
        f"{index_path} is expensive to build and is meant to be committed with\n"
        f"the pages it indexes, but git will not add it:\n"
        f"  {rule}\n",
        file=stream,
    )
    if ignore_status == "custom":
        print(
            f"{cache_ignore} has been customized, so it was left untouched.\n"
            f"Add this line to it by hand:\n"
            f"  {INDEX_UNIGNORE_RULE}",
            file=stream,
        )
    elif ignore_status.startswith("unreadable"):
        print(f"{cache_ignore} could not be updated ({ignore_status}).", file=stream)
    else:
        print(
            "The rule is not in the wiki's own .wiki-cache/.gitignore — check the\n"
            "repository root .gitignore and your global excludes file. The line\n"
            "shown above names the file and rule responsible.\n"
            "If that rule excludes a whole directory, the '!embeddings.sqlite'\n"
            "negation cannot rescue it: git never descends into an excluded\n"
            "directory, so the parent rule has to be narrowed instead.",
            file=stream,
        )
    print(
        "\nSetup is not complete. Fix the rule and rerun; nothing else here\n"
        "is affected, and no work is lost.",
        file=stream,
    )


def install_runtime(wiki: Path) -> None:
    """Install pinned dependencies, cache the model, and synchronize the wiki index."""
    uv = shutil.which("uv")
    if not uv:
        print(
            "Error: uv is required to install the pinned LLM Wiki runtime. "
            "Install it from https://docs.astral.sh/uv/getting-started/installation/ "
            "and rerun this command.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    setup_script = Path(__file__).resolve().with_name("setup_wiki.py")
    print()
    print("Installing and verifying the local retrieval runtime...", flush=True)
    try:
        subprocess.run(
            [uv, "run", "--script", str(setup_script), "--wiki", str(wiki), "--cache"],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        print(
            f"Error: local retrieval setup failed with exit code {exc.returncode}.",
            file=sys.stderr,
        )
        raise SystemExit(exc.returncode) from exc


def init_wiki(project_root: Path, wiki_dir: str, raw_dir: str, upgrade: bool = False) -> None:
    project_root = project_root.resolve()
    if not project_root.exists():
        print(f"Error: project root does not exist: {project_root}", file=sys.stderr)
        sys.exit(1)

    wiki = project_root / wiki_dir
    raw = project_root / raw_dir

    mode = "Upgrading" if upgrade else "Initializing"
    print(f"{mode} LLM Wiki in: {project_root}")
    print(f"  Wiki directory: {wiki}")
    print(f"  Raw directory:  {raw}")
    print()

    created = []
    skipped = []

    # Create wiki subdirs
    for subdir in SUBDIRS:
        d = wiki / subdir
        if not d.exists():
            d.mkdir(parents=True)
            created.append(f"{wiki_dir}/{subdir}/")
        else:
            skipped.append(f"{wiki_dir}/{subdir}/")

    # Create raw + raw/assets
    for d, label in [(raw, raw_dir), (raw / "assets", f"{raw_dir}/assets")]:
        if not d.exists():
            d.mkdir(parents=True)
            created.append(f"{label}/")
        else:
            skipped.append(f"{label}/")

    # Copy templates
    template_map = [
        ("SCHEMA.md.template", wiki / "SCHEMA.md"),
        ("index.md.template", wiki / "index.md"),
        ("log.md.template", wiki / "log.md"),
        ("page.md.template", wiki / ".page-template.md"),
        ("ontology.yaml.template", wiki / "graph" / "ontology.yaml"),
        ("graph_README.md.template", wiki / "graph" / "README.md"),
        ("graph_gitignore.template", wiki / "graph" / ".gitignore"),
        ("wiki-cache_gitignore.template", wiki / ".wiki-cache" / ".gitignore"),
    ]
    for src_name, dst in template_map:
        src = TEMPLATES / src_name
        if not src.exists():
            print(f"Warning: template missing: {src}", file=sys.stderr)
            continue
        if copy_template(src, dst):
            created.append(str(dst.relative_to(project_root)))
        else:
            skipped.append(str(dst.relative_to(project_root)))

    cache_ignore = wiki / ".wiki-cache" / ".gitignore"
    ignore_status = migrate_wiki_cache_gitignore(cache_ignore)
    if ignore_status == "migrated":
        created.append(f"{cache_ignore.relative_to(project_root)} (migrated: {INDEX_UNIGNORE_RULE})")

    # Report
    if created:
        print("Created:")
        for path in created:
            print(f"  + {path}")
    if skipped:
        print("Already existed (skipped):")
        for path in skipped:
            print(f"  = {path}")

    # Before the runtime install, not after: building the index first and only
    # then reporting that it cannot be committed would waste a ~25-minute embed
    # pass to deliver the news.
    index_path = wiki / ".wiki-cache" / VECTOR_INDEX_NAME
    blocking_rule = index_ignore_rule(project_root, index_path)
    if blocking_rule:
        report_ignored_index(index_path, blocking_rule, ignore_status, cache_ignore)
        raise SystemExit(1)

    install_runtime(wiki)

    if upgrade:
        gaps = detect_schema_gaps(wiki / "SCHEMA.md")
        if gaps:
            print_schema_upgrade_guidance(wiki / "SCHEMA.md", gaps)
        else:
            print()
            print("SCHEMA.md is up to date with the current template — no manual merge needed.")
        return

    print()
    print("Next steps:")
    print(f"  1. Read {wiki_dir}/SCHEMA.md and customize it for your domain.")
    print(f"  2. (Optional) Edit {wiki_dir}/graph/ontology.yaml to add domain-specific predicates.")
    print(f"  3. Drop your first source into {raw_dir}/.")
    print(f"  4. Ask Claude to ingest it.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project_root", type=Path, help="Project root directory.")
    parser.add_argument("--wiki-dir", default="wiki", help="Name of the wiki subdirectory (default: wiki).")
    parser.add_argument("--raw-dir", default="raw", help="Name of the raw sources subdirectory (default: raw).")
    parser.add_argument("--upgrade", action="store_true",
                        help="Upgrade an existing wiki: add missing files idempotently and surface SCHEMA.md sections to merge by hand.")
    args = parser.parse_args()
    init_wiki(args.project_root, args.wiki_dir, args.raw_dir, upgrade=args.upgrade)


if __name__ == "__main__":
    main()
