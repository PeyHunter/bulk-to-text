# bulk-to-text

- Never add Co-Authored-By or "Generated with Claude Code" lines to commits or PRs.
- The repo is public. Never commit secrets: no API keys, passwords or real customer images, not even in tests.
- The server stays stateless: no database, no files on disk, never keep images or text after the request.
- Work goes through PRs to `main` once the repo is on GitHub.
- The user (Peter) wants simple, plain English in the UI and in messages.
