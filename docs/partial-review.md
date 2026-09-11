# Reviewing parts of a proposal

All parts are selected by default. The normal acceptance button applies the entire proposal. To review only part of it, uncheck the other parts, then choose **Accept selected parts** or **Reject selected parts**. Unchecked parts remain pending. Use the resulting proposal to decide the rest later.

A part is a task field, an individual dossier record, or an individual knowledge note. List fields such as blockers or artifacts are reviewed as one replacement value. Text within a summary or a record is not split into sentences. Supporting quotes remain available independently of whether a record is saved; selecting a field does not silently save its unselected records.

For a new task, accepting any parts creates one task with the proposed title and the selected contents. Remaining parts refer to that same task. Rejecting parts alone does not create a task. After a partial decision, later source checks can merge new findings with the pending remainder. Reviewed source records remain excluded from automatic carryover.

The common Proposals list honors part choices during bulk acceptance. Collapsing and reopening a proposal preserves its selection. Choices reset to all parts for a new proposal.

## Persistence and conflicts

A partial decision is one SQLite transaction. The original proposal and its evidence remain in history. An accepted subset gets its own exact approval, application receipt and undo proposal. Unselected parts get a new pending identity against the resulting revision. Rejected parts do not change the task or its unread state. Concurrent dossier edits, completed reviews and active review discussions are checked before applying any subset. Failed partitions roll back completely; retrying the same request does not duplicate effects.

Conversation citations are remapped when facts are partitioned, retaining unselected supporting evidence under distinct references. Finished transcripts stay immutable. Knowledge and records are saved only when selected. A session with remaining parts stays awaiting approval; after the remainder is resolved, previously accepted parts remain saved and its finished chats can be archived. Undo reverses selected dossier fields while preserving historical records and knowledge.

The task-card **New** and **Updated** badges use a separate viewed revision in the database. Only a visible dossier acknowledges its exact rendered revision; delayed acknowledgments cannot hide newer changes. Existing tasks are baselined during the additive migration. No task fields, source connections, time records or settings are rewritten by the migration.
