import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { checkDownloadUrl, FigmaError, Limiter } from "../src/figma/api.ts";
import {
  figmaGet,
  figmaImages,
  figmaRender,
  figmaStatus,
  readStatusCache,
  statusLine,
} from "../src/figma/connection.ts";
import { resolveToken, setKeychainReader } from "../src/figma/token.ts";
import { isolate, json } from "./isolate.ts";
import { png } from "./figma-fixture.ts";

const env = isolate();
const TOKEN = "figd_test_token_value_123";
const KEY = "AbCdEf12345";
let keychain: string | null = null;
let project = "";

beforeEach(() => {
  keychain = null;
  setKeychainReader(() => ({ token: keychain }));
  project = NodePath.join(env.home, "project");
  NodeFS.mkdirSync(project, { recursive: true });
});
afterEach(() => setKeychainReader(null));

const reject = async (p: Promise<unknown>): Promise<FigmaError> => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(FigmaError);
    return error as FigmaError;
  }
  throw new Error("expected a FigmaError");
};
const tokenHeader = (init: RequestInit | undefined) =>
  new Headers(init?.headers).get("x-figma-token");
const everyOutput = () =>
  JSON.stringify(env.calls.map((c) => c.url)) +
  NodeFS.readdirSync(env.home, { recursive: true }).join();

describe("token resolution", () => {
  it("prefers FIGMA_TOKEN, then the Keychain, else none", () => {
    expect(resolveToken()).toEqual({ token: null, source: "none" });
    keychain = TOKEN;
    expect(resolveToken()).toEqual({ token: TOKEN, source: "keychain" });
    process.env.FIGMA_TOKEN = "env-token-456";
    expect(resolveToken()).toEqual({ token: "env-token-456", source: "env" });
  });

  it("reads the Keychain once per server and forgets the token after a 401", async () => {
    let reads = 0;
    setKeychainReader(() => {
      reads++;
      return { token: TOKEN };
    });
    resolveToken();
    resolveToken();
    expect(reads).toBe(1);
    env.route("/v1/me", () => json({ status: 401, err: "Invalid token" }, 401));
    expect((await figmaStatus()).state).toBe("reconnect-required");
    resolveToken();
    expect(reads).toBe(2);
  });

  it("surfaces a Keychain failure without inventing a token", () => {
    setKeychainReader(() => ({
      token: null,
      error: "Keychain could not be read (security exit 51)",
    }));
    expect(resolveToken()).toEqual({
      token: null,
      source: "none",
      keychainError: "Keychain could not be read (security exit 51)",
    });
  });
});

describe("figma_status", () => {
  it("not-connected without a token, with no network call", async () => {
    const s = await figmaStatus();
    expect(s).toMatchObject({ state: "not-connected", tokenSource: "none" });
    expect(env.calls).toHaveLength(0);
    expect(readStatusCache()).toMatchObject({ state: "not-connected", tokenSource: "none" });
    expect(statusLine()).toMatch(/^Figma: no token/);
  });

  it("connected after GET /v1/me, cache written without the token", async () => {
    keychain = TOKEN;
    env.route(
      "api.figma.com/v1/me",
      () =>
        new Response(JSON.stringify({ id: "42", handle: "Ada", email: "ada@example.com" }), {
          headers: { "x-figma-rate-limit-type": "high" },
        }),
    );
    const s = await figmaStatus();
    expect(s).toMatchObject({
      state: "connected",
      tokenSource: "keychain",
      figmaUser: { handle: "Ada", email: "ada@example.com" },
      rateLimitType: "high",
    });
    expect(tokenHeader(env.calls[0]!.init)).toBe(TOKEN);
    expect(env.calls[0]!.init?.redirect).toBe("error");
    const cache = NodeFS.readFileSync(NodePath.join(env.home, "figma.json"), "utf8");
    expect(JSON.parse(cache)).toMatchObject({
      state: "connected",
      tokenSource: "keychain",
      figmaUserId: "42",
    });
    expect(cache).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(statusLine()).toMatch(/^Figma: token connected/);
  });

  it("401 → reconnect-required", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route("/v1/me", () => json({ status: 401, err: "Invalid token" }, 401));
    expect(await figmaStatus()).toMatchObject({ state: "reconnect-required", tokenSource: "env" });
    expect(statusLine()).toMatch(/rejected or expired/);
  });

  it("403 on /me is not a bad token: connected + identityUnknown, confirmed by a file probe", async () => {
    keychain = TOKEN;
    env.route("/v1/me", () => json({ status: 403, err: "Invalid scope" }, 403));
    env.route(`/v1/files/${KEY}/meta`, () => json({ file: { name: "X" } }));
    const s = await figmaStatus(`https://www.figma.com/design/${KEY}/X`);
    expect(s).toMatchObject({ state: "connected", identityUnknown: true });
    expect(s.note).toContain("probe");
  });

  it("network failure → unavailable", async () => {
    keychain = TOKEN;
    env.route("/v1/me", () => {
      throw new TypeError("fetch failed");
    });
    expect(await figmaStatus()).toMatchObject({ state: "unavailable" });
  });
});

