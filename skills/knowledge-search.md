# Local OpenKnowledge search

247C can export its accepted knowledge to an [OpenKnowledge](https://openknowledge.sh/) bundle and use the local CLI to retrieve ranked excerpts. The database remains authoritative. Imports and human-approved conversation notes are exported; pending or rejected proposals, unrelated chats, credentials and task dossiers are not. A document can describe historical work: check the current dossier and accepted decisions before proposing a new action.

## Configure

Install OpenKnowledge separately on the BB server (tested with 0.13.0). Set these local plugin settings, preferably through the installation's private settings patch:

- `knowledgeDirectory`: absolute path to an empty, dedicated export folder outside the plugin checkout.
- `openKnowledgeExecutable`: absolute path to the installed `openknowledge` or `okn` executable.

Both default to blank. A directory alone enables export; both settings enable ranked search. Paths refer to the BB server, including WSL when BB runs there. No binary is downloaded or executed during plugin installation. Search runs without a shell, with a 20-second timeout and telemetry suppressed. It uses OpenKnowledge's local lexical and hashed-feature search, with no model or embedding API.

The exporter runs on startup, after knowledge changes, and every 30 seconds to recover from failures and configuration changes. It creates immutable generations and atomically updates a `current` symlink. Each generated Markdown file adds YAML metadata before the exact original body, retaining the entry ID, source path and hash, or task/thread/session/proposal IDs and evidence references. `manifest.json` records body and exported-file SHA-256 hashes. Old generations are retained. Do not edit or add files in the export; manual changes are rejected. Correct knowledge through 247C and approved proposals.

`knowledgeExportStatus` is a read-only RPC returning enablement, the real generation directory, revision, document count and latest export error. `knowledgeExport` refreshes it immediately. A failed export leaves the previous generation in place and never rolls back an accepted proposal. OpenKnowledge 0.13.0 refuses symlink roots: direct CLI use must target the real generation path from status, or resolve `current` first. External readers pinned to an older generation must refresh their path; the built-in search always resolves a fresh generation.

The bundle disables release outputs. 247C does not publish it or configure remote MCP access. Preserve filesystem access restrictions: the export contains the same private content and source paths as the knowledge base. An independently configured MCP reader must be pointed at a single generation, never the export parent or a workspace containing other private files.

## Retrieve

```sh
bb 247c knowledge "ExampleERP invoice status" --json
bb 247c knowledge "ExampleERP invoice status" --offset 10 --json
bb 247c knowledge --id entry-id --json
```

Agents use `c247_knowledge` with the equivalent `query`, `offset` or `id` fields. Ranked entries have excerpt bodies and `retrieval` metadata identifying the export revision, original body hash and section line ranges. Always use the returned `nextOffset`, rather than assuming a page size. Reading by ID returns the complete original database entry. Empty queries and the Knowledge base panel retain the existing full-document browse/search behavior.

Retrieval prioritizes title matches for the first query word and preserves literal all-word matches from SQLite, then includes OpenKnowledge's ranked section context. Structural/link expansion is disabled. The CLI receives an approximate 2,400-token target; returned bodies have a separate hard limit of 9,600 UTF-16 code units per page. Long excerpts are marked as truncated. Line ranges refer to source sections, which may be longer than the returned excerpts. `engineEstimatedTokens` describes the CLI's packet before 247C merges literal matches and clips excerpts; it is not a model tokenizer measurement of the final response.

`total` counts the selected candidate documents, not all potentially relevant documents in the corpus. `search.limited` makes that distinction explicit. The search is approximate; mixed-language queries, client names and synonyms may need refinement. It does not translate queries or verify whether historical facts are still current.

If the executable, export or result is invalid, search falls back to the existing SQLite keyword search and returns `search.engine: "sqlite"` with `fallbackReason`. SQLite fallback has its existing full-document response and pagination limits. Original reads remain available independently of OpenKnowledge. Validation warnings caused by existing document markup or links are reported as a count; bodies are not silently repaired.

## Disable or recover

Clear `openKnowledgeExecutable` to restore the existing database search. Clear `knowledgeDirectory` as well to stop export. If those values are in a private settings patch, update the patch too. No knowledge migration or database rollback is needed. To recover from a modified export, select a new empty dedicated directory and let 247C rebuild it. Keep or remove the old export manually according to local retention requirements.
