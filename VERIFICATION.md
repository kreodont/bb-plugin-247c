# Release 0.4.0 verification

- TypeScript typecheck passed against the pinned BB Plugin SDK 0.4.53.
- 222 backend/frontend tests passed. A realtime UI test explicitly flushes React updates before inspecting a conflicting draft.
- Six recovery tests verify live WAL capture, SQLite integrity, preservation of task data, pausing of incomplete execution only in the prepared copy, refusal to overwrite an existing target, checksum failures, path traversal and source exclusions.
- Real backup round trip verified in an isolated folder. The running database was not replaced.
- Source configuration is local to each BB installation. A new installation carries no account, watched channels, tasks or provider credentials.
- Build artifacts are included for installation. macOS is the verified host; other platforms require separate integration validation.
