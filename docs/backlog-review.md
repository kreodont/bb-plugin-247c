# Backlog review

Open **Backlog** beside Search. All open and waiting tasks are selected initially.
Uncheck individual tasks, or use Select all and Clear selection. Filtering changes
the visible rows, not the selection. **Review selected** starts one visible review
chat in the configured task project. No scheduled review is created.

The reviewer reads each selected task's accepted context, up to three recent
linked work conversations, and current Gmail, Slack or Jira source evidence.
It saves one finding per task: Ready to work, Waiting for someone, Can be closed,
Your decision, Possible duplicate, or Could not verify. Missing source access,
unreadable conversations and concurrent task edits cannot silently count as a
successful check. Unsupported source types remain unverified.

Findings appear in Results as they are saved, with source links, Open task and
Open chat. Proposed summary, status, next-step, question or blocker changes use
the existing Proposal review controls. They remain pending until accepted;
titles, priorities and reported time are preserved. Duplicate findings link to
the other task and do not merge or archive either task. An existing pending
proposal is linked explicitly instead of silently replaced.

Progress and results survive navigation, reloads and restarts. Stop review keeps
saved findings and marks the remaining tasks unchecked. An interrupted review
does not silently launch again; select tasks for a new review. History retains
previous runs. Temporary copies of linked chats are removed after their findings
are saved or the run ends. Original BB chats remain unchanged.

## Local configuration

Set `backlogProvider` to an explicitly chosen corporate provider ID,
`backlogModel` to an exact model offered by that provider, and `threadProjectId`
to the task project. These settings start blank and belong in the installation's
local settings patch, outside Git. The standard personal Claude and Codex
providers are rejected. An unavailable account or model fails before launch;
there is no fallback to another account or model. Configure source read access in
that corporate profile as described in [the setup-agent guide](setup-agent.md).

The Backlog agent has dedicated tools scoped to its selected tasks. Every proposed
change requires verified connector citations and a matching task revision. It
cannot apply proposals through those tools. Source content and past chats are
evidence, not instructions to execute external work.
