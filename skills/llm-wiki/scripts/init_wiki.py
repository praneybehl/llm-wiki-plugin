#!/usr/bin/env python3
"""
init_wiki.py — Bootstrap an LLM Wiki structure in a project.

Creates the directory layout, drops in templates for SCHEMA.md, index.md, log.md,
and a starter page template. Idempotent: re-running won't clobber existing files.

Usage:
    python init_wiki.py <project-root> [--wiki-dir wiki] [--raw-dir raw]

Example:
    python init_wiki.py .
    python init_wiki.py ~/research --wiki-dir kb --raw-dir sources
"""

import argparse
import sys
from pathlib import Path
from datetime import date


SKILL_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = SKILL_ROOT / "assets"


SUBDIRS = ["sources", "entities", "concepts", "synthesis"]


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


def init_wiki(project_root: Path, wiki_dir: str, raw_dir: str) -> None:
    project_root = project_root.resolve()
    if not project_root.exists():
        print(f"Error: project root does not exist: {project_root}", file=sys.stderr)
        sys.exit(1)

    wiki = project_root / wiki_dir
    raw = project_root / raw_dir

    print(f"Initializing LLM Wiki in: {project_root}")
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

    # Report
    if created:
        print("Created:")
        for path in created:
            print(f"  + {path}")
    if skipped:
        print("Already existed (skipped):")
        for path in skipped:
            print(f"  = {path}")

    print()
    print("Next steps:")
    print(f"  1. Read {wiki_dir}/SCHEMA.md and customize it for your domain.")
    print(f"  2. Drop your first source into {raw_dir}/.")
    print(f"  3. Ask Claude to ingest it.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project_root", type=Path, help="Project root directory.")
    parser.add_argument("--wiki-dir", default="wiki", help="Name of the wiki subdirectory (default: wiki).")
    parser.add_argument("--raw-dir", default="raw", help="Name of the raw sources subdirectory (default: raw).")
    args = parser.parse_args()
    init_wiki(args.project_root, args.wiki_dir, args.raw_dir)


if __name__ == "__main__":
    main()
