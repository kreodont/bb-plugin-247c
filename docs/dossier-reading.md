# Reading dossiers

`c247_read({taskId})` reads the current accepted task, projection, planning,
all accepted facts and source links. It does not include review history or
duplicate context briefs in the default response. Session workers can read
only their assigned task, including continuation pages.

Every response is at most 64 KiB. A small section has `format: "json"` and its
structured value in `data`. A large section has `format: "json-fragment"` and
a lossless part of its JSON document in `content`. Call
`c247_read({taskId, cursor: nextCursor})` until `nextCursor` is null. Concatenate
the `content` strings in order to reconstruct a fragmented section. Do not
parse an individual fragment as a complete JSON document or treat the first
page as complete context. `offset` and `totalCharacters` use JavaScript string
positions; use the returned opaque cursor instead of calculating offsets.

Cursors bind the task, section and content hash. If that section changes,
restart it without a cursor. Unrelated history changes do not invalidate an
accepted-context cursor. Cursors survive reloads when the content is unchanged.
Reading does not mark the task as visited.

Request `section` only when more history is needed:

| Section | Content |
| --- | --- |
| `accepted` | Current accepted fields and all accepted evidence; default |
| `proposals` | Up to 200 recent proposals, evidence and approval receipts |
| `sessions` | Up to 100 recent work/review sessions |
| `events` | Up to 100 recent task events |
| `sessionUpdates` | Up to 200 recent session extractions |
| `syncUpdates` | Up to 200 recent source-update candidates |

These history windows match the panel's existing detail response. They are not
an exhaustive archive. Pending or rejected history is not accepted task truth.
Large records in any section can span pages without losing text or evidence IDs.
The response supplies the section list, window limits and continuation guidance.
