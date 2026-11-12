import { describe, expect, it } from "vite-plus/test";

import { threadErrorSummary } from "./orchestrationV2ThreadError.ts";

describe("threadErrorSummary lastErrorKind", () => {
  it("uses the recorded kind", () => {
    expect(
      threadErrorSummary(
        {
          class: "provider_error",
          message: "too long",
          code: null,
          retryable: false,
          kind: "context-length",
        },
        null,
      ).lastErrorKind,
    ).toBe("context-length");
  });
  it("infers a kind for older records and transport errors", () => {
    expect(
      threadErrorSummary(
        {
          class: "transport_error",
          message: "connect ECONNREFUSED 127.0.0.1:443",
          code: null,
          retryable: true,
        },
        null,
      ).lastErrorKind,
    ).toBe("transport");
  });
  it("is null without a current failure", () => {
    expect(threadErrorSummary(null, "session gone").lastErrorKind).toBeNull();
  });
});
