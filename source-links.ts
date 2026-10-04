export type JiraReference = { key: string; explicit: boolean };

// Quote numbers, UUID fragments and all-zero example numbers are not Jira references.
// Explicit Jira URLs retain real issue numbers, including a project named Q.
export function jiraReferenceDetails(text: string): JiraReference[] {
  text = text.replace(/\\\//g, "/");
  const urls = [...text.matchAll(/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)\b/g)].map(m => m[1]);
  const withoutUuids = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
  const bare = (withoutUuids.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? []).filter(key => !key.startsWith("Q-"));
  const explicit = new Set(urls.filter(key => !/-0+$/.test(key)));
  const references = new Map<string, JiraReference>();
  for (const key of [...bare, ...urls].filter(key => !/-0+$/.test(key))) {
    references.set(key, { key, explicit: explicit.has(key) });
  }
  return [...references.values()];
}

export function jiraReferences(text: string): string[] {
  return jiraReferenceDetails(text).map(reference => reference.key);
}

export function pullRequestReferences(text: string): string[] {
  const urls = text.replace(/\\\//g, "/").match(/https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[1-9]\d*(?=[/?#.,:;!\s"<>\\)\]|]|$)/gi) ?? [];
  return [...new Set(urls.map(url => url.toLowerCase()))];
}
