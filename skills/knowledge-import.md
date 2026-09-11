# Importing Markdown knowledge

Import only folders or files the user explicitly asks to copy into 247C. That request authorizes importing those documents. Task dossiers and conversation proposals continue to require acceptance in the panel.

The public `importKnowledge` RPC accepts `requestId` (UUID), `source` (`label`, `hostId`, absolute `rootPath`) and `documents`. Each document requires a relative `.md` path, `title` and full UTF-8 `body`. Optional fields are `tags` and `modifiedAt` (UTC ISO timestamp or null). Import creates a text snapshot, not a dynamically read link. The source file and task dossiers are unchanged.

Read files as bytes and decode UTF-8 without normalizing line endings. Preserve the original language, Markdown, frontmatter and every section. Titles and tags support navigation; they do not replace document bodies. Git configuration files are not knowledge articles. Limits: 128 KiB per body, 500 documents and 4 MiB of JSON per request; batches up to 384 KiB are convenient. Check limits before importing and report skipped files rather than silently truncating them.

Call the RPC with a JSON POST to `/api/v1/plugins/247c/rpc/importKnowledge` on the current BB server. The response includes `imported`, `updated`, `unchanged` and `documents`. Each batch is saved transactionally. For a retry, reuse the UUID and identical input; a new snapshot requires a new UUID. Document identity consists of host, root folder and relative path. Deleting a source file does not delete its imported copy.

Search through the `knowledge` RPC or `c247_knowledge`. Pass the returned `nextOffset` as the next `offset` until it becomes null. A page contains up to 50 entries; large documents reduce the count to keep responses bounded. CLI: `bb 247c knowledge [query] --offset N --json`.

After import, read every page and verify the full relative-path inventory, exact document text and SHA-256 against the sources. Confirm that existing conversation records are preserved. Do not create artificial tasks, sessions or approvals for an import. Imported files have `kind: file`; conversation knowledge has `kind: conversation`.
