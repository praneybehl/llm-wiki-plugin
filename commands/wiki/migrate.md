---
description: Move a local LLM Wiki to a hosted wiki, verify it, then keep the local folder as a read-only mirror.
argument-hint: "[<wiki-dir>] [--raw <raw-dir>] [--no-raw]"
---

Migrate a local wiki to a hosted wiki. Use the `llm-wiki` skill and `skills/llm-wiki/references/hosted-mode.md`.

Arguments (if any): $ARGUMENTS

Set `REMOTE="${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py"` for the steps below.

1. Resolve `<WIKI_ROOT>` and `<RAW_ROOT>` from the arguments, the nearest project instructions, global agent instructions, or the current project's `wiki/` and `raw/`. Confirm that `<WIKI_ROOT>/SCHEMA.md` exists. Never combine two wikis.
2. Run `python3 "$REMOTE" status`. If no connection exists, run `/wiki:init --hosted <url>` first. The token needs `write` scope, and `raw:write` for raw files. An empty wiki is the normal target. If the remote wiki already has pages, tell me and ask before you continue.
3. Run local lint once: `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_lint.py" "<WIKI_ROOT>"`. Keep the finding counts for step 7.
4. Dry run: `python3 "$REMOTE" import "<WIKI_ROOT>" --raw "<RAW_ROOT>" --dry-run`. Use `--no-raw` if I asked for it or if the server has no raw storage. Show me the counts: pages to upload, pages that are identical, raw files, bytes, and any refusals.
5. Ask for approval. Then run the same command without `--dry-run`. The import uploads in small batches. It skips identical files. If it stops, run the same command again. It continues from where it stopped.
6. Read the JSON report.
   - Exit code 0: every local page and raw file has the same SHA-256 on the server.
   - Exit code 1: a mismatch. Show the mismatched paths. Do not continue.
   - Exit code 3: remote pages are different and the import wrote nothing. Show the paths. Use `--overwrite` only if I approve it for those paths.
7. Verify on the server: run `python3 "$REMOTE" lint` and compare the counts with step 3. Run two or three searches that I know the answers to with `python3 "$REMOTE" search "<query>"`. Report the differences. Small search ranking differences are normal.
8. Ask whether to keep the local folder as a read-only mirror. If yes, explain that the next pull replaces local files with the server copy and saves a changed local file as `<file>.local-<timestamp>`. After my approval, run `python3 "$REMOTE" pull "<WIKI_ROOT>"`. Add `--git` if `<WIKI_ROOT>` is in a git repository and I want a commit for each pull.
9. Propose the hosted-wiki stanza from `references/agent-memory-integration.md` to replace the local stanza. Show the exact change. Write it only after I approve.
10. Tell me that the local folder is now a mirror: edits there do not go to the server. `/wiki:learn` and `/wiki:evolve` can run on the mirror. `python3 "$REMOTE" export <file>.tar.gz` makes a full backup at any time.

Rollback: until step 8, the local wiki and agent instructions do not change. To stop, keep using the local wiki.
