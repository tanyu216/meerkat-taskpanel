/**
 * The question lane's pure settle predicates — one reader for the ladder's
 * middle rung.
 *
 * A worker that cannot decide writes an agent `question` comment on an
 * `in_progress` card and stops. The director answers with an agent `note` and
 * **releases the card to `todo`**, or escalates it to `awaiting`. A note alone
 * is not a settle: the card must leave `in_progress` (or change status after the
 * question, which also covers a released-then-reclaimed card).
 *
 * These predicates are shared by the orchestrator's native lane, the CLI's
 * `issue wait`, and the SLA patrol. They live in `foundation` because the
 * orchestrator may import only `foundation` (test/orchestrator/imports.test.mjs);
 * the CLI and core may import it too. One implementation, three readers.
 *
 * Wire comments are **newest first** (`comment list`, `issue get --include
 * comments`); the task is the wire shape (`status`, `status_changed_at`), and
 * the camelCase domain shape is accepted for the pure tests.
 *
 * Node builtins only.
 */

/** @param {unknown} value */
function instant(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** @param {object} [comment] */
export function isHumanComment(comment) {
  return String(comment?.author_kind ?? comment?.author?.kind ?? comment?.authorKind ?? "").toLowerCase() === "human";
}

/** @param {object} [comment] */
export function isQuestionComment(comment) {
  return comment?.kind === "question";
}

/**
 * The newest `question` in a **newest-first** list, or `null`.
 *
 * @param {object[]} comments
 * @returns {object|null}
 */
export function newestQuestion(comments) {
  for (const comment of comments ?? []) {
    if (isQuestionComment(comment)) return comment;
  }
  return null;
}

/** The index of a comment in a list, by id first and by identity second. */
function indexOfComment(list, comment) {
  if (comment?.id !== undefined) {
    const byId = list.findIndex((entry) => entry?.id === comment.id);
    if (byId !== -1) return byId;
  }
  return list.indexOf(comment);
}

/**
 * Has a **human** comment newer than the question? Any kind counts — the board
 * does not read prose for consent.
 *
 * @param {object[]} comments newest first
 * @param {object|null} question
 */
export function answeredByHuman(comments, question) {
  const list = Array.isArray(comments) ? comments : [];
  if (question === null || question === undefined) return false;
  const index = indexOfComment(list, question);
  if (index <= 0) return false;
  return list.slice(0, index).some(isHumanComment);
}

/**
 * Has **anything** newer than the question answered it? A human comment (any
 * kind) and an agent non-question comment both count. This is the worker's
 * `issue wait` rule — deliberately broader than {@link answeredByHuman} and
 * broader than the release-only settle rule: a director that wrote a note but
 * forgot the release must not leave the worker blocked for the whole timeout.
 *
 * The orchestrator's lane does **not** use this: the card still has to be
 * released (`questionOpen`), or the queue would never get it back.
 *
 * @param {object[]} comments newest first
 * @param {object|null} question
 */
export function isQuestionAnswered(comments, question) {
  const list = Array.isArray(comments) ? comments : [];
  if (question === null || question === undefined) return false;
  const index = indexOfComment(list, question);
  if (index <= 0) return false;
  return list.slice(0, index).some((comment) => isHumanComment(comment) || !isQuestionComment(comment));
}

/**
 * Did the card change status **after** the question was written? This is the
 * only evidence that the director released it (or that a later actor moved it).
 * A heartbeat, a comment or a progress write does not change `status_changed_at`.
 *
 * @param {{status?: string, status_changed_at?: string, statusChangedAt?: string}} [task]
 * @param {{created_at?: string, createdAt?: string}|null} [question]
 * @returns {boolean}
 */
export function releasedAfterQuestion(task, question) {
  const asked = instant(question?.created_at ?? question?.createdAt);
  const changed = instant(task?.status_changed_at ?? task?.statusChangedAt);
  return asked !== null && changed !== null && changed > asked;
}

/**
 * Is the question still open for the director lane?
 *
 * True only while the card is `in_progress` and no status change followed the
 * question. A `note` alone leaves it open (the director answered but did not
 * release); a human answer on an `in_progress` card also leaves it open — the
 * card still has to return to the queue.
 *
 * @param {object} [task]
 * @param {object|null} [question]
 * @returns {boolean}
 */
export function questionOpen(task, question) {
  if (question === null || question === undefined) return false;
  if (task?.status !== "in_progress") return false;
  return !releasedAfterQuestion(task, question);
}

/**
 * Classify one question against the live card and its trail.
 *
 * `settled` is the director-lane/verification rule: the card left `in_progress`
 * (released) or entered `awaiting` (escalated). `answered` is informational —
 * a human comment newer than the question — and is deliberately **not** enough
 * to settle an unreleased card.
 *
 * @param {{
 *   task?: object,
 *   comments?: object[],
 *   question?: object|null,
 *   questionId?: string|number|null,
 * }} [input] comments newest first
 * @returns {{
 *   settled: boolean,
 *   answered: boolean,
 *   released: boolean,
 *   escalated: boolean,
 *   status: string|null,
 *   question: object|null,
 * }}
 */
export function classifyQuestionOutcome(input = {}) {
  const task = input.task ?? {};
  const comments = Array.isArray(input.comments) ? input.comments : [];
  const question =
    input.question ??
    (input.questionId !== undefined && input.questionId !== null
      ? comments.find((comment) => String(comment?.id) === String(input.questionId)) ?? null
      : newestQuestion(comments));
  const status = typeof task.status === "string" ? task.status : null;
  const escalated = status === "awaiting";
  const released = status !== null && status !== "in_progress";
  return {
    settled: released,
    answered: answeredByHuman(comments, question),
    released,
    escalated,
    status,
    question,
  };
}
