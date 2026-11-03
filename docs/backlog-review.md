# Backlog review

Open **Backlog** beside Search. All open and waiting tasks are selected initially.
Uncheck individual tasks, or use Select all and Clear selection. Filtering changes
the visible rows, not the selection. **Review selected** starts a visible review
chat in the configured task project, with up to three tasks per chat. Each
finished batch continues in a fresh chat with the same account and model.
The whole selection shares one progress counter. Chats open without taking focus.
No scheduled review is created.

The reviewer reads each selected task's accepted context, up to three recent
linked work conversations, and current evidence from the task's sources:
ClickUp, Microsoft 365 Outlook/Teams, Gmail, Slack or Jira. It follows the task's
source links and does not require unrelated services to be connected. Microsoft
365 search results locate messages; full message resource reads supply evidence.
It saves one finding per task: Ready to work, Waiting for someone, Can be closed,
Your decision, Duplicate, or Could not verify. Missing source access,
unreadable conversations and concurrent task edits cannot silently count as a
successful check. Unsupported source types remain unverified.

Findings appear in Results as they are saved, with source links, Open task and
Open chat. Proposed summary, status, next-step, question or blocker changes use
the existing Proposal review controls. They remain pending until accepted;
titles, priorities and reported time are preserved. Duplicate findings link to
the other task and include a proposal to close this one. Possible duplicates
that still need a decision use Your decision instead. Closing requires an
evidence-backed status proposal; a text-only recommendation is rejected.
Checks without changes explain why the accepted card needs no update.
An identical pending proposal is reused. Different pending proposals are kept
separately; accepting one may require reviewing the others again.

Completion follows the original request, not extra work invented in an earlier
AI summary. A supplied answer or link can satisfy that request without an
independent audit nobody requested. Closing proposals clear the old next step;
accepted tasks show Closed and no longer display an action to close them again.

Progress and results survive navigation, reloads and restarts. Stop review keeps
saved findings and prevents automatic continuation. A chat that ends after saving
some results continues the remaining work. A failed chat or one with no saved
progress pauses the review. **Continue review** resumes unchecked tasks without
discarding results. Unconfirmed launches are recovered without spawning a duplicate.
History retains previous runs and links to earlier batch chats.
Temporary copies of linked chats are removed after their findings
are saved or the run ends. Original BB chats remain unchanged.

## Local configuration

Set `backlogProvider` to an explicitly chosen corporate provider ID,
`backlogModel` to an exact model offered by that provider, and `threadProjectId`
to the task project. These settings start blank and belong in the installation's
local settings patch, outside Git. The standard personal Claude and Codex
providers are rejected. An unavailable account or model fails before launch;
there is no fallback to another account or model. Configure source read access in
that corporate profile as described in [the setup-agent guide](setup-agent.md).

Enable `backlogPreferClosure` locally to resolve residual doubt in favor of
closing a satisfied request with no concrete remaining obligation. Future real
follow-ups can reopen it through Proposals. This preference is supplied on each
task read, including in a review already running; no conversation restart is
needed. Unread sources and explicit unresolved requests remain visible.

The Backlog agent has dedicated tools scoped to its selected tasks. Every proposed
change requires verified connector citations and a matching task revision. It
cannot apply proposals through those tools. Source content and past chats are
evidence, not instructions to execute external work.
