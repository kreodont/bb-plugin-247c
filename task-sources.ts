import type { Dossier, SyncCandidate, SyncSource, TaskSourceLink } from "./contracts.js";

// Search accepted ticket identifiers independently of the human-readable title.
// Pending proposals must not make an unaccepted association searchable.
export function taskReferenceTerms(dossier: Pick<Dossier, "facts" | "projection">, acceptedContext: string[] = []): string[] {
  const terms = new Set<string>();
  const extract = (text: string) => {
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{0,30}-[0-9]+\b/g)) terms.add(match[0]);
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) terms.add(match[0]);
  };
  for (const fact of dossier.facts) {
    if (fact.sourceRef) terms.add(fact.sourceRef);
    extract(fact.text);
  }
  acceptedContext.forEach(extract);
  for (const artifact of dossier.projection.artifacts) {
    terms.add(artifact.uri); terms.add(artifact.label);
  }
  return [...terms].filter(term => term.length <= 4096);
}

export function sourceUrl(value: string | null): URL | null {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url : null;
  } catch { return null; }
}

// Slack's /messages route is the web destination offered by its launch page.
// Rewrite navigation only; evidence and primary-source identity stay canonical.
export function sourceHref(value: string, slackInBrowser = false): string | undefined {
  const url = sourceUrl(value);
  if (!url) return undefined;
  if (!slackInBrowser || url.protocol !== "https:" || !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname)
    || !/^\/archives\/[CDG][A-Z0-9]+(?:\/p[0-9]+)?\/?$/.test(url.pathname)) return value;
  url.pathname = url.pathname.replace(/^\/archives\//, "/messages/");
  return url.href;
}

function clickUpTaskId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== "clickup.com" && !host.endsWith(".clickup.com")) return null;
  return url.pathname.match(/^\/t\/(?:[0-9]+\/)?([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
}

// Compatibility for explicit source fields retained by an earlier import.
// Other record prose remains outside the source-link projection.
function importedClickUpUrls(title: string, text: string): string[] {
  if (!text.startsWith("Источник: Legacy (Windows). Импорт по запросу пользователя.\n")
    || !/^Исходный ID: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/im.test(text)) return [];
  const extract = (value: string): URL[] => [...value.matchAll(/https?:\/\/[^\s<>"'()[\]{}\\`]+/g)]
    .map(match => sourceUrl(match[0].replace(/[.,;:!?»]+$/, "")))
    .filter((url): url is URL => !!url && !!clickUpTaskId(url));
  const urls: URL[] = [];
  const primary = text.match(/(?:^|\n)[^\n]*\(clickup_url\)\r?\n([^\r\n]+)/)?.[1];
  if (primary) urls.push(...extract(primary));
  const links = text.match(/(?:^|\n)[^\n]*\(links\)\r?\n(\[[\s\S]*?\n\])/);
  if (links) {
    try {
      const values: unknown = JSON.parse(links[1]);
      if (Array.isArray(values)) for (const value of values) {
        if (typeof value === "string") urls.push(...extract(value));
      }
    } catch { /* Malformed imported fields do not become sources. */ }
  }
  // Some older tasks kept the original ticket URL only in their notes.
  // Match the ticket named in the task title, not unrelated tickets in prose.
  const titleWords = new Set(title.toLowerCase().split(/[^a-z0-9_-]+/));
  for (const url of extract(text)) {
    if (titleWords.has(clickUpTaskId(url)!.toLowerCase())) urls.push(url);
  }
  return urls.map(url => url.href);
}

function sourceLabel(url: URL, hint?: SyncSource): string {
  const host = url.hostname.toLowerCase();
  if (host === "mail.google.com") return "Gmail message";
  if (host === "slack.com" || host.endsWith(".slack.com")) return "Slack message";
  const clickUp = clickUpTaskId(url);
  if (clickUp) return `ClickUp · ${clickUp}`;
  const issue = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/i)?.[1];
  if (issue) return `Jira · ${issue.toUpperCase()}`;
  if (host === "teams.microsoft.com") return "Teams message";
  if (["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(host)) return "Outlook message";
  if (hint === "clickup") return "ClickUp document";
  if (hint === "jira") return "Jira issue";
  return host;
}

// Derive links from accepted provenance, without editing the dossier or its revision.
export function taskSourceLinks(
  dossier: Pick<Dossier, "task" | "facts" | "proposals">,
  candidates: Iterable<SyncCandidate>,
): TaskSourceLink[] {
  const links = new Map<string, TaskSourceLink & { acceptedAt: string }>();
  const add = (value: string | null, occurredAt: string | null, acceptedAt: string, origin = false, hint?: SyncSource) => {
    const url = sourceUrl(value);
    if (!url) return;
    const existing = links.get(url.href);
    const validDate = occurredAt && Number.isFinite(Date.parse(occurredAt)) ? occurredAt : null;
    if (existing) {
      existing.origin ||= origin;
      if (acceptedAt < existing.acceptedAt) existing.acceptedAt = acceptedAt;
      existing.occurredAt ??= validDate;
      return;
    }
    links.set(url.href, { url: url.href, label: sourceLabel(url, hint), occurredAt: validDate, origin, acceptedAt });
  };
  for (const candidate of candidates) {
    if (candidate.status !== "applied" || candidate.resultTaskId !== dossier.task.id) continue;
    const records = new Set(candidate.recordFactIndexes ?? candidate.facts.map((_, i) => i));
    const refs = new Set(Object.values(candidate.changes).flatMap(change => change?.evidenceRefs ?? []));
    candidate.facts.forEach((fact, index) => {
      // A partial review retains other facts as context. Only accepted records or
      // evidence cited by accepted fields contribute prominent source links.
      if (!records.has(index) && !refs.has(`fact:${index}`)) return;
      for (const citation of fact.citations) add(citation.url, citation.occurredAt,
        candidate.resolvedAt ?? candidate.createdAt, candidate.taskId === null, citation.source);
    });
  }
  // Older and manually imported records may have a sourceRef without a sync candidate.
  for (const fact of dossier.facts) {
    add(fact.sourceRef, fact.occurredAt, fact.createdAt);
    if (fact.kind === "description") for (const url of importedClickUpUrls(dossier.task.title, fact.text)) {
      add(url, fact.occurredAt, fact.createdAt, true);
    }
  }
  for (const proposal of dossier.proposals) {
    if (proposal.status !== "applied" || !proposal.receipt) continue;
    const refs = new Set(Object.values(proposal.changes).flatMap(change => change?.evidenceRefs ?? []));
    for (const evidence of proposal.evidence) if (refs.has(evidence.ref)) {
      add(evidence.sourceRef, null, proposal.receipt.createdAt);
    }
  }
  return [...links.values()].sort((a, b) => Number(b.origin) - Number(a.origin)
    || a.acceptedAt.localeCompare(b.acceptedAt))
    .map(({ acceptedAt: _, ...link }) => link);
}
