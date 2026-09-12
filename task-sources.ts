import type { Dossier, SyncCandidate, SyncSource, TaskSourceLink } from "./contracts.js";

export function sourceUrl(value: string | null): URL | null {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url : null;
  } catch { return null; }
}

function sourceLabel(url: URL, hint?: SyncSource): string {
  const host = url.hostname.toLowerCase();
  if (host === "mail.google.com") return "Gmail message";
  if (host === "slack.com" || host.endsWith(".slack.com")) return "Slack message";
  const issue = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/i)?.[1];
  if (issue) return `Jira · ${issue.toUpperCase()}`;
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
  for (const fact of dossier.facts) add(fact.sourceRef, fact.occurredAt, fact.createdAt);
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
