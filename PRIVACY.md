# Privacy

Meerkat TaskPanel is **local-first** by design.

- **No telemetry.** Nothing is collected, reported, or phoned home.
- **No network calls.** The M0 scaffold makes no network requests at all. There is no
  analytics, no update check, and no remote logging.
- **Runtime data stays local.** Task data lives in `.data/` inside the running program's
  root (e.g. `.data/taskboard.sqlite`) — the checkout, `/app` in the container, or
  `~/.meerkat-taskpanel/.data` for an npm/npx install. The loop's own state (queue, session
  ids, locks and bounded worker transcripts) lives beside it at `<config root>/loop/`, not in
  `.data`. Both are gitignored, never packaged, and never deleted or overwritten by an
  upgrade.
- **Installs are file copies.** `install.sh` copies or symlinks the skill into your own
  agent directories (`~/.claude/skills`, `~/.openclaw/skills`, `~/.codex/skills`,
  `~/.agents/skills`). It sends nothing anywhere.

If a future milestone adds an optional hosted or sync feature, it will be opt-in and
documented here first.
