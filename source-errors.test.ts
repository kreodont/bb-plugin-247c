import { expect, it } from "vitest";
import { sourceResponseFailure, sourceThrownFailure } from "./source-errors.js";

it("does not classify quota metadata or identifiers as rate limits", () => {
  const data = { error: true, message: "Issue APP-429 is missing.", rateLimit: { remaining: 399 }, headers: { status: "503" } };
  expect(sourceResponseFailure({}, data)).toMatchObject({ message: "Issue APP-429 is missing.", retryable: false, rateLimited: false });
  expect(sourceResponseFailure({}, { rateLimit: { remaining: 0 } })).toBeNull();
});

it("gives an explicit permanent status precedence over transient words", () => {
  expect(sourceResponseFailure({}, { statusCode: 403, message: "Permission to see rate limit settings denied." })).toMatchObject({ retryable: false, rateLimited: false });
  expect(sourceResponseFailure({ statusCode: 503 }, { message: "Try again." })).toMatchObject({ retryable: true, rateLimited: false });
});

it.each(["HTTP 503: unavailable", "503 Service unavailable", "status code: 502"])("recognizes a status in a plain MCP error: %s", text => {
  expect(sourceResponseFailure({ isError: true }, { text })).toMatchObject({ retryable: true, rateLimited: false });
});

it.each(["ratelimited", "rate_limit_exceeded", "Too many requests", "HTTP 429: quota exhausted"])("recognizes an actual transport rate limit: %s", message => {
  expect(sourceThrownFailure(new Error(message))).toMatchObject({ retryable: true, rateLimited: true });
});

it("preserves the permanent status in a transport-wrapped MCP error", () => {
  const payload = { statusCode: 404, message: "Issue missing.", rateLimit: { remaining: 399 } };
  const raw = { result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] } };
  expect(sourceThrownFailure(new Error(`Streamable HTTP error\ndata: ${JSON.stringify(raw)}`))).toMatchObject({ message: "HTTP 404: Issue missing.", retryable: false, rateLimited: false });
});