describe("errors and rate limits", () => {
  it("AUTH_REQUIRED without a token, hint offers the offline routes", async () => {
    const e = await reject(figmaGet({ file: KEY, part: "file" }, project));
    expect(e.code).toBe("AUTH_REQUIRED");
    expect(e.hint).toMatch(/paste or a saved local copy/);
    expect(env.calls).toHaveLength(0);
  });

  it.each([
    [401, "AUTH_INVALID"],
    [403, "ACCESS_DENIED"],
    [404, "NOT_FOUND"],
    [400, "INVALID_INPUT"],
    [502, "TRANSPORT"],
  ])("maps HTTP %i to %s", async (status, code) => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route(`/v1/files/${KEY}`, () => json({ status, err: `failed with ${TOKEN}` }, status));
    const e = await reject(figmaGet({ file: KEY, part: "file" }, project));
    expect(e.code).toBe(code);
    expect(e.message).not.toContain(TOKEN);
    if (status === 401) expect(readStatusCache()?.state).toBe("reconnect-required");
  });

  it("429 carries Retry-After, limit type, plan tier and upgrade link", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route(
      "/v1/files/",
      () =>
        new Response("{}", {
          status: 429,
          headers: {
            "retry-after": "37",
            "x-figma-rate-limit-type": "low",
            "x-figma-plan-tier": "starter",
            "x-figma-upgrade-link": "https://www.figma.com/upgrade",
          },
        }),
    );
    const e = await reject(figmaGet({ file: KEY, part: "file" }, project));
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.rateLimit).toEqual({
      retryAfterSeconds: 37,
      rateLimitType: "low",
      planTier: "starter",
      upgradeLink: "https://www.figma.com/upgrade",
    });
    expect(e.hint).toMatch(/local-file route/);
    expect(e.toJSON()).toMatchObject({
      error: "RATE_LIMITED",
      retryAfterSeconds: 37,
      rateLimitType: "low",
    });
  });

  it("refuses JSON over 50 MB and non-JSON answers", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route(
      "/v1/files/Big0000001",
      () => new Response("{}", { headers: { "content-length": String(51 * 1024 * 1024) } }),
    );
    expect((await reject(figmaGet({ file: "Big0000001", part: "file" }, project))).code).toBe(
      "RESPONSE_TOO_LARGE",
    );
    env.route("/v1/files/Html000001", () => new Response("<html>"));
    expect((await reject(figmaGet({ file: "Html000001", part: "file" }, project))).code).toBe(
      "INVALID_RESPONSE",
    );
  });

  it("serialises calls and keeps a per-minute ceiling", async () => {
    let t = 0;
    const waits: number[] = [];
    const lim = new Limiter(
      2,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const job = () =>
      lim.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return t;
      });
    const starts = await Promise.all([job(), job(), job()]);
    expect(maxInFlight).toBe(1);
    expect(waits).toHaveLength(1);
    expect(starts[2]).toBeGreaterThanOrEqual(60_000);
  });

  it("validates input before any call", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    expect((await reject(figmaGet({ file: KEY }, project))).hint).toMatch(
      /pass a link with node-id, or use part file/,
    );
    expect(
      (await reject(figmaGet({ file: "https://evil.example/design/x/y" }, project))).code,
    ).toBe("INVALID_INPUT");
    expect((await reject(figmaRender({ file: KEY, nodes: ["Frame 1"] }, project))).hint).toMatch(
      /colon-form/,
    );
    expect((await reject(figmaImages({ file: KEY, hashes: ["ABC"] }, project))).code).toBe(
      "INVALID_INPUT",
    );
    expect(env.calls).toHaveLength(0);
  });
});

