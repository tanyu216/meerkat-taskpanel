-- 0004_dictionary.sql — dictionary identity and reference protection.
--
-- The tables themselves live in 0001 (tasks reference them, so they must exist
-- first). What lands here is the part that makes the dictionary a dictionary:
-- one row per (normalized name, kind), and no deleting something a card points
-- at (§4.4 "已被引用的字典项不得删除").
--
-- There is no management API anywhere in core: rows appear because a task was
-- created or reassigned. Renaming is a future alias table, not an UPDATE.

CREATE UNIQUE INDEX IF NOT EXISTS ux_assignees_norm ON assignees(normalized_name, kind);
CREATE INDEX IF NOT EXISTS ix_assignees_norm ON assignees(normalized_name);

CREATE UNIQUE INDEX IF NOT EXISTS ux_reporters_norm ON reporters(normalized_name, kind);
CREATE INDEX IF NOT EXISTS ix_reporters_norm ON reporters(normalized_name);

-- Defence in depth for I-dictionary: even a direct DELETE is refused while a
-- task still points at the entry. Deleting the *task* is a different matter and
-- is allowed (there is no ON DELETE clause, so tasks cannot be removed while
-- children reference them anyway).
CREATE TRIGGER IF NOT EXISTS tr_dict_assignees_delete BEFORE DELETE ON assignees
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

CREATE TRIGGER IF NOT EXISTS tr_dict_reporters_delete BEFORE DELETE ON reporters
WHEN EXISTS (SELECT 1 FROM tasks WHERE reporter_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

CREATE TRIGGER IF NOT EXISTS tr_rev_assignees_ins AFTER INSERT ON assignees
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_assignees_upd AFTER UPDATE ON assignees
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_assignees_del AFTER DELETE ON assignees
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_reporters_ins AFTER INSERT ON reporters
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_reporters_upd AFTER UPDATE ON reporters
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_reporters_del AFTER DELETE ON reporters
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
