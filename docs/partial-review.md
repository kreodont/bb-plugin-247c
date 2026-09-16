# Reviewing parts of a proposal

All parts are selected by default. The normal acceptance button applies the entire proposal. To review only part of it, uncheck the other parts, then choose **Accept selected parts** or **Reject selected parts**. Unchecked parts remain pending. Use the resulting proposal to decide the rest later.

A part is a task field, an individual dossier record, or an individual knowledge note. List fields such as blockers or artifacts are reviewed as one replacement value. Text within a summary or a record is not split into sentences. Supporting quotes remain available independently of whether a record is saved; selecting a field does not silently save its unselected records.

For a new task, accepting any parts creates one task with the proposed title and the selected contents. Remaining parts refer to that same task. Rejecting parts alone does not create a task. After a partial decision, later source checks can merge new findings with the pending remainder. Reviewed source records remain excluded from automatic carryover.

The common Proposals list honors part choices during bulk acceptance. Collapsing and reopening a proposal preserves its selection. Choices reset to all parts for a new proposal.

## Persistence and conflicts

### Recovering a stale dossier proposal

An outdated dossier or conversation proposal can be recovered in its own card, both in the task and in the shared **Proposals** list. Expand the proposal to see the recovery controls.

**Refresh proposal** is available when the history proves that only priority changed and a standalone field proposal does not change priority. It prepares the same contents against the current task without calling a model. Missing history, changed task contents, proposed priority changes, and conversation records or knowledge require a human review instead.

Use **Review current task** to see the current summary, next step, priority, questions, blockers, artifacts and context records. Compare these with the proposed values, select the parts that remain appropriate, and confirm the review. **Save updated proposal** keeps those parts in a new pending proposal. During this recovery, unchecked parts are discarded from the replacement and retained in the original's history; this differs from ordinary partial acceptance, which keeps unchecked parts pending. All parts start selected.

Neither recovery action accepts anything, runs a model, changes the task or time journal, or rewrites the conversation. The replacement must still be accepted. Supporting evidence is preserved even when its associated record is not selected. The original is retired only after the replacement is validated and saved in the same transaction. A concurrent edit requires another review of the latest task; an active work session or review discussion must finish first. For a new AI analysis of a conversation, the existing **Work → Retry review** and **Discuss review** actions remain available.

### Applying reviewed parts

A partial decision is one SQLite transaction. The original proposal and its evidence remain in history. An accepted subset gets its own exact approval, application receipt and undo proposal. Unselected parts get a new pending identity against the resulting revision. Rejected parts do not change the task or its unread state. Concurrent dossier edits, completed reviews and active review discussions are checked before applying any subset. Failed partitions roll back completely; retrying the same request does not duplicate effects.

Conversation citations are remapped when facts are partitioned, retaining unselected supporting evidence under distinct references. Finished transcripts stay immutable. Knowledge and records are saved only when selected. A session with remaining parts stays awaiting approval; after the remainder is resolved, previously accepted parts remain saved and its finished chats can be archived. Undo reverses selected dossier fields while preserving historical records and knowledge.

The task-card **New** and **Updated** badges use a separate viewed revision in the database. Only a visible dossier acknowledges its exact rendered revision; delayed acknowledgments cannot hide newer changes. Existing tasks are baselined during the additive migration. No task fields, source connections, time records or settings are rewritten by the migration.
