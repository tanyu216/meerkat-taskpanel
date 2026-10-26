/**
 * `taskctl loop …` — the external loop, now part of the toolkit.
 *
 * The commands are `local: true`: the loop resolves its own board/token through
 * the moved entries, and `loop status`/`loop compat` must work with the board
 * down. The raw command line is forwarded to the moved entries (see
 * `src/orchestrator/dispatch.mjs`), so the flag declarations here are the one
 * source the CLI validates and the help prints.
 */

import { runLoopVerb } from "../../orchestrator/dispatch.mjs";

/** A string-valued flag. */
const str = (flag, key, value, summary) => ({ flag, key, as: "string", value, summary });
/** A number-valued flag. */
const num = (flag, key, value, summary) => ({ flag, key, as: "number", value, summary });
/** A bare switch. */
const bool = (flag, key, summary) => ({ flag, key, as: "boolean", summary });

/** Paths and state files. */
const PATHS = [
  str("roles-dir", "rolesDir", "<dir>", "Team-roles root (default: the project or loop skill)."),
  str("repo", "repo", "<dir>", "Board checkout the loop drives."),
  str("continue-state", "continueState", "<file>", "Continue-turn state file."),
  str("session-state", "sessionState", "<file>", "Resident-pool state file."),
  str("log", "log", "<file>", "Loop log file."),
  str("state", "state", "<file>", "Worker-registry file (the old spelling)."),
  str("state-dir", "stateDir", "<dir>", "Loop state directory; its files derive from it."),
  str("sla-ledger", "slaLedger", "<file>", "SLA de-duplication ledger."),
  str("workflow-ledger", "workflowLedger", "<file>", "Workflow de-duplication ledger."),
  str("sla-last-ok", "slaLastOk", "<file>", "Inspector liveness marker."),
  str("sla-peer", "slaPeer", "<file>", "Peer inspector marker."),
  str("config", "config", "<file>", "Agent policy file (`MEERKAT_TASKPANEL_*`)."),
  str("home", "home", "<dir>", "Home directory the agent paths derive from."),
  str("cli", "cli", "<path>", "The taskctl entry the loop's child calls use."),
  str("projects-json", "projectsJson", "<path>", "Project → directory map."),
];

/** Policy and cadence. */
const POLICY = [
  num("ping-interval", "pingInterval", "<sec>", "Ping clock cadence."),
  num("continue-interval", "continueInterval", "<sec>", "Continue clock cadence."),
  str("continue", "continue", "<yes|no>", "Enable the continue clock."),
  str("opened-by", "openedBy", "<human|supervisor>", "Who opened this loop."),
  str("control", "control", "<internal|external>", "Who owns the control turn (session mode)."),
  str("resident", "resident", "<auto|no>", "Whether a resident pool is expected."),
  num("session-max-age", "sessionMaxAge", "<sec>", "Resident session lifetime."),
  num("session-turn-timeout", "sessionTurnTimeout", "<sec>", "Turn bound (1200..7199)."),
  num("session-poll-ms", "sessionPollMs", "<ms>", "Pool poll cadence."),
  num("session-pool-max", "sessionPoolMax", "<n>", "Pool session cap."),
  num("project-concurrency", "projectConcurrency", "<n>", "Per-project concurrency cap."),
  num("project-idle-ms", "projectIdleMs", "<ms>", "Idle project-session eviction."),
  bool("allow-all-tools", "allowAllTools", "Give spawned agents the unrestricted tool set (needs a reason)."),
  str("allow-all-tools-reason", "allowAllToolsReason", "<text>", "Who authorized the unrestricted tool set, and why."),
  num("patrol-interval", "patrolInterval", "<sec>", "SLA measurement period."),
  num("max-concurrency", "maxConcurrency", "<n>", "Whole-fleet subagent cap."),
  str("claim-unassigned", "claimUnassigned", "<yes|no>", "Claim from the unassigned pool."),
  bool("assignee-only", "assigneeOnly", "Shorthand for `--claim-unassigned no`."),
  str("recover-stale", "recoverStale", "<yes|no>", "Recover stale in-progress claims."),
  str("workflow", "workflow", "<yes|no>", "Apply the board's workflow plan."),
  str("reviewer", "reviewer", "<agent>", "The independent reviewer."),
  str("workflow-max-actions", "workflowMaxActions", "<n>", "Cap on applied workflow actions."),
  str("review-aging-minutes", "reviewAgingMinutes", "<n>", "Silent-review threshold."),
];

/** SLA / event / notification knobs. */
const LIMITS = [
  num("sse-idle-ms", "sseIdleMs", "<ms>", "Event-stream idle bound."),
  num("event-debounce-ms", "eventDebounceMs", "<ms>", "Subscriber debounce."),
  num("event-debounce-max-ms", "eventDebounceMaxMs", "<ms>", "Subscriber debounce cap."),
  str("event-continue", "eventContinue", "<yes|no>", "Enable event-driven continues."),
  num("event-continue-min-ms", "eventContinueMinMs", "<ms>", "Floor between event continues."),
  bool("patrol-llm", "patrolLlm", "Allow the patrol to move a card (default: notify only)."),
  str("notify", "notify", "<cmd>", "Notification command; alert JSON on stdin."),
  bool("dry-run", "dryRun", "Plan only; write nothing."),
  str("sla-leader", "slaLeader", "<id>", "The actor the SLA leader writes under."),
  num("board-limit", "boardLimit", "<n>", "Board snapshot cap."),
  num("trail-limit", "trailLimit", "<n>", "Comment-trail read cap."),
];

const LOOP_FLAGS = [...PATHS, ...POLICY, ...LIMITS];

/** One verb; the move keeps the old entries' argv shape. */
function verb(name, summary, extra = []) {
  return {
    name,
    summary,
    usage: `loop ${name} [options]`,
    positionals: [],
    flags: [...LOOP_FLAGS, ...extra],
    local: true,
    async run(ctx) {
      return runLoopVerb(ctx, name);
    },
  };
}

export const COMMANDS = [
  verb("patrol", "One notify-only SLA/heartbeat pass."),
  verb("workflow", "Apply the board's workflow plan."),
  verb("poll", "Scan, admit, claim and enqueue."),
  verb("tick", "Run patrol → workflow → poll in one command.", [
    str("passes", "passes", "<list>", "Ordered pass list (default: patrol,workflow,poll)."),
  ]),
  verb("console", "One read-only question/frontier cycle."),
  verb("status", "Report the loop's runtime verdict; take over or stop the pool.", [
    bool("take-over", "takeOver", "Start the pool in external-control mode."),
    bool("stop", "stop", "Stop the pool this session started."),
  ]),
  verb("run", "The two clocks (daemon); one-shot with --ping-once/--continue-once.", [
    bool("ping-once", "pingOnce", "Run one ping pass and exit."),
    bool("continue-once", "continueOnce", "Run one continue pass and exit."),
  ]),
  verb("subscribe", "The event subscriber daemon (it dispatches continues)."),
  verb("session", "The resident session pool daemon."),
  verb("compat", "The board-interface gate.", [
    bool("quiet", "quiet", "Print nothing on success."),
  ]),
];
