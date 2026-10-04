import type { TaskCard } from "./contracts.js";
import { isLiveTask } from "./task-status.js";

type SwitcherTask = Pick<TaskCard, "id" | "title" | "status" | "updatedAt" | "pendingCount" | "activeThreadId" | "customer">;

// Open chats come first, most recently updated on top; the rest follow by update.
export function switcherTasks<T extends SwitcherTask>(tasks: T[], query: string): T[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (task: T) => words.every(word => `${task.title} ${task.customer ?? ""}`.toLocaleLowerCase().includes(word));
  const recent = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  const live = tasks.filter(task => isLiveTask(task.status) && matches(task));
  return [...live.filter(task => task.activeThreadId).sort(recent), ...live.filter(task => !task.activeThreadId).sort(recent)];
}