describe("figma_get", () => {
  it("nodes from the link's node-id, saved atomically, summarised", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route(`/v1/files/${KEY}/nodes?ids=7:21,9:1&depth=2&geometry=paths`, () =>
      json({
        name: "Poster",
        nodes: { "7:21": { document: { id: "7:21", name: "Hero", type: "FRAME" } }, "9:1": null },
      }),
    );
    const r = await figmaGet(
      {
        file: `https://www.figma.com/design/${KEY}/P?node-id=7-21`,
        nodes: ["7-21", "9:1", "7:21"],
        depth: 2,
        geometry: true,
      },
      project,
    );
    expect(r.summary).toEqual({
      name: "Poster",
      nodes: [
        { id: "7:21", name: "Hero", type: "FRAME" },
        { id: "9:1", missing: true },
      ],
    });
    expect(r.output).toBe(
      NodePath.join(project, ".open-herness/tmp/figma/rest", `${KEY}-nodes.json`),
    );
    expect(JSON.parse(NodeFS.readFileSync(r.output, "utf8")).name).toBe("Poster");
    expect(NodeFS.readdirSync(NodePath.dirname(r.output))).toEqual([`${KEY}-nodes.json`]);
  });

  it("maps parts to endpoints", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route(`/v1/files/${KEY}?depth=1`, () =>
      json({
        name: "F",
        lastModified: "2026-11-01",
        document: { children: [{ id: "0:1", name: "Cover" }] },
      }),
    );
    env.route(`/v1/files/${KEY}/variables/local`, () =>
      json({ meta: { variables: { a: {}, b: {} }, variableCollections: { c: {} } } }),
    );
    env.route(`/v1/files/${KEY}/component_sets`, () =>
      json({ meta: { component_sets: [1, 2, 3] } }),
    );
    expect((await figmaGet({ file: KEY, part: "file", depth: 1 }, project)).summary).toEqual({
      name: "F",
      lastModified: "2026-11-01",
      pages: [{ id: "0:1", name: "Cover" }],
    });
    expect((await figmaGet({ file: KEY, part: "variables" }, project)).summary).toMatchObject({
      counts: { "meta.variables": 2, "meta.variableCollections": 1 },
    });
    expect((await figmaGet({ file: KEY, part: "component-sets" }, project)).summary).toMatchObject({
      counts: { "meta.component_sets": 3 },
    });
  });
});

