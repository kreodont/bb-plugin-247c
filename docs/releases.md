# Release and recovery checks

The production installation should use
`git:https://github.com/kreodont/bb-plugin-247c.git@main`. Development belongs in
a separate Git checkout. Do not edit the downloaded installation or copy an
uncommitted working tree into production as the final delivery.

Before an update, inspect `bb plugin source 247c --json`, fetch GitHub and check
the working tree. Preserve any local differences in a private backup and in Git
before reconciling them. Keep credentials, settings, databases and verification
transcripts outside the repository.

Run `npm run typecheck`, `npm test`, `python3 -m unittest discover -s tools` and
`npm run build`. On macOS, use `TMPDIR=/private/tmp npm test` to keep temporary
path spelling consistent. Review and commit the source and generated artifacts,
then publish an immutable version tag and the main branch. Never move old tags.

Save a [verified backup](recovery.md) before updating. With a managed installation,
run `bb plugin update 247c`. Compare the resulting source commit and installed
artifact hashes with the published revision; check plugin status, saved settings,
database integrity, tasks and manual time. A successful build or matching package
version alone does not establish that the live installation was updated.

## Compatibility in 0.5.48

This release combines local navigation, review recovery, waiting status and
source-collection improvements with the customer field, ticket search and
protection against double-counting time entered from a session's conversation.

Two earlier code histories used migration 35 for different features: customer
and waiting status. The compatibility layer preserves the exact recorded
statement at 35 and adds the missing feature at 36. Both histories continue at
37. It never rewrites historical migration hashes; an unknown collision fails.

Source exports and historical check snapshots remain intact. Large databases
are supported by streaming backup verification, with a 16 GiB uncompressed
archive limit. This release does not delete source history to reduce file size.
