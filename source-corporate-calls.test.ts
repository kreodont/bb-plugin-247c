import { afterEach, expect, it } from "vitest";
import { fixture } from "./test-support.js";
import { connectorCall } from "./source-sync-test-support.js";
import { callSource, readSourceCalls } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
it("recognizes only corporate source reads and keeps search results separate from full messages", async () => {
  const f = await fixture(); hosts.push(f);
  const examples = [
    ["claude_ai_ClickUp.clickup_get_document_pages", { document_id: "doc", page_ids: ["page"] }, "clickup", true],
    ["mcp__claude_ai_ClickUp__clickup_get_task", { task_id: "task" }, "clickup", true],
    ["claude_ai_ClickUp.clickup_get_task_comments", { task_id: "task" }, "clickup", true],
    ["claude_ai_ClickUp.clickup_get_threaded_comments", { comment_id: "comment" }, "clickup", true],
    ["claude_ai_ClickUp.clickup_search", {}, null, false],
    ["claude_ai_Microsoft_365.read_resource", { uri: "mail:///messages/message%3D" }, "outlook", true],
    ["mcp__claude_ai_Microsoft_365__read_resource", { uri: "teams:///chats/chat/messages/message" }, "teams", true],
    ["m365.read_resource", { uri: "teams:///teams/team/channels/channel/messages/message/replies" }, "teams", true],
    ["m365.read_resource", { uri: "teams:///chats/chat/messages" }, "teams", false],
    ["m365.outlook_email_search", {}, "outlook", false],
    ["m365.chat_message_search", {}, "teams", false],
    ["m365.teams_list_channel_messages", {}, "teams", false],
    ["claude_ai_ClickUp.clickup_update_task", {}, null, false],
    ["m365.outlook_send_mail", {}, null, false],
    ["m365.read_resource", { uri: "file:///mail/messages/x" }, null, false],
    ["other.read_resource", { uri: "mail:///messages/x" }, null, false],
    ["m365.read_resource", { uri: "sharepoint:///item" }, null, false],
    ["exec_command", { uri: "teams:///chats/chat/messages/message" }, null, false],
    ["ToolSearch", { query: "clickup_get_task" }, null, false],
  ] as const;
  for (const [name, args, source] of examples) {
    expect(callSource(name, args)).toBe(source);
    connectorCall(f, "review", name, args, { id: "message", text: "Please review." });
  }
  const calls = await readSourceCalls(f.bb, "review");
  expect(calls.map(c => [c.tool, c.source, c.read])).toEqual(examples.filter(e => e[2]).map(e => [e[0], e[2], e[3]]));
});
it("retains failure and truncation flags on corporate receipts", async () => {
  const f = await fixture(); hosts.push(f);
  connectorCall(f, "review", "claude_ai_ClickUp.clickup_get_task", { task_id: "task" }, { isError: true, message: "Forbidden" });
  connectorCall(f, "review", "m365.read_resource", { uri: "mail:///messages/message" }, { id: "message" },
    { outputPreview: { totalChars: 90000 } });
  const calls = await readSourceCalls(f.bb, "review");
  expect(calls[0]).toMatchObject({ source: "clickup", read: true, completed: false });
  expect(calls[1]).toMatchObject({ source: "outlook", read: true, truncated: true });
});
