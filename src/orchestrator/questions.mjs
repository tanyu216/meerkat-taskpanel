/**
 * The question lane's pure predicates.
 *
 * A worker that cannot decide writes an agent `question` comment and keeps the
 * card `in_progress`. The project session is the middle rung: it answers with a
 * `note` and requeues the card, or escalates E1–E5 to the human. These helpers
 * read the **wire** comment shape (`kind`, `author_kind` / `author.kind`) in the
 * order `comment list` returns — **newest first**.
 *
 * Node builtins only.
 */

/** @param {object} [comment] */
export function isHumanComment(comment) {
  return String(comment?.author_kind ?? comment?.author?.kind ?? "").toLowerCase() === "human";
}

/** @param {object} [comment] */
export function isQuestionComment(comment) {
  return comment?.kind === "question";
}

/**
 * The newest `question` in a newest-first list, or `null`.
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
 * Has a **human** comment newer than the question? This is the board's resume
 * rule (`awaiting`), and it is deliberately narrower than
 * {@link isQuestionSettled}.
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
 * Has the question been answered by anything newer that is not another question?
 * A human comment and the project session's `decision:` note both settle it —
 * the middle rung's answer is an agent comment on purpose.
 *
 * @param {object[]} comments newest first
 * @param {object|null} question
 */
export function isQuestionSettled(comments, question) {
  const list = Array.isArray(comments) ? comments : [];
  if (question === null || question === undefined) return true;
  const index = indexOfComment(list, question);
  if (index <= 0) return false;
  return list.slice(0, index).some((comment) => !isQuestionComment(comment));
}
