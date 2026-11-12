import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  inferProviderFailureKind,
  OrchestrationV2ProviderFailure,
  providerFailureKindFromHttpStatus,
  resolveProviderFailureKind,
} from "./orchestrationV2.ts";

describe("provider failure kinds", () => {
  it("maps HTTP statuses to failure kinds", () => {
    expect(providerFailureKindFromHttpStatus(401)).toBe("authentication");
    expect(providerFailureKindFromHttpStatus(402)).toBe("quota");
    expect(providerFailureKindFromHttpStatus(429)).toBe("quota");
    expect(providerFailureKindFromHttpStatus(404)).toBe("model-unavailable");
    expect(providerFailureKindFromHttpStatus(413)).toBe("invalid-request");
    expect(providerFailureKindFromHttpStatus(529)).toBe("provider-busy");
    expect(providerFailureKindFromHttpStatus(504)).toBe("transport");
    expect(providerFailureKindFromHttpStatus(408)).toBe("transport");
    expect(providerFailureKindFromHttpStatus(302)).toBeUndefined();
  });

  it("infers kinds from codes, texts and socket errors", () => {
    const infer = (message: string, code: string | null = null) =>
      inferProviderFailureKind({ code, message, class: "provider_error" });
    expect(infer("x", "api_error_503")).toBe("provider-busy");
    expect(infer('{"type":"rate_limit_error"}')).toBe("quota");
    expect(infer("fetch failed: ECONNRESET")).toBe("transport");
    expect(infer("prompt is too long: 210000 tokens")).toBe("context-length");
    expect(infer("something else")).toBe("unknown");
    expect(inferProviderFailureKind({ code: null, message: "x", class: "usage_limit" })).toBe(
      "quota",
    );
  });

  it("keeps a recorded kind and decodes records without one", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2ProviderFailure);
    const old = decode({ class: "transport_error", message: "lost", code: null, retryable: true });
    expect(old.kind).toBeUndefined();
    expect(resolveProviderFailureKind(old)).toBe("transport");
    const recorded = decode({ ...old, kind: "unresponsive" });
    expect(resolveProviderFailureKind(recorded)).toBe("unresponsive");
  });
});
