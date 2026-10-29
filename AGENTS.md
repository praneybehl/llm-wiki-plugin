# Repository instructions

## Releases

- In these instructions, "publish" and "package publication" mean only publishing the Claude Code plugin, the skill in the skills.sh directory, and the GitHub release; npm publication is excluded unless the user explicitly requests it.
- Every user-facing plugin or skill change requires a SemVer decision before merge. Do not leave release-worthy work under an old version.
- Read and follow `CONTRIBUTING.md` section "Releasing (maintainers)". For the main LLM Wiki release, update `package.json`, `.claude-plugin/plugin.json`, both version fields in `.claude-plugin/marketplace.json`, `server/package.json`, `SERVER_VERSION` in `server/src/types.ts`, and `CHANGELOG.md` together. The skill has no separate version field; it inherits the enclosing plugin version.
- Do not report a release complete until the release commit is on `main`, the version tag is pushed, the GitHub release exists, every affected package is published, and registry/release URLs have been verified.
