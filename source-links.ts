// Quote numbers and UUID fragments are not evidence of Jira issue references.
// Explicit Jira URLs remain authoritative, including a project named Q.
export function jiraReferences(text: string): string[] {
  text = text.replace(/\\\//g, "/");
  const urls = [...text.matchAll(/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)\b/g)].map(m => m[1]);
  const withoutUuids = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
  const bare = (withoutUuids.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? []).filter(key => !key.startsWith("Q-"));
  return [...new Set([...bare, ...urls])];
}