describe("figma_render and figma_images", () => {
  const CDN = "https://figma-cdn.example.com/";

  it("renders in batches of 50 and downloads without the token", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    const ids = Array.from({ length: 51 }, (_, i) => `1:${i + 1}`);
    const imageCalls: string[] = [];
    env.route("api.figma.com/v1/images/", (url) => {
      imageCalls.push(url);
      const asked = new URL(url).searchParams.get("ids")!.split(",");
      return json({
        err: null,
        images: Object.fromEntries(
          asked.map((id) => [id, id === "1:2" ? null : `${CDN}${id.replace(":", "_")}.png`]),
        ),
      });
    });
    env.route(CDN, () => new Response(new Uint8Array(png(1, 1, [1, 2, 3]))));
    const r = await figmaRender({ file: KEY, nodes: ids }, project);
    expect(imageCalls).toHaveLength(2);
    expect(imageCalls[0]).toContain("format=png&scale=2");
    expect(r.notRendered).toEqual(["1:2"]);
    expect(r.files).toHaveLength(50);
    expect(r.files[0]).toEqual({
      node: "1:1",
      path: NodePath.join(project, "assets/figma", KEY, "1-1.png"),
    });
    for (const c of env.calls.filter((c) => c.url.startsWith(CDN)))
      expect(tokenHeader(c.init)).toBeNull();
    expect(everyOutput()).not.toContain(TOKEN);
  });

  it("svg/pdf renders send no scale; instance ids are file-safe", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route("/v1/images/", (url) => {
      expect(url).not.toContain("scale=");
      return json({ images: { "I40:3;88:15": `${CDN}a.svg` } });
    });
    env.route(CDN, () => new Response("<svg/>"));
    const r = await figmaRender({ file: KEY, nodes: ["I40-3;88-15"], format: "svg" }, project);
    expect(r.files[0]!.path.endsWith("I40-3_88-15.svg")).toBe(true);
  });

  it("rejects non-https or credentialed download links", async () => {
    expect(() => checkDownloadUrl("http://cdn.example.com/x")).toThrow(FigmaError);
    expect(() => checkDownloadUrl("https://u:p@cdn.example.com/x")).toThrow(/credentials/);
    process.env.FIGMA_TOKEN = TOKEN;
    env.route("/v1/images/", () => json({ images: { "1:1": "http://cdn.example.com/x.png" } }));
    expect((await reject(figmaRender({ file: KEY, nodes: ["1:1"] }, project))).code).toBe(
      "INVALID_RESPONSE",
    );
  });

  it("download failure → TRANSPORT with the expiry hint", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route("/v1/images/", () => json({ images: { "1:1": `${CDN}gone.png` } }));
    env.route(CDN, () => new Response("expired", { status: 403 }));
    const e = await reject(figmaRender({ file: KEY, nodes: ["1:1"] }, project));
    expect(e).toMatchObject({ code: "TRANSPORT", hint: "URLs expire; run again." });
  });

  it("fetches image fills by hash into a decode folder, sniffing extensions; reports missing", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);
    env.route(`/v1/files/${KEY}/images`, () =>
      json({ meta: { images: { [a]: `${CDN}a`, [b]: null, ["d".repeat(40)]: `${CDN}d` } } }),
    );
    env.route(
      `${CDN}a`,
      () =>
        new Response(new Uint8Array(png(2, 2, [0, 0, 0])), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const out = NodePath.join(project, ".open-herness/tmp/figma/paste/images");
    const r = await figmaImages({ file: KEY, hashes: [a, b, c, a], output: out }, project);
    expect(r.files).toEqual([{ hash: a, path: NodePath.join(out, `${a}.png`) }]);
    expect(r.missing).toEqual([b, c]);
    expect(env.calls.filter((x) => x.url.startsWith(CDN))).toHaveLength(1);
  });
});

describe("token never leaks", () => {
  it("refuses a token with whitespace or non-ASCII before fetch can echo it", async () => {
    process.env.FIGMA_TOKEN = "figd_abc def\nghi";
    const e = await reject(figmaGet({ file: KEY, part: "meta" }, project));
    expect(e.code).toBe("AUTH_INVALID");
    expect(JSON.stringify(e.toJSON())).not.toContain("figd_abc");
    expect(env.calls).toHaveLength(0);
  });

  it("redacts the token from upstream error text before truncating it", async () => {
    process.env.FIGMA_TOKEN = TOKEN;
    env.route("/meta", () => json({ err: `${"x".repeat(290)} ${TOKEN}` }, 400));
    const e = await reject(figmaGet({ file: KEY, part: "meta" }, project));
    expect(e.message).not.toContain(TOKEN.slice(0, 8));
  });
});
