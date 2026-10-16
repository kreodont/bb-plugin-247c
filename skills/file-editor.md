# File editor

247C owns the **247C File Editor** file opener. It opens supported text files
from BB file links, workspaces, thread storage and pinned shortcuts. No separate
editor plugin is required. Use BB's file-opener preference to select it if a
client has pinned another provider.

Auto-save waits one second after typing. Save and Command/Ctrl+S are available.
A disk conflict stops automatic writes; Reload or explicit Overwrite resolves
it. **Show in folder** reveals the current file on its own machine without
saving or discarding edits. That host needs a desktop session. Linux may open
the parent directory when selecting an individual file is unavailable.

Updates ship the editor, worker and syntax assets. Preserve open edits before
updating. Disable an older `file-editor-save` installation after verifying the
built-in editor. Do not remove task data or change pinned paths during upgrades.
Files and shortcuts are local to their machines; this feature does not sync them.

Use synthetic files for verification. Do not read pinned credentials or other
private file contents merely to test the editor. File access uses the same BB
host and root as the selected source. The editor's RPC is an interface surface,
not authorization for an agent to edit arbitrary files.
