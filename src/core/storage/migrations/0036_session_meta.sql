-- 0036_session_meta.sql — a session carries opaque host-observation metadata.
--
-- The board already stores the facts every session has in common: the task, the
-- segment, the owner and its kind, the session id, phase, pid and a one-line
-- goal. A harness also observes things the board has no business interpreting —
-- which harness started the conversation, its thread id, where its log lives.
-- Those are the consumer's keys, not the board's vocabulary.
--
-- `meta_json` is the same mechanism tasks and projects already use: an opaque
-- JSON object the board stores and returns verbatim. It is `NOT NULL DEFAULT
-- '{}'` (an absent meta is an empty object, not NULL), which is what makes
-- `ALTER TABLE … ADD COLUMN` legal on a STRICT table without rebuilding it —
-- the rule 0028 used for `goal`. Existing rows read `{}` and are not
-- back-filled: a session's metadata is what it said it was.
--
-- Append-only: 0001 … 0035 are never edited.

ALTER TABLE agent_sessions ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
