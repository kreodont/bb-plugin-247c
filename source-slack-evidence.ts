import type { SyncDraft } from "./contracts.js";
import type { SourceCall } from "./source-sync.js";

export type SlackTarget = { channel: string; ts: string };
type Citation = SyncDraft["facts"][number]["citations"][number];

export function slackPermalink(value: string): SlackTarget | null {
  try {
    const url = new URL(value), match = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) && match
      ? { channel: match[1], ts: `${match[2]}.${match[3]}` } : null;
  } catch { return null; }
}

// Use the channel from the actual read, never a channel mentioned in its body.
export function verifiedSlackTarget(citation: Citation, call?: SourceCall): SlackTarget | null {
  if (citation.source !== "slack" || !call || call.source !== "slack" || !call.completed || !call.read || call.truncated
    || !/(?:^|[._])slack_read_(?:thread|channel)$/.test(call.tool) || !call.output.includes(citation.quote)) return null;
  if (!call.args || typeof call.args !== "object") return null;
  const args = call.args as Record<string, unknown>;
  const channel = args.channel_id;
  if (typeof channel !== "string" || !/^[CDG][A-Z0-9]+$/.test(channel) || !/^\d{10}\.\d{6}$/.test(citation.messageId)) return null;
  const messages = [...call.output.matchAll(/Message[_ ]TS:\s*(\d{10}\.\d{6})/gi)].map(m => m[1]);
  return messages.includes(citation.messageId) ? { channel, ts: citation.messageId } : null;
}

export function slackCitationMatches(citation: Citation, call: SourceCall): boolean {
  const target = verifiedSlackTarget(citation, call), link = slackPermalink(citation.url);
  if (!target || !link || target.channel !== link.channel || target.ts !== link.ts) return false;
  const parent = new URL(citation.url).searchParams.get("thread_ts");
  return !parent || parent === (call.args as Record<string, unknown>).message_ts;
}
