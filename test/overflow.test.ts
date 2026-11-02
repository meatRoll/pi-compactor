import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isOverflowError } from "../src/compaction.ts";
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

test("token overflow and throttle classification stay aligned with pi", () => {
  assert.equal(isOverflowError(error("prompt is too long: 213462 tokens > 200000 maximum")), true);
  assert.equal(isOverflowError(error("Your input exceeds the context window of this model")), true);
  // A 413 mentioned only inside an unrelated body or a different status is not overflow.
  assert.equal(isOverflowError(error('custom-provider API error (400): upstream said 413 "Request body too large"')), false);
  assert.equal(isOverflowError(error("custom-provider API error (4130): invalid input")), false);
  assert.equal(isOverflowError(error("4130 failed to parse request")), false);
  assert.equal(isOverflowError(error("429 rate limit exceeded")), false);
  assert.equal(isOverflowError({ ...error('413 "Request body too large"'), stopReason: "aborted" }), false);
});
