# Repository instructions

## Releases

- Every user-facing plugin or skill change requires a SemVer decision before merge. Do not leave release-worthy work under an old version.
- Read and follow `CONTRIBUTING.md` section "Releasing (maintainers)". For the main LLM Wiki release, update `package.json`, `.claude-plugin/plugin.json`, both version fields in `.claude-plugin/marketplace.json`, and `CHANGELOG.md` together. The skill has no separate version field; it inherits the enclosing plugin version.
- If the Paperclip package is affected or explicitly included in the release, update `integrations/paperclip/plugin/package.json`, `src/manifest.ts`, the manifest version test, its README status, and the root changelog together. Run its full `prepublish:check` before publishing.
- Do not report a release complete until the release commit is on `main`, the version tag is pushed, the GitHub release exists, every affected package is published, and registry/release URLs have been verified.

