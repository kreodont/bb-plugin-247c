const routeId = "[A-Za-z0-9_-]{1,120}";

export function deskRoute(subPath: string) {
  const value = subPath.replace(/^\/+|\/+$/g, "");
  const origin = value.match(new RegExp(`(?:^|/)thread/(${routeId})$`));
  const path = origin ? value.slice(0, origin.index) : value;
  return { path, threadId: origin?.[1], focusTaskId: path.match(new RegExp(`^day/[^/]+/task/(${routeId})$`))?.[1] };
}

export function withThread(path: string, threadId?: string) {
  return threadId ? `${path}/thread/${threadId}` : path;
}

export function taskDayPath(date: string, taskId?: string, threadId?: string) {
  return withThread(`day/${date}${taskId ? `/task/${taskId}` : ""}`, threadId);
}

export function taskReviewPath(taskId: string, sessionId: string, threadId?: string) {
  return withThread(`${taskId}/session/${sessionId}`, threadId);
}

export function taskProposalPath(taskId: string, sessionId: string, threadId?: string) {
  // Resolve through the session so partial reviews and refreshed proposals keep
  // the same link while their proposal identity changes.
  return withThread(`${taskId}/session/${sessionId}/proposal`, threadId);
}
