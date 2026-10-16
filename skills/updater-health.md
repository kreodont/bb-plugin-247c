# Source updater health warnings

247C can monitor an existing BB script automation independently of the collection script. Configure `sourceUpdaterProjectId` and `sourceUpdaterAutomationId` in the installation's private settings patch. Both default to blank. The monitor reads the Automations plugin's public API every 30 seconds, including while the 247C panel is closed. It never launches a model, changes the schedule, resumes paused work or approves proposals.

The sidebar shows a red warning button when the automation is paused, its last meaningful run failed, a saved analysis batch needs attention, records await analysis, a check is stuck, or an expected run is missing. Clicking the warning opens **Work source updates**. Every 247C page retains a warning with the reason and time of the last successful run. The Updates page also shows healthy/running status and the next scheduled run.

An app-wide notification appears even when another BB page is open. **Dismiss notification** acknowledges that incident in the browser and across its tabs; it does not remove the sidebar warning or panel banner. **Open update status** opens the details and acknowledges the popup. Recovery clears the acknowledgement, so a later incident can notify again. Notifications require an open BB window. This feature does not send email, chat messages or operating-system push notifications.

The monitor uses the automation's actual cron expression and time zone, with a 20-minute grace period. A successfully completed evening run does not trigger an overnight or weekend warning. A missing evening run remains visible overnight. An active run gets its configured execution timeout plus one minute. Skipped/lock-collision ticks and a running retry do not clear an earlier failure. If the Automations API or schedule is unavailable, the monitor explicitly reports that health is unknown.

Script integrations should print one JSON status line with `pendingRecords`, `attentionBatches`, and a `status` of `complete`, `analysis_failed`, `attention_required` or `analysis_deferred`. Optional `analysisError.error` supplies the error explanation. A successful exit with saved attention batches or unprocessed records still raises a warning. A completed empty check should print a typed `complete` status, so it is distinguishable from a skipped run. The monitor does not display raw stdout, saved source bodies or script contents.

The last successful timestamp is taken from up to 100 recent runs that succeeded without waiting records or attention batches. Missing history is shown explicitly. Successful execution is separate from complete coverage of every source; individual source coverage and permission gaps remain in the source check details.

The read-only `updaterHealth` RPC returns the current status and timestamps. `{ "refresh": true }` forces a new status read; ordinary reads share a 30-second cache. Clearing both settings disables monitoring. Keep actual project and automation IDs out of Git.

An optional local `sourceUpdaterStatusFile` points to a script-written JSON snapshot.
The file must be absolute, at most 64 KB, and contain version 1, operation
(`check`, `analysis`, or `collection`), epoch-millisecond `finishedAt`, nullable
epoch-millisecond `collectedAt`, `pendingBatches`, and the usual status fields.
Write it atomically after completing the operation. Keep the path in the private
settings patch. The monitor reads it without running a script or model.

A newer completed manual analysis clears recovered analysis errors and queue
counts. It does not advance the last collection boundary, hide newer automation
failures, clear unrelated collection failures, resume a paused automation, or
make a missed schedule slot successful. Invalid or unreadable configured status
files report unavailable health. Blank configuration retains history-only monitoring.

## External analysis conversations

An external updater may use `scriptAnalysisStart` with a stable 64-character
hexadecimal key, its existing provider, model and reasoning level, analysis
instructions and saved context. Configure `threadProjectId` first. The bridge
creates one visible thread per key in that project's local folder and returns
its ID without navigating. Reusing a key requires exactly the same input.
An uncertain launch is recovered by its private metadata, never blindly retried.

Poll `scriptAnalysisStatus` for the frozen result. The thread submits through
`c247_script_analysis_result`; only its owning thread can submit, once. Keep
source validation, event coverage, deduplication and pending-Proposal import in
the existing updater. After import call `scriptAnalysisFinish` with `error: null`;
on failure pass a diagnostic error, which stops an active analysis. Saved results
remain available for import recovery without another model call. Do not call
start when the updater has no selected records. Retain the updater's run lock,
schedule, source settings, incremental checkpoints and empty-run skipping.

Updates shows the latest conversation and recent history. Opening a link is an
explicit user action. Follow-up discussion never changes the submitted result,
recollects sources or applies proposals. These threads are retained for review.
