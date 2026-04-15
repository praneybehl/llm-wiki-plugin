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

The release flow is:

1. Move `[Unreleased]` entries in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
3. Tag the commit (`git tag -a v0.x.0 -m "Release v0.x.0"`) and push tags.
4. Create a GitHub Release pointing at the tag, with the changelog entry as the body.

Users get the new version via `/plugin marketplace update` followed by `/plugin install` re-run.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
