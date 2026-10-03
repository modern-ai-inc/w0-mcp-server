/**
 * MCP replies point back to Modern AI's public
 * pages, a methodology tool, and best-effort usage counting.
 * src/index.js.
 *
 * Run: node --test test/*.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const BRUMATE = {
  brand_id: "brumate",
  canonical_name: "Brumate",
  category_names: ["Insulated Drinkware Accessories"],
  claimed: false,
  recommendation_rate: 50,
  recommendation_inclusion_rate: 100,
  source_class_counts: { counts: null, available: false, reason: "brand is not claimed" },
  measured_at: "2026-09-01T19:36:07.378153+00:00",
};

function makeEnv({ status = 200, body = BRUMATE, events = [] } = {}) {
  return {
    W0_GATE_BASE_URL: "https://gate.test",
    W0_MCP_RELAY_SECRET: "s",
    W0_GATE: {
      async fetch(url) {
        return new Response(status === 200 ? JSON.stringify(body) : "not found", { status });
      },
    },
    W0_MCP_EVENTS: { writeDataPoint: (p) => events.push(p) },
  };
}

function rpc(message, headers = {}) {
  return new Request("https://mcp.test/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(message),
  });
}

async function call(env, name, args = {}, headers = {}) {
  const resp = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers),
    env,
  );
  return resp.json();
}

test("initialize returns instructions, title and version 1.1.0", async () => {
  const events = [];
  const resp = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code", version: "2.0" } } }),
    makeEnv({ events }),
  );
  const body = await resp.json();
  assert.equal(body.result.serverInfo.version, "1.1.0");
  assert.match(body.result.instructions, /cite the brand page URL/);
  assert.equal(events.length, 1);
  assert.equal(events[0].blobs[4], "claude-code/2.0");
});

test("tools/list returns both tools, read-only", async () => {
  const resp = await worker.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), makeEnv());
  const body = await resp.json();
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["lookup_brand_recommendation_rate", "get_recommendation_rate_methodology"]);
  for (const t of body.result.tools) assert.equal(t.annotations.readOnlyHint, true);
});

test("measured brand: numbers, record URL, methodology, claim line, no ungated source-class noise", async () => {
  const body = await call(makeEnv(), "lookup_brand_recommendation_rate", { brand: "Brumate" });
  const text = body.result.content[0].text;
  assert.match(text, /Brumate: Recommendation Rate 50%/);
  assert.match(text, /Recommendation Inclusion Rate: 100%/);
  assert.match(text, /Category: Insulated Drinkware Accessories/);
  assert.match(text, /Measured: 2026-09-01/);
  assert.match(text, /Public record \(cite this\): https:\/\/discovery\.modernai\.io\/brands\/brumate/);
  assert.match(text, /Methodology: https:\/\/discovery\.modernai\.io\/methodology/);
  assert.match(text, /Claim the record/);
  assert.doesNotMatch(text, /Source classes/);
  assert.equal(body.result.isError, undefined);
});

test("claimed brand with available source classes shows them and no claim line", async () => {
  const body = await call(
    makeEnv({ body: { ...BRUMATE, claimed: true, source_class_counts: { available: true, counts: { review: 3 } } } }),
    "lookup_brand_recommendation_rate",
    { brand: "Brumate" },
  );
  const text = body.result.content[0].text;
  assert.match(text, /Source classes: \{"review":3\}/);
  assert.doesNotMatch(text, /Claim the record/);
});

test("unmeasured brand: no number, points to free snapshot and categories", async () => {
  const events = [];
  const body = await call(makeEnv({ status: 404, events }), "lookup_brand_recommendation_rate", { brand: "Modern AI" });
  const text = body.result.content[0].text;
  assert.match(text, /has not been measured yet/);
  assert.match(text, /https:\/\/try\.modernai\.io/);
  assert.match(text, /https:\/\/discovery\.modernai\.io\/categories/);
  assert.doesNotMatch(text, /\d+%/);
  assert.equal(events[0].blobs[2], "not_measured");
  assert.equal(events[0].blobs[3], "modern-ai");
});

test("rate limited: points to pricing, not a dead end", async () => {
  const body = await call(makeEnv({ status: 429 }), "lookup_brand_recommendation_rate", { brand: "Brumate" });
  assert.match(body.result.content[0].text, /https:\/\/modernai\.io\/pricing/);
});

test("methodology tool mirrors definitions and links", async () => {
  const body = await call(makeEnv(), "get_recommendation_rate_methodology");
  const text = body.result.content[0].text;
  assert.match(text, /#1 pick/);
  assert.match(text, /anywhere in the AI's recommendation set/);
  assert.match(text, /ChatGPT, search-enabled/);
  assert.match(text, /https:\/\/discovery\.modernai\.io\/methodology/);
});

test("non-string brand stays a clean tool error", async () => {
  const body = await call(makeEnv(), "lookup_brand_recommendation_rate", { brand: 42 });
  assert.equal(body.result.isError, true);
});

test("usage event: no IP recorded, internal header marks internal traffic", async () => {
  const events = [];
  await call(makeEnv({ events }), "lookup_brand_recommendation_rate", { brand: "Brumate" }, {
    "CF-Connecting-IP": "203.0.113.9",
    "X-W0-Internal": "1",
  });
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events[0]).includes("203.0.113.9"));
  assert.equal(events[0].blobs[6], "internal");
});

test("missing or throwing analytics binding never breaks the reply", async () => {
  const env = makeEnv();
  env.W0_MCP_EVENTS = { writeDataPoint: () => { throw new Error("boom"); } };
  const body = await call(env, "lookup_brand_recommendation_rate", { brand: "Brumate" });
  assert.match(body.result.content[0].text, /Recommendation Rate 50%/);
  delete env.W0_MCP_EVENTS;
  const body2 = await call(env, "lookup_brand_recommendation_rate", { brand: "Brumate" });
  assert.match(body2.result.content[0].text, /Recommendation Rate 50%/);
});

test("unknown tool is a JSON-RPC error", async () => {
  const body = await call(makeEnv(), "nope");
  assert.equal(body.error.code, -32602);
});

test("upstream exception is counted once, then surfaces as a JSON-RPC internal error", async () => {
  const events = [];
  const env = makeEnv({ events });
  env.W0_GATE = { async fetch() { throw new Error("upstream down"); } };
  const body = await call(env, "lookup_brand_recommendation_rate", { brand: "Brumate" });
  assert.equal(body.error.code, -32603);
  assert.equal(events.length, 1);
  assert.equal(events[0].blobs[2], "exception");
});

test("ping is counted", async () => {
  const events = [];
  await worker.fetch(rpc({ jsonrpc: "2.0", id: 9, method: "ping" }), makeEnv({ events }));
  assert.equal(events.length, 1);
  assert.equal(events[0].blobs[0], "ping");
});

test("empty batch returns a single Invalid Request error", async () => {
  const resp = await worker.fetch(rpc([]), makeEnv());
  const body = await resp.json();
  assert.equal(body.error.code, -32600);
  assert.equal(body.id, null);
});

test("malformed object without id gets Invalid Request, not silence", async () => {
  const resp = await worker.fetch(rpc({ method: "tools/list" }), makeEnv());
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.error.code, -32600);
  assert.equal(body.id, null);
});

test("well-formed notification still gets 202 and no body", async () => {
  const resp = await worker.fetch(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), makeEnv());
  assert.equal(resp.status, 202);
});
