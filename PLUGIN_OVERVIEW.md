# 247C

Durable tasks, work conversations and a shared knowledge base in BB.

Start a conversation in **Work**, without acceptance criteria. **Finish session**, in the Work tab or thread header, starts a separate session that reads the full dialogue and proposes dossier and knowledge updates with quotes. Codex Sol is automatically selected after Claude (Sonnet, Opus or Fable), and personal Sonnet after Codex. Spark, Luna, Haiku and models outside the explicit allowlist are excluded from review. Inspect the records in **Proposals** and accept them together. Accepted knowledge is available to future conversations and through search in **Knowledge base**.

Color distinguishes importance and urgency. Task history, revisions, sources and user decisions are retained. Open conversations survive reloads; failed reviews can be retried from the saved transcript.

When the entire task is complete, the review proposes completing it together with the dossier update. Status and evidence are visible before **Accept and complete task**. An incorrect completion can be reversed through a separate proposal in history.

Closing a task automatically archives its finished work and review chats in Threads. Conversations remain accessible from task history.

Supports Codex, personal Claude and corporate Claude. Legacy sessions with acceptance criteria remain compatible.

The knowledge base also accepts existing Markdown reference documents: full text, search, source-file links and updates by reimport without duplicates.

Reviews can propose title, status, urgency and importance alongside other dossier fields. Each change is displayed separately with its evidence and requires acceptance. **Discuss review** starts a linked conversation with the earlier transcript and proposal; a new review includes later corrections.

**Work source updates** check Gmail, Slack and Jira from a saved or selected date. Since 0.2.16, a script exports data in parallel through configured connectors without running a model. The model selected in BB's native composer then analyzes the prepared export; its account does not need source access. Quotes are checked against saved script responses in the plugin database; legacy runs retain validation through `threads.events.list`. Partial exports do not advance source checkpoints. Task updates and new tasks await the user's decision. [Instructions](https://github.com/kreodont/bb-plugin-247c/blob/main/skills/source-sync.md).

**Reported today** in a linked thread opens today's Day Plan at the task, ready to enter time. Missing rows are added without inventing reported hours. **Return to thread** saves edits and returns to the same conversation.

Each computer has a separate database. Accounts and sources are configured locally. The backup utility captures a consistent SQLite snapshot, code, settings and related chat text. Recovery verifies checksums and writes a new directory. Requires Python 3.11 or newer.

Local collectors can feed Teams, Outlook and ClickUp findings into the same
**Proposals** inbox, with quotes verified against their saved receipts. A local
calendar reader can supply native meetings. **Create day plan** runs an existing
configured automation. Each integration is optional and uses the installation's
own accounts, scripts and schedule. A private settings patch reapplies project,
model and integration preferences after plugin updates.
