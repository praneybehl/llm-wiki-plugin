---
description: Move a local LLM Wiki to a hosted wiki, verify it, then keep the local folder as a read-only mirror.
argument-hint: "[<wiki-dir>] [--raw <raw-dir>] [--no-raw]"
---

Migrate a local wiki to a hosted wiki. Use the `llm-wiki` skill and `skills/llm-wiki/references/hosted-mode.md`.

Arguments (if any): $ARGUMENTS

Set `REMOTE="${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py"` for the steps below.

1. Resolve `<WIKI_ROOT>` and `<RAW_ROOT>` from the arguments, the nearest project instructions, global agent instructions, or the current project's `wiki/` and `raw/`. Confirm that `<WIKI_ROOT>/SCHEMA.md` exists. Never combine two wikis.
2. Run `python3 "$REMOTE" status`. If no connection exists, run the token branch of `/wiki:init --hosted <url>` first. The import uses `wiki_remote.py`, so it needs a token also when my MCP client signs in with OAuth. The token needs `write` scope, and `raw:write` for raw files. An empty wiki is the normal target. If the remote wiki already has pages, tell me and ask before you continue.
3. Run local lint once: `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_lint.py" "<WIKI_ROOT>"`. Keep the finding counts for step 7.
4. Dry run: `python3 "$REMOTE" import "<WIKI_ROOT>" --raw "<RAW_ROOT>" --dry-run`. Use `--no-raw` if I asked for it or if the server has no raw storage. Show me the counts: pages to upload, pages that are identical, raw files, bytes, and any refusals.
5. Ask for approval. Then run the same command without `--dry-run`. The import uploads in small batches. It skips identical files. If it stops, run the same command again. It continues from where it stopped.
6. Read the JSON report.
   - Exit code 0: every page and raw file that the import selected has the same SHA-256 on the server. Exit code 0 does not prove that the import selected all of your content.
   - Exit code 1: a mismatch. Show the mismatched paths. Do not continue.
   - Exit code 3: the import did not replace some remote pages. `pages.divergent` lists remote pages that are different and that an earlier import did not write; in this case the import wrote nothing. `pages.changed_during_import` lists remote pages that another writer changed while the import ran. Show the paths. Use `--overwrite` only if I approve it for those paths.
   - Always read the `skipped` list and the `raw.skipped` list, also when the exit code is 0. Each entry has a `path` and a `reason`. Put each entry in one of two groups:
     - Expected exclusions: `generated` (files in `graph/` that the server builds again, for example `nodes.jsonl` and `graph.sqlite`), and caches or copies that you do not want on the server. Hidden files and folders (`.git`, `.obsidian`, `.wiki-cache`) are skipped and are not in the lists.
     - Missing source content: `too_large`, `not_utf8`, `not_text`, `symlink`, `invalid_path`, `path_too_long`, and any other page or raw file that must be on the server.
   - Show me both groups. For each file with missing source content, tell me how to fix it (split a large page, convert the file to UTF-8, copy the target of a symlink, rename the path), then run the import again. Do not go to step 8 while missing source content remains, unless I accept each missing file by name.
7. Verify on the server: run `python3 "$REMOTE" lint` and compare the counts with step 3. Run two or three searches that I know the answers to with `python3 "$REMOTE" search "<query>"`. Report the differences. Small search ranking differences are normal.
8. Ask whether to keep the local folder as a read-only mirror. If yes, explain that the next pull replaces local files with the server copy and saves a changed local file as `<file>.local-<timestamp>`. After my approval, run `python3 "$REMOTE" pull "<WIKI_ROOT>"`. Add `--git` if `<WIKI_ROOT>` is in a git repository and I want a commit for each pull.
9. Propose the hosted-wiki stanza from `references/agent-memory-integration.md` to replace the local stanza. Show the exact change. Write it only after I approve.
10. Tell me that the local folder is now a mirror: edits there do not go to the server. `/wiki:learn` and `/wiki:evolve` can run on the mirror. `python3 "$REMOTE" export <file>.tar.gz` makes a full backup at any time.

Rollback: until step 8, the local wiki and agent instructions do not change. To stop, keep using the local wiki.
