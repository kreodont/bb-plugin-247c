import { expect, it, vi } from "vitest";
import { parseSourceConfig } from "./source-config.js";
import { connectSources } from "./source-connectors.js";
import { normalizeCalendarEvent } from "./calendar-reader.js";

it("a fresh installation has no personal identity or watched channels", async () => {
  const config = parseSourceConfig("{}");
  expect(config.expectedEmail).toBe("");
  expect(config.profilePath).toBe("");
  expect(config.jiraSite).toBe("");
  expect(config.jiraProjects).toEqual([]);
  expect(config.slackGroups).toEqual([]);
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const result = await connectSources(new AbortController().signal, config);
    expect(result.gmail).toMatchObject({ error: expect.stringContaining("expectedEmail") });
    const missingProfile = await connectSources(new AbortController().signal, { ...config, expectedEmail: "owner@example.com" });
    expect(missingProfile.gmail).toMatchObject({ error: expect.stringContaining("profilePath") });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it("validates an installation's exact Jira project keys", () => {
  expect(parseSourceConfig('{"jiraProjects":["APP","OPS","APP"]}').jiraProjects).toEqual(["APP", "OPS"]);
  for (const value of ["APP-", "app", "APP,OPS", 'APP") OR 1=1']) expect(() => parseSourceConfig(JSON.stringify({ jiraProjects: [value] }))).toThrow();
});

it("rejects unknown settings and unsafe Jira sites", () => {
  expect(() => parseSourceConfig('{"token":"do-not-store-here"}')).toThrow();
  expect(() => parseSourceConfig('{"jiraSite":"https://example.net/path"}')).toThrow();
  expect(parseSourceConfig('{"expectedEmail":"owner@example.com","jiraSite":"example.atlassian.net"}').expectedEmail).toBe("owner@example.com");
});

it("uses the selected calendar for event keys and declined invitations", () => {
  const event = { id: "same-event", start: { dateTime: "2026-09-11T08:00:00+03:00" }, end: { dateTime: "2026-09-11T09:00:00+03:00" } };
  const a = normalizeCalendarEvent(event, undefined, "one@example.com")!;
  const b = normalizeCalendarEvent(event, undefined, "two@example.com")!;
  expect(a.key).not.toBe(b.key);
  expect(a.calendarId).toBe("one@example.com");
  expect(normalizeCalendarEvent({ ...event, attendees: [{ email: "one@example.com", responseStatus: "declined" }] }, a, "one@example.com")?.status).toBe("declined");
});
