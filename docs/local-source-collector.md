# Local source collectors

An authorized local collector can submit Teams, Outlook and ClickUp findings to
the same **Proposals** inbox as native source checks. Configure its trusted local
folder in the `sourceImportRoot` plugin setting. An empty setting disables imports.
The collector should keep raw connector receipts outside model-writable output and
assemble the final bundle itself. This folder is a trust boundary: a content hash
detects changed bytes; it does not authenticate an arbitrary file's author.

Submit the absolute bundle path, its SHA-256 and a stable UUID through `syncImport`
or `bb 247c sync-ingest '<request-json>' --json`. The server confines reads to the
configured folder and accepts regular files of at most 32 MiB. The version 1
bundle is defined by `sourceImportBundleSchema` in `source-import.ts` and contains:

- The chosen provider/model, collection boundary and per-source start times.
- The task revisions used for analysis.
- Raw read-only connector receipts with call IDs, timestamps, arguments and results.
- Coverage for all three sources and evidence-backed `syncDraftSchema` suggestions.

The server derives source and full-read status from the receipt operation. Search
previews cannot substantiate facts. Citations must use an exact quote from a
successful full read, a real source ID and a direct matching HTTPS link. Teams
chat-message links may use the documented `l/message/<chatId>/<messageId>` format
with source-provided IDs. ClickUp document links use the actual document and page
IDs, including meeting notes without a task ticket.

Imports atomically save native pending candidates and their connector export.
They never apply task changes, create accepted tasks, write knowledge notes or
record time. Standard human acceptance, rejection and partial review remain the
only application paths. Imported runs cannot supply account settings to the
separate native Gmail/Slack/Jira scheduler.

The collector must read the complete paginated `proposalInbox` before analysis,
combine matching pending candidates with `mergeCandidateIds`, and preserve their
facts and untouched fields. Stale task revisions or concurrent human decisions
reject the batch. Identical requests are idempotent; source-event deduplication
also prevents a later run from recreating the same proposal.

Advance collector checkpoints and local deduplication state only after a
successful import, using the returned coverage statuses. Partial and unavailable
sources retain their previous boundaries. Save failed analysis and receipts for
correction; an invalid batch leaves all existing proposals and checkpoints intact.
