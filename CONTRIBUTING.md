# Contributing

Thanks for your interest in improving this plugin. The structure below is meant to make contributions land smoothly — none of it is gatekeeping, and small PRs are welcome.

## What kinds of contributions fit

The plugin has four surface areas that take contributions well: the skill itself (`skills/llm-wiki/SKILL.md` and the references), the bundled scripts (`skills/llm-wiki/scripts/`), the slash commands (`commands/wiki/`), and the documentation (README, CHANGELOG, this file). Bug fixes and small improvements to any of these are easy yes-es.

For larger changes — new page types baked into the bootstrap, new lint checks, restructuring the references, changing the default schema — please open an issue first to discuss the shape before writing code. The skill is opinionated by design; some "improvements" would unwind a deliberate trade-off (atomic pages, index-first navigation, schema-as-config), so a quick issue conversation saves rework.

What probably doesn't fit: features that move the plugin away from being a Claude Code-native, markdown-based, file-system-resident tool. If your idea needs a database backend, a hosted service, a vector store, or a separate UI, it's likely a different project rather than a PR here. The reference implementations linked in the README (OmegaWiki, Synthadoc, etc.) explore those directions if that's where you want to go.

## Development setup

Clone your fork and install the plugin into a Claude Code session pointed at the local checkout:

```bash
git clone https://github.com/<your-fork>/llm-wiki-plugin
cd llm-wiki-plugin
```

Then in Claude Code, add the local path as a marketplace and install:

```
/plugin marketplace add /absolute/path/to/llm-wiki-plugin
/plugin install llm-wiki@llm-wiki
```

After making changes, refresh with `/plugin marketplace update` and reinstall. There's no build step — the skill, commands, and scripts run as-is from the filesystem.

The bundled Python scripts target Python 3.10+ and use only the standard library. Please don't add dependencies — the no-install property is load-bearing for adoption.

## Testing changes

There isn't a formal test suite, but every PR should be exercised against a real wiki before submission. The minimum smoke test:

```bash
mkdir /tmp/test-wiki && cd /tmp/test-wiki
python /path/to/llm-wiki-plugin/skills/llm-wiki/scripts/init_wiki.py .
# create a few markdown pages by hand under wiki/sources/, wiki/concepts/, etc.
# include some deliberate issues (an orphan page, a broken [[wikilink]], missing frontmatter)
python /path/to/llm-wiki-plugin/skills/llm-wiki/scripts/wiki_lint.py wiki/
python /path/to/llm-wiki-plugin/skills/llm-wiki/scripts/wiki_stats.py wiki/
python /path/to/llm-wiki-plugin/skills/llm-wiki/scripts/wiki_search.py "your query terms"
```

For changes to the skill itself (`SKILL.md` or the references), the most useful test is a real ingest: drop a paper or article into a test project's `raw/`, run `/wiki:ingest <path>`, and read what gets produced. If the workflow drifts in ways that hurt output quality, the skill needs adjustment.

For changes to slash commands, install the plugin into a fresh project and exercise the command end-to-end.

## Style notes for the skill prose

The skill body and references are written in a particular voice and structure. Keep new prose consistent with what's there:

The reference files use prose with minimal bullets — explanations connected by reasoning, not lists of disconnected points. This is deliberate: the LLM reading the skill benefits more from continuous reasoning than from bullet-pointed assertions. If you find yourself writing more than three or four bullets in a row, reconsider whether prose would carry the same content better.

Imperative voice for instructions ("Read the source", "Check the schema first"), explanatory voice for rationale ("The reason for the size cap is..."). Avoid all-caps MUSTs and NEVERs unless something is genuinely non-negotiable — explain *why* a constraint exists rather than shouting it.

Hedge claims that aren't yet established. "The pattern shines for accumulating textual research and degrades for highly relational data" is a defensible claim. "The pattern is the best knowledge management approach" is not.

## Style notes for the scripts

The bundled scripts share a few conventions worth preserving:

Each script has a docstring at the top with its purpose, usage, and an example invocation. New scripts should follow the same pattern — `python script.py --help` should produce useful output.

Output is human-readable by default with an optional `--json` flag for programmatic use (currently `wiki_lint.py` has this; others can add it as needed).

