# Reading dossiers

Open work chats compare the accepted task and primary-source revisions before
continuing. When either changes, the next user message waits briefly while the
idle provider runtime is released, then resumes the same conversation with a
current version marker and instructions to read `c247_read` before task-specific
work. Existing chats adopt this behavior on their next message. Active turns
are allowed to finish first; queued input and conversation history are preserved.

This does not launch an extra model turn or automatically send a message.
Unchanged revisions require no additional dossier read. Pending or rejected
proposals do not trigger a refresh or become accepted context. Recorder snapshots
and legacy criterion-based contracts remain fixed. The session's optional
`workerContext` records the runtime instruction version, not proof of a model read;
it does not change the original `baseRevision` or require a database migration.

`c247_read({taskId})` reads the current working context. Small dossiers include
all accepted evidence. Above 48 KiB of serialized accepted data, the default
view automatically defers older progress and next-step records. Current task
fields, planning, source links and the accepted summary remain intact.

Compaction preserves every description, user instruction, constraint, decision,
question, blocker and artifact, plus exact evidence for the current next step
and at least the three most recently accepted progress records. It adds recent
progress up to a soft 32 KiB target and a maximum of twelve progress records.
Acceptance time determines recency, so a newly accepted correction to an old
event is retained. Protected records can exceed the target and are paged rather
than truncated. No record is rewritten, deleted or marked resolved. The view
is derived afresh from the current accepted state, without a model call, cache,
database migration or additional approval.

The `compaction` object reports included/deferred counts, kinds and the deferred
acceptance-date range. It is a selection of original evidence around the accepted
summary, not a new AI summary of the omitted history. Current projection fields
take precedence over historical steps and status. Old instructions are context,
not new authorization. Absence from this view does not prove something never
happened: retrieve relevant evidence before historical claims or changes.

Read older evidence with `section: "facts"`:

```json
{"taskId":"task-id","section":"facts","query":"deployment rollback"}
{"taskId":"task-id","section":"facts","factIds":["fact-id"]}
{"taskId":"task-id","section":"facts","kinds":["progress","explicit_next_step"]}
```

Search is Unicode-normalized and case-insensitive. Every whitespace-separated
keyword must match the text, source, source reference or kind. It uses no model
or external index. Filters can be combined; omit them to read all accepted facts.
Results retain original text, IDs, dates and source references, and report
`matchedFacts`, `totalFacts` and any requested IDs absent from the dossier.
Use `section: "accepted"` for the full accepted dossier when needed, rather than
automatically loading all history after every compact read.

Review history and duplicate context briefs are excluded from normal reads.
Session workers can read only their assigned task, including searches and pages.
The panel and the recorder's fixed extraction packet keep their existing data.

Every response is at most 64 KiB. A small section has `format: "json"` and its
structured value in `data`. A large section has `format: "json-fragment"` and
a lossless part of its JSON document in `content`. Call
`c247_read({taskId, cursor: nextCursor})` until `nextCursor` is null. Concatenate
the `content` strings in order to reconstruct a fragmented section. Do not
parse an individual fragment as a complete JSON document or treat the first
page as complete context. `offset` and `totalCharacters` use JavaScript string
positions; use the returned opaque cursor instead of calculating offsets.

Cursors bind the task, section, search filters and content hash. Continuation
calls need only `taskId` and `cursor`; do not change filters mid-read. If that
section changes, restart it without a cursor and repeat the filters. Unrelated history changes do not invalidate an
accepted-context cursor. Cursors survive reloads when the content is unchanged.
Reading does not mark the task as visited.

Request `section` only when more history is needed:

| Section | Content |
| --- | --- |
| `context` | Current accepted fields and automatically compacted evidence; default |
| `accepted` | Current accepted fields and all accepted evidence |
| `facts` | Accepted facts, optionally filtered by `query`, `factIds` and `kinds` |
| `proposals` | Up to 200 recent proposals, evidence and approval receipts |
| `sessions` | Up to 100 recent work/review sessions |
| `events` | Up to 100 recent task events |
| `sessionUpdates` | Up to 200 recent session extractions |
| `syncUpdates` | Up to 200 recent source-update candidates |

These history windows match the panel's existing detail response. They are not
an exhaustive archive. Pending or rejected history is not accepted task truth.
Large records in any section can span pages without losing text or evidence IDs.
The response supplies the section list, window limits and continuation guidance.
