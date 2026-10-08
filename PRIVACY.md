# Privacy

Task Dashboard is **local-first** by design.

- **No telemetry.** Nothing is collected, reported, or phoned home.
- **No network calls.** The M0 scaffold makes no network requests at all. There is no
  analytics, no update check, and no remote logging.
- **Runtime data stays local.** Task data lives in `.data/` inside your project
  (e.g. `.data/taskboard.sqlite`). That directory is gitignored and is never packaged.
- **Installs are file copies.** `install.sh` copies or symlinks the skill into your own
  host directories (`~/.claude/skills`, `~/.openclaw/skills`, `~/.codex/skills`,
  `~/.agents/skills`). It sends nothing anywhere.

If a future milestone adds an optional hosted or sync feature, it will be opt-in and
documented here first.