Conservative by design: scripts report findings and never modify the wiki. The user (or Claude under the user's direction) applies fixes. This separation is what makes the lint pass trustworthy.

Pure stdlib. No `pip install` ever, even for one nice helper.

## Schema and breaking changes

Some changes affect existing wikis users have built — adding a required frontmatter field, renaming a default page type, changing the index format. These are breaking changes and need:

A migration path documented in the PR (a script, a manual procedure, or both).

A clear note in `CHANGELOG.md` under a `### Changed` or `### Breaking` heading.

A version bump that respects semver — minor bump if backward-compatible with old wikis, major bump if not.

If a change can be made backward-compatible (e.g. new frontmatter field is optional with a sensible default), prefer that over the breaking version.

## PR checklist

Before opening a PR, verify:

- [ ] All four bundled scripts still run without error against a small test wiki.
- [ ] `python -c "import json; json.load(open('.claude-plugin/plugin.json')); json.load(open('.claude-plugin/marketplace.json'))"` succeeds.
- [ ] The plugin still loads in Claude Code (`/plugin marketplace add <local-path>`, `/plugin install`, no errors).
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` describing the change.
- [ ] If you changed the skill description in `SKILL.md` frontmatter or `plugin.json`, the description is still under 1024 characters.
- [ ] If you changed the SKILL.md description, the change clearly improves the trigger surface (more relevant phrasings, fewer false negatives) — descriptions are the primary mechanism that makes Claude reach for the skill, so wording matters.

## Issues

For bug reports, the most useful information is: the command or natural-language request that triggered the issue, the relevant slice of the wiki (a couple of pages or the full directory if you're comfortable sharing), and what you expected vs. what happened. If the bug is in a script, the exact command line and the output (or stack trace).

For feature requests, please describe the underlying use case as well as the proposed feature — sometimes the right answer is a different approach to the same problem rather than the requested feature.

## Releasing (maintainers)

### Where the version lives

The main release version is declared in four JSON fields and one CHANGELOG heading. **Bump them together**. `claude plugin validate` rejects mismatches between the plugin manifest and marketplace entry, while `package.json` keeps the documentation package aligned with the plugin and skill release.

| Location | Field | Notes |
|----------|-------|-------|
| `package.json` | `version` | Repository documentation package; keep aligned with the plugin and skill release. |
| `.claude-plugin/plugin.json` | `version` | Authoritative — Claude Code resolves the installed version from here first. |
| `.claude-plugin/marketplace.json` | `metadata.version` | Top-level marketplace version. |
| `.claude-plugin/marketplace.json` | `plugins[0].version` | Per-plugin entry; must match `plugin.json`. |
| `CHANGELOG.md` | `## [X.Y.Z] — YYYY-MM-DD` heading + the `[X.Y.Z]: …/releases/tag/vX.Y.Z` link line | Human-facing record. |

`skills/llm-wiki/SKILL.md` does **not** carry a version field. Skills are versioned by the enclosing plugin's `plugin.json` — leave SKILL.md frontmatter alone unless you're changing `name` or `description`.

The bundled scripts and slash commands also have no version metadata; the plugin version covers them.

### SemVer policy

- **Major** (`1.0.0` → `2.0.0`): breaking changes to wiki structure, frontmatter schema, or script CLI flags that existing wikis cannot accommodate without manual migration.
- **Minor** (`0.3.0` → `0.4.0`): additive features (new commands, new optional frontmatter, new scripts) that pre-existing wikis can ignore. Always pair with an `--upgrade`-style flow (or extend the existing one in `init_wiki.py`) so users on older wikis can pick up the new files idempotently without losing customisations.
- **Patch** (`0.3.0` → `0.3.1`): bug fixes, doc-only changes, internal refactors with identical observable behaviour.

If a feature can be made backward-compatible (e.g. a new frontmatter field with a sensible default), prefer that over a breaking change.

### Release checklist

1. **Move `[Unreleased]` entries** in `CHANGELOG.md` under a new `## [X.Y.Z] — YYYY-MM-DD` heading. Add the corresponding `[X.Y.Z]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/vX.Y.Z` line at the bottom and update `[Unreleased]: …/compare/vX.Y.Z...HEAD`.
2. **Bump `version` to `X.Y.Z`** in:
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json` (both `metadata.version` and `plugins[0].version`)
3. **If the release adds files or schema sections** users on older wikis would otherwise miss, extend `scripts/init_wiki.py`:
   - Add new template files to `template_map` (idempotent — `init_wiki.py` skips files that already exist).
   - Add a marker entry to `SCHEMA_SECTION_MARKERS` for any new SCHEMA.md section so `--upgrade` surfaces it as a manual merge.
   - Update the `/wiki:upgrade` slash command if the manual steps change.
4. **Validate the manifests** (catches version mismatches and schema errors):
   ```bash
   claude plugin validate .
   ```
   Should print `✔ Validation passed`.
5. **Smoke-test** the bundled scripts against a temp fixture (`init_wiki.py` into `/tmp`, seed a couple of pages, run lint + extract + query). For graph changes, exercise every lint branch with a fixture page that triggers each finding type.
6. **Commit in two parts** to mirror prior history:
   ```bash
   git commit -m "feat: <one-line summary>"      # the substantive changes
   git commit -m "release: vX.Y.Z"               # the version bumps + CHANGELOG
   ```
7. **Push and tag**:
   ```bash
   git push origin main
   git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
   git push origin vX.Y.Z
   ```
   The repo uses simple `vX.Y.Z` tags (matches `v0.1.0` and `v0.2.0`). The `claude plugin tag` command would create `llm-wiki--vX.Y.Z` instead — that's also valid for Claude Code installs, but keep this repo on the `vX.Y.Z` convention for consistency.
8. **Create the GitHub Release**:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z — <summary>" \
     --notes "$(cat <<'EOF'
     <release notes — usually a tightened version of the CHANGELOG entry>
     EOF
     )"
   ```

### How users pick up the new version

- **Claude Code:** `/plugin marketplace update` followed by `/plugin install llm-wiki@llm-wiki`. Claude Code compares the resolved `version` against the cached one and refreshes when they differ.
- **Other agents installed via `npx skills add`:** `npx skills update llm-wiki`, or re-run the original `npx skills add praneybehl/llm-wiki-plugin -a <agent>` command.
- **Existing wikis bootstrapped under an older plugin version:** users run `/wiki:upgrade` (or `python /path/to/llm-wiki-plugin/skills/llm-wiki/scripts/init_wiki.py /absolute/path/to/project --upgrade` from the CLI). The script path and target project must be separate; the upgrade flow is idempotent for files and walked-through for SCHEMA.md merges.

### What does NOT need to change on every release

- `skills/llm-wiki/SKILL.md` frontmatter (no version field)
- Slash command files in `commands/wiki/` (no version field)
- Reference docs in `skills/llm-wiki/references/` (unless the change introduces new content)
- Asset templates in `skills/llm-wiki/assets/` (unless the change introduces new templates)
- `LICENSE`, `README.md` (unless the user-facing summary changed)

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
