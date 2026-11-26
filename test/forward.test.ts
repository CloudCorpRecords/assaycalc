import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  AssaycalcClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Labreador endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/labreador-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Ruling 1 (extended fleet-wide, Rene 2026-11-15): the registration
 * comparison strips `description` fields recursively on both sides, so
 * truthful parameter descriptions added under the ruling do not break
 * the deep-equal against the captured fixture; everything else is
 * compared exactly as before.
 */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const FIT = "fit_standard_curve";
const DIET = "dietary_risk";
const POLLUTION = "pollution_indices";
const ALL_TOOLS = [FIT, DIET, POLLUTION];

const SAMPLE_RESULT = {
  content: [
    { type: "text", text: "{\"model\":\"4PL\",\"rSquared\":0.998}" },
  ],
  structuredContent: { model: "4PL", rSquared: 0.998 },
};

const FIT_ARGS = {
  concentrations: [0.1, 1, 10, 100],
  signals: [0.05, 0.4, 1.2, 2.1],
};
const DIET_ARGS = {
  ingestionRateKgPerDay: 0.02,
  bodyWeightKg: 70,
  elements: [
    { name: "Hg", concentrationMgPerKg: 0.5, rfdMgPerKgDay: 0.0001 },
  ],
};
const POLLUTION_ARGS = {
  elements: [{ name: "Pb", sample: 45, baseline: 20 }],
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "labreador", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new AssaycalcClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* CLI helpers. */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "assaycalc-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 3 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 3);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 3 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Fit ELISA standard curve (4PL/5PL)",
        "Dietary health risk (EDI, THQ, HI, CR)",
        "Pollution indices (CF, Igeo, PLI)",
      ],
    );
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(FIT).description, /4PL or 5PL logistic curve/);
    assert.match(defOf(DIET).description, /Estimated Daily Intake/);
    assert.match(defOf(POLLUTION).description, /Pollution Load Index/);
    for (const tool of TOOL_DEFS) {
      assert.match(tool.description, /Labreador citation/);
    }
  });

  it("carries the required arrays exactly as captured", () => {
    assert.deepEqual(schemaOf(defOf(FIT)).required, [
      "concentrations",
      "signals",
    ]);
    assert.deepEqual(schemaOf(defOf(DIET)).required, [
      "ingestionRateKgPerDay",
      "bodyWeightKg",
      "elements",
    ]);
    assert.deepEqual(schemaOf(defOf(POLLUTION)).required, ["elements"]);
  });

  it("carries the $schema marker and object type on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  it("every tool carries additionalProperties: false, as captured", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).additionalProperties, false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(defOf(FIT)).properties), [
      "concentrations",
      "signals",
      "model",
      "sampleSignals",
    ]);
    assert.deepEqual(Object.keys(schemaOf(defOf(DIET)).properties), [
      "ingestionRateKgPerDay",
      "bodyWeightKg",
      "elements",
    ]);
    assert.deepEqual(Object.keys(schemaOf(defOf(POLLUTION)).properties), [
      "elements",
    ]);
  });

  it("fit_standard_curve carries the captured array bounds and item rules", () => {
    const props = schemaOf(defOf(FIT)).properties;
    for (const key of ["concentrations", "signals"]) {
      assert.equal(props[key].type, "array");
      assert.equal(props[key].minItems, 4);
      assert.equal(props[key].maxItems, 96);
      assert.equal(props[key].items.type, "number");
    }
    assert.equal(props.concentrations.items.exclusiveMinimum, 0);
    assert.equal("exclusiveMinimum" in props.signals.items, false);
    assert.equal(
      props.concentrations.description,
      "Nonzero standard concentrations.",
    );
    assert.equal(
      props.signals.description,
      "Measured signal (OD) for each standard, same order.",
    );
  });

  it("fit_standard_curve carries the captured model enum and default", () => {
    const model = schemaOf(defOf(FIT)).properties.model;
    assert.equal(model.type, "string");
    assert.deepEqual(model.enum, ["4PL", "5PL"]);
    assert.equal(model.default, "4PL");
    assert.equal(model.description, "Logistic model to fit.");
  });

  it("fit_standard_curve carries the captured sampleSignals bound", () => {
    const samples = schemaOf(defOf(FIT)).properties.sampleSignals;
    assert.equal(samples.type, "array");
    assert.equal(samples.maxItems, 384);
    assert.equal("minItems" in samples, false);
    assert.equal(samples.items.type, "number");
    assert.equal(
      samples.description,
      "Sample signals to convert to concentrations.",
    );
  });

  it("dietary_risk carries the captured scalar rules", () => {
    const props = schemaOf(defOf(DIET)).properties;
    for (const key of ["ingestionRateKgPerDay", "bodyWeightKg"]) {
      assert.equal(props[key].type, "number");
      assert.equal(props[key].exclusiveMinimum, 0);
    }
    assert.match(
      props.ingestionRateKgPerDay.description,
      /Food ingestion rate in kg\/day/,
    );
    assert.equal(props.bodyWeightKg.description, "Body weight in kg.");
  });

  it("dietary_risk carries the captured element item schema", () => {
    const elements = schemaOf(defOf(DIET)).properties.elements;
    assert.equal(elements.type, "array");
    assert.equal(elements.minItems, 1);
    assert.equal(elements.maxItems, 40);
    assert.equal(elements.items.type, "object");
    assert.deepEqual(Object.keys(elements.items.properties), [
      "name",
      "concentrationMgPerKg",
      "rfdMgPerKgDay",
      "csf",
    ]);
    assert.deepEqual(elements.items.required, [
      "name",
      "concentrationMgPerKg",
      "rfdMgPerKgDay",
    ]);
    assert.equal(elements.items.properties.name.type, "string");
    assert.equal(elements.items.properties.name.maxLength, 40);
    assert.equal(elements.items.properties.concentrationMgPerKg.minimum, 0);
    assert.equal(
      elements.items.properties.rfdMgPerKgDay.exclusiveMinimum,
      0,
    );
    assert.equal(elements.items.properties.csf.exclusiveMinimum, 0);
    assert.equal(
      elements.items.properties.csf.description,
      "Cancer slope factor, (mg/kg/day)^-1.",
    );
  });

  it("pollution_indices carries the captured element item schema", () => {
    const elements = schemaOf(defOf(POLLUTION)).properties.elements;
    assert.equal(elements.type, "array");
    assert.equal(elements.minItems, 1);
    assert.equal(elements.maxItems, 40);
    assert.equal(elements.items.type, "object");
    assert.deepEqual(Object.keys(elements.items.properties), [
      "name",
      "sample",
      "baseline",
    ]);
    assert.deepEqual(elements.items.required, ["name", "sample", "baseline"]);
    assert.equal(elements.items.properties.name.maxLength, 40);
    assert.equal(elements.items.properties.sample.minimum, 0);
    assert.equal(elements.items.properties.baseline.exclusiveMinimum, 0);
    assert.equal(
      elements.items.properties.baseline.description,
      "Background/reference concentration, same unit.",
    );
  });

  it("isKnownTool recognises the built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("fit_curve"), false);
    assert.equal(isKnownTool("risk"), false);
    assert.equal(isKnownTool(""), false);
  });

  it("the MCP tools/list response deep-equals the fixture's 3 tools", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    assert.deepEqual(stripDescriptions(listed), stripDescriptions(fixture.tools));
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://labreador.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name assaycalc and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FIT, FIT_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "assaycalc", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FIT, FIT_ARGS);
    await c.callTool(POLLUTION, POLLUTION_ARGS);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LABREADOR_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new AssaycalcClient({
      fetchFn: upstream.fetchFn,
      env: { LABREADOR_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(FIT, FIT_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(FIT, FIT_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LABREADOR_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(FIT, FIT_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new AssaycalcClient({
      fetchFn: upstream.fetchFn,
      env: { LABREADOR_MCP_URL: "   " },
    });
    await c.callTool(FIT, FIT_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FIT, FIT_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LABREADOR_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new AssaycalcClient({
      fetchFn: upstream.fetchFn,
      env: { LABREADOR_API_KEY: "some-key-42" },
    });
    await c.callTool(FIT, FIT_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new AssaycalcClient({
      fetchFn: upstream.fetchFn,
      env: {
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        LABREADOR_TOKEN: "z",
      },
    });
    await c.callTool(DIET, DIET_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new AssaycalcClient({
      fetchFn: upstream.fetchFn,
      env: { LABREADOR_API_KEY: "some-key-42" },
    });
    await c.callTool(FIT, FIT_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FIT, FIT_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a fit_standard_curve call verbatim with its standards", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FIT, FIT_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, FIT);
    assert.deepEqual(params.arguments, FIT_ARGS);
  });

  it("forwards a dietary_risk call under its own name with its elements", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(DIET, DIET_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, DIET);
    assert.deepEqual(params.arguments, DIET_ARGS);
  });

  it("forwards a pollution_indices call under its own name with its elements", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(POLLUTION, POLLUTION_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, POLLUTION);
    assert.deepEqual(params.arguments, POLLUTION_ARGS);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "curve did not converge upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      POLLUTION,
      POLLUTION_ARGS,
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, POLLUTION);
    assert.deepEqual(params.arguments, POLLUTION_ARGS);
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as assaycalc error text", () => {
  it("maps a JSON-RPC error to `assaycalc error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "fit failed upstream" },
    });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "assaycalc error: fit failed upstream");
  });

  it("maps an initialize JSON-RPC error to assaycalc error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "assaycalc error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "assaycalc error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "assaycalc error: malformed response");
  });

  it("maps a non-2xx upstream status to assaycalc error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "assaycalc error: HTTP 500");
  });

  it("maps a throwing fetch to assaycalc error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^assaycalc error: /);
  });

  it("maps a throwing initialize fetch to assaycalc error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "assaycalc error: socket hang up");
  });

  it("maps a timed-out call to assaycalc error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(FIT, FIT_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^assaycalc error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, FIT, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, FIT, "concentrations=1,2,3"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid fit_standard_curve call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, FIT, FIT_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, FIT_ARGS);
  });

  it("forwards a valid dietary_risk call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, DIET, DIET_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, DIET);
    assert.deepEqual(params.arguments, DIET_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, POLLUTION, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });

  it("an MCP tools/call for an unknown tool is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({ name: "not_a_tool", arguments: {} }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(
      res.stderr,
      /fit_standard_curve, dietary_risk, pollution_indices/,
    );
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([FIT, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([FIT, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([FIT, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
