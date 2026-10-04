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

## Source storage in 0.5.49

New source exports and frozen task/proposal snapshots are stored as gzip blobs.
Launch settings, analysis fingerprints and page receipts remain queryable JSON.
Reading an old check reconstructs the same complete export and context; source
citations, pending proposals, recovery and incremental checks retain their data.

An interruptible background service converts existing rows one at a time. Each
conversion verifies its round trip before atomically replacing the original,
and refuses to overwrite a row changed during compression. Plain and compressed
rows remain readable together. Reloading resumes the remaining work.

After conversion, SQLite compaction reclaims the freed pages. It waits while a
source check, review or calendar import is active, and when disk space is low.
No source history is expired or deleted. Future exports are compressed on write.

Keep a pre-update backup. Compressed source storage requires 0.5.49 or newer;
rolling back to an older plugin requires its matching pre-update database.
Normal backups include the blobs and the installed reader code unchanged.

## Source checks and session status in 0.5.50

Slack reports rate limits as a bare `ratelimited` payload, sometimes inside a
transport error. Earlier versions treated it as a permanent failure, so a
throttled thread read left every run partial and the Slack checkpoint did not
advance. Rate limits now wait 5, 15 and 30 seconds before retrying; other
transient errors keep the short retry. The wait ends early if the check is
stopped or reaches its time limit.

Task cards pulse only while an agent is running a review, collection or
worker session. An open conversation waiting for the user shows a static
"Chat open since" label. No database migration is involved.

## Slack reply links in 0.5.51

A dossier can cite a Slack reply by its permalink, which names the reply and
its parent thread. The collector reads the whole parent thread, but coverage
validation required the reply's own timestamp in that read. A reply deleted
after it was cited could never satisfy that rule, so every check stayed
partial and the Slack checkpoint did not advance. Validation now requires the
complete parent thread, the same unit the collector reads.
