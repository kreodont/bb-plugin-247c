export function sourceError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}
