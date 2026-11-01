/**
 * The question lane's pure predicates.
 *
 * The implementation lives in `src/foundation/question-settle.mjs` so the CLI's
 * `issue wait` can read the same rule without the orchestrator importing
 * `core`/`cli`; this module is the orchestrator's existing import site and
 * re-exports it unchanged. One reader, one settle rule.
 *
 * Node builtins only.
 */

export {
  answeredByHuman,
  classifyQuestionOutcome,
  isHumanComment,
  isQuestionComment,
  newestQuestion,
  questionOpen,
  releasedAfterQuestion,
} from "../foundation/question-settle.mjs";
