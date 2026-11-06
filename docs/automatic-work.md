# Automatic task work

Enable **More → Automatic work → Turn on** after choosing an explicit work account and model in local 247C settings. The switch and maximum concurrent workers are local settings and survive updates. Automatic work is off on new installations.

New source proposals are validated and accepted with an automation receipt. Their task chats receive the update through a durable queue. Existing pending proposals are not swept into the new mode. Paused tasks can receive accepted dossier updates but their chats are held until manual continuation. A configured worker limit bounds automatic starts; source checks and BB's global concurrency limits remain independent.

Workers read the dossier and relevant primary source, investigate, prepare drafts and perform local work. They ask for a decision or approval before an external write, send, deployment or publication. This boundary is enforced through worker instructions and the provider's existing permission controls; the plugin does not intercept every external tool. Automatic task acceptance is never permission to modify an external system.

Work sessions stay open until you choose **Finish session** or **Pause session**. An idle chat or an incoming source update cannot end a session. Source proposals that close a task wait for its open session to finish. Other accepted updates can reach the open chat without starting a review.

Workers answer directly in the chat without a work checkpoint tool. The final answer includes the useful result and any question that needs your decision. An idle reply releases the automatic worker slot while leaving the session open. After you finish or pause, a separate recorder checks the conversation evidence. Validated task changes, facts and knowledge are accepted automatically. Reported-time estimates remain pending in Proposals and preserve manual corrections. Hourly analysis does not add a second daily time estimate while this mode is enabled. Existing calendar time rules are unchanged.

**Finish session** ends the conversation and requires the recorder to choose `done` when the whole request is complete or `waiting` (pending) otherwise. This requirement also applies when Automatic work is off; the proposed status then waits for manual acceptance. It explains the choice; it cannot silently omit the status. Reported-time confirmation stays separate. A finish action alone never proves completion or an external reply request.

**Pause session** ends and reviews the session WITHOUT making that choice. It saves useful results and a pending reported-time estimate while keeping the task open. Status changes are removed before validating or accepting a paused review, including in manual mode. It carries the task to the next calendar day's plan, retaining today's time and preserving any existing tomorrow entry. The hold survives restarts and the date changing. Use **Resume chat**, **New chat** or **Open chat** manually to release it; no next-day agent starts by itself.

The Automatic work page shows queued updates, active sessions, requests for input, paused tasks and failures. Turning the mode off prevents further automatic approvals and launches; it does not interrupt a response already running. Uncertain deliveries are never blindly retried, and conflicting proposals keep their revision checks and remain available for review.
