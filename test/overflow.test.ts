import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isOverflowError, isOverflowMessage, isRecoverableFailure } from "../src/compaction.ts";
import { response } from "./fixture.ts";

function error(errorMessage: string): AssistantMessage {
  return { ...response(), stopReason: "error", errorMessage, content: [] };
}

test("HTTP 413 request-size errors are overflow errors on pi 1.3 and 1.4", () => {
  for (const message of [
    '413 "Request body too large"',
    '413: {"message":"Request body is too large","type":"invalid_request_error","code":"request_body_too_large"}',
    '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    'github-copilot API error (413): {"message":"failed to parse request","code":""}',
    "Request body is too large",
    "Payload Too Large",
    "Request Entity Too Large",
    "HTTP 413 Request Entity Too Large",
    "413",
  ]) {
    assert.equal(isOverflowError(error(message)), true, message);
  }
});

test("token overflow and non-overflow exclusions stay aligned with pi", () => {
  assert.equal(isOverflowError(error("prompt is too long: 213462 tokens > 200000 maximum")), true);
  assert.equal(isOverflowError(error("Your input exceeds the context window of this model")), true);
  // pi checks its non-overflow patterns before every overflow pattern, including 413.
  assert.equal(isOverflowError(error("413 rate limit exceeded")), false);
  assert.equal(isOverflowError(error("custom-provider API error (413): too many requests")), false);
  assert.equal(isOverflowError(error("Throttling error: 413 too many tokens")), false);
  assert.equal(isOverflowError(error("Service unavailable: 413")), false);
  // A 413 mentioned only inside an unrelated body or a different status is not overflow.
  assert.equal(isOverflowError(error('custom-provider API error (400): upstream said 413 "Request body too large"')), false);
  assert.equal(isOverflowError(error("custom-provider API error (4130): invalid input")), false);
  assert.equal(isOverflowError(error("4130 failed to parse request")), false);
  assert.equal(isOverflowError(error("429 rate limit exceeded")), false);
  assert.equal(isOverflowError({ ...error('413 "Request body too large"'), stopReason: "aborted" }), false);
});

test("silent overflow and recoverable length stops follow pi's classification", () => {
  const silent = { ...response(), usage: { ...response().usage, input: 200_001, totalTokens: 200_002 } };
  assert.equal(isOverflowMessage(silent, 200_000), true);
  assert.equal(isOverflowMessage(silent, 0), false);
  assert.equal(isOverflowMessage({ ...silent, usage: response().usage }, 200_000), false);
  assert.equal(isOverflowMessage(error('413 "Request body too large"'), 200_000), true);

  const filled = { ...response(), stopReason: "length" as const, usage: { ...response().usage, input: 199_000, output: 0, totalTokens: 199_000 } };
  assert.equal(isOverflowMessage(filled, 200_000), true);
  assert.equal(isOverflowMessage({ ...filled, usage: { ...filled.usage, output: 1 } }, 200_000), false);

  const truncated = { ...response(), stopReason: "length" as const, usage: { ...response().usage, output: 1 } };
  assert.equal(isRecoverableFailure(truncated, 8_192), true);
  assert.equal(isRecoverableFailure({ ...truncated, usage: { ...truncated.usage, output: 8_192 } }, 8_192), false);
  assert.equal(isRecoverableFailure(truncated, 0), false);
  assert.equal(isRecoverableFailure(response(), 8_192), false);
  assert.equal(isRecoverableFailure(error('413 "Request body too large"'), 0), true);
});
