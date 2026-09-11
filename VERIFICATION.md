# Release 0.4.1 verification

- TypeScript typecheck passed against the pinned BB Plugin SDK 0.4.53.
- 231 backend/frontend tests passed, including the English interface, source collection, time editing, proposal acceptance, session recovery and provider boundaries.
- Seven language cases preserve conversation text, literal evidence and accepted task content through real SQLite: Russian, Spanish, Greek, Arabic, Chinese, Japanese and mixed-language text. These check storage and the approval workflow; model responses remain subject to the selected provider.
- English and legacy Russian launch titles recover the same worker without creating another agent.
- Six Python recovery tests passed: live WAL capture, integrity, unchanged task data, pausing incomplete execution only in the prepared copy, refusal to overwrite an existing target, checksum failures, path traversal and source exclusions.
- A fresh installation has no account identity, source profile path or watched channels. Missing source configuration returns an explicit error without making network requests.
- Source profile examples are generic. Interface translation does not migrate or translate existing database records.
- Build artifacts are included. macOS is the verified host; other platforms require separate integration validation.

The 0.4.0 recovery release was also verified with an isolated real backup/restore round trip. No running database was replaced during recovery testing.
