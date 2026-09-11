# Install 247C on Windows with WSL2

This installs the plugin with a new, independent database. It does not copy or
synchronize another computer's tasks, conversations or accounts.

BB's supported Windows route is [Ubuntu on WSL2](https://github.com/get-bb/bb/blob/main/docs/platform-support.md).
BB, Git, Node.js and the model provider CLIs all run in that Linux distribution.
The browser can run on Windows. Native PowerShell and CMD are not BB runtime
environments. 247C 0.4.5 supports the SDK 0.4.47 bundled with stable BB 0.42.1.
Installation and startup have been confirmed by user testing on Windows with
Ubuntu/WSL. The stable npm runtime was also verified in an isolated macOS instance.
Verify model workflows, source integrations and backups on each installation
using the setup checks below.

## 1. Prepare WSL and BB

In an administrator PowerShell, follow the [Microsoft WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install):

```powershell
wsl --install -d Ubuntu
```

Restart if requested, open Ubuntu, and complete its Linux user setup. All
remaining shell commands in this guide run inside Ubuntu.

Install Node.js 24, Git and GitHub CLI (`gh`) inside Ubuntu. Install and sign in
to the model providers you intend to use there as well. Windows-side logins do
not configure the Linux provider CLIs. BB's [package guide](https://github.com/get-bb/bb/tree/main/packages/bb-app#prerequisites)
lists supported providers and runtime requirements.

Install BB and start its server:

```sh
node --version
git --version
gh --version
npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app@0.42.1
bb-app
```

The native-module install flag is required by npm 12 and accepted by the older
supported npm versions. Keep this terminal running. Open
`http://localhost:38886` in the Windows browser. Use a second Ubuntu terminal for
the following commands; a global BB install provides both `bb-app` and `bb`.

If BB is already running but `bb` is not on `PATH`, use its CLI through npx in
the same Ubuntu distribution:

```sh
npx --package=bb-app bb settings version --json
npx --package=bb-app bb plugin list --json
```

For the commands below, replace `bb` with `npx --package=bb-app bb` as needed.
Ubuntu's `apt install bb` suggestion refers to a different program.

## 2. Install the private plugin

Authenticate with a GitHub account that can access this repository:

```sh
gh auth login
gh auth setup-git
bb plugin install 'git:https://github.com/kreodont/bb-plugin-247c.git@^0.4.5'
bb plugin list
bb 247c list --json
```

`^0.4.5` tracks stable 0.4.x releases starting at 0.4.5. Use `@v0.4.5` instead
only when an exact, pinned release is desired; pinned installs do not follow
new releases through `bb plugin update`.

If an older 247C release fails with `requires bb plugin SDK >=0.4.53, running
SDK is 0.4.47`, install 0.4.5 or later. BB 0.42.1 is already sufficient; the
error concerns the SDK bundled into the server, not the separately downloaded CLI.

The repository includes source, tests, the ready plugin build and backup tools.
BB uses the frontend build and prepares the backend and dependencies during
managed installation. Do not copy `node_modules` from
another operating system. On a new BB installation, 247C starts with an empty
database. Its live database stays in the WSL BB data directory; do not put it in
a synchronized Drive folder.

## 3. Select a project and model accounts

Create a workspace inside the WSL filesystem:

```sh
mkdir -p "$HOME/work/247c"
bb machine list
```

Use the machine ID from that output, then the project ID returned by creation:

```sh
bb project create --name 247C --root "$HOME/work/247c" --machine HOST_ID
bb plugin config 247c set threadProjectId PROJECT_ID
```

Replace `HOST_ID` and `PROJECT_ID`; do not reuse IDs from another installation.
The same project can be created through BB's interface. **Thread project** is
also available in the plugin settings. All new 247C work, review and source-check
threads use its default folder.

In the task composer, select an account and model actually available on this
installation. To reproduce automatic review across Claude and Codex, install
and authenticate both providers inside WSL. A custom corporate provider used
on another computer is a separate plugin and is not bundled with 247C.

## 4. Configure sources and daily backups

Follow [Source configuration](sources.md) and the [setup-agent guide](setup-agent.md)
for Gmail, Slack, Jira, calendar and corporate read permissions. `profilePath`
must point to the signed-in Linux Claude profile on this BB server. Use Linux
paths and this installation's account settings. Do not copy macOS Keychain data,
profile settings, project IDs or installed permission allowlists into Git.

Run a manual source check and calendar check before enabling hourly updates.
Accept proposals only after reviewing them in the 247C panel.

For backups, install Python 3.11+ and system timezone data (`tzdata`) inside
Ubuntu. Find `dataDir` with `bb status --json` and the installed plugin's
`rootDir` with `bb plugin list --json`. Run `tools/backup.py` from that plugin
directory using the [backup guide](recovery.md). Use a separate machine name and
backup subfolder for this installation.

Google Drive runs on the Windows side. Choose the intended personal account and
a local synchronized destination accessible from WSL through a Linux path such
as `/mnt/c/Users/WINDOWS_USER/...`. Check the real path and file synchronization
on that machine. The macOS File Provider upload-status check is not available
under WSL; verify that the completed archive appears in Drive.

Schedule the backup command once daily using Windows Task Scheduler invoking
WSL, or a Linux scheduler while WSL is running. Use the same Linux user, the
absolute `bb` executable path and the same BB data directory. A complete backup
requires BB and 247C to be running. `tools/schedule_macos.py` is for macOS only.

## Updates and setup verification

Back up before updating, then use:

```sh
bb plugin outdated
bb plugin update 247c
```

Before treating setup as complete, check that the plugin is running, the task
list is initially empty, a user-requested conversation receives its dossier in
the configured project, finishing produces a review proposal, and a backup
passes `tools/backup.py verify`. Record source or provider failures explicitly;
local authentication and WSL integration still need verification on the target
computer.
