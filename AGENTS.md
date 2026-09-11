# Repository conventions

All public artifacts must be in English: documentation, package metadata, interface text, comments, release notes and pull request descriptions.

Keep personal configuration out of published examples. Use generic account names, domains and paths. Source login profiles, watched channels and account-specific context belong in local BB settings, never in public documentation.

For installation or recovery work, follow [the setup-agent guide](docs/setup-agent.md). Configure corporate source reads in the target provider's local profile during an authorized setup. Keep installed permission allowlists, source inventories, profile settings, credentials and verification transcripts out of Git, including private repositories. Commit the portable policy and generic examples only.

Conversations and task content support any language chosen by the user. Do not impose the interface language on user messages, dossier records or model responses. Preserve quotations and imported documents exactly in their original language. Multilingual test fixtures and compatibility parsers are intentional.

Do not edit databases to translate the interface. Preserve existing conversations, task data, approvals, settings and source connections during upgrades.
