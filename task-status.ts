export const taskStatuses = ["open", "waiting", "done", "archived"] as const;
export type TaskStatus = typeof taskStatuses[number];
export const taskStatusNames: Record<TaskStatus, string> = { open: "Open", waiting: "Waiting for response", done: "Done", archived: "Archived" };
export const isLiveTask = (status: string | null | undefined) => status === "open" || status === "waiting";
export const statusNeedsStoppedSession = (before: TaskStatus, after: TaskStatus) => !isLiveTask(before) || !isLiveTask(after);
