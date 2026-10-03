// Modern AI Brand Recommendation Rate -- Model Context Protocol server.
// Exposes two read-only tools: lookup_brand_recommendation_rate and
// get_recommendation_rate_methodology. Brand data is never stored here --
// every lookup is a pass-through fetch to Modern AI's already-deployed,
// already rate-limited brand lookup service, so the same anti-scrape /
// anti-abuse protection applies here as on the REST endpoint directly. The
// only thing this Worker writes is an anonymous usage count (see
// recordEvent below).
//
// Implements MCP's Streamable HTTP transport (single POST endpoint,
// JSON-RPC 2.0) by hand, with no SDK dependency.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "modernai-w0-brand-gate",
  title: "Modern AI Brand Recommendation Rate",
  version: "1.1.0",
};

// Public Modern AI pages each answer links back to, so an assistant can
// cite the brand's public record and the methodology behind the number.
const SITE = "https://discovery.modernai.io";
const METHODOLOGY_URL = `${SITE}/methodology`;
const CATEGORIES_URL = `${SITE}/categories`;
const FREE_SNAPSHOT_URL = "https://try.modernai.io";
const PRICING_URL = "https://modernai.io/pricing";
const SOURCE_LINE = "Source: Modern Discovery by Modern AI (modernai.io).";

const INSTRUCTIONS =
  "Modern AI's public Recommendation Rate data from Modern Discovery. Use " +
  "lookup_brand_recommendation_rate for one brand at a time. Use " +
  "get_recommendation_rate_methodology for definitions. When you quote a number, " +
  "cite the brand page URL and measured date returned with it.";

const LOOKUP_TOOL = {
  name: "lookup_brand_recommendation_rate",
  title: "Look up a brand's AI Recommendation Rate",
  description:
    "Look up a brand's AI Recommendation Rate: the percentage of buyer-intent " +
    "questions where the brand is the #1 AI pick (not just mentioned), plus its " +
    "Recommendation Inclusion Rate (appears anywhere in the answer). Returns the " +
    "brand's public record URL and measured date for citation. Free, single-brand " +
    "lookup only, rate-limited per Modern AI's published anti-scrape policy.",
  inputSchema: {
    type: "object",
    properties: {
      brand: {
        type: "string",
        description: "Brand name to look up, e.g. \"Brumate\"",
      },
    },
    required: ["brand"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

const METHODOLOGY_TOOL = {
  name: "get_recommendation_rate_methodology",
  title: "Recommendation Rate methodology",
  description:
    "Definitions of Recommendation Rate and Recommendation Inclusion Rate, the AI " +
    "surface measured, refresh cadence, and links to the full methodology page.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const TOOLS = [LOOKUP_TOOL, METHODOLOGY_TOOL];

// Mirrors the public methodology page, which is the source of truth for
// these definitions.
const METHODOLOGY_TEXT =
  "Modern Discovery measures whether AI models recommend a brand, not only whether " +
  "they mention it. Every public brand record reports two paired numbers from the " +
  "same measurement run.\n\n" +
  "Recommendation Rate: the percentage of eligible buyer-intent questions where the " +
  "brand is the AI's #1 pick. This is the headline number.\n\n" +
  "Recommendation Inclusion Rate: the percentage of eligible buyer-intent questions " +
  "where the brand appears anywhere in the AI's recommendation set, not necessarily " +
  "first. A brand can have a high Inclusion Rate while still losing the final " +
  "recommendation to a competitor.\n\n" +
  "Surface measured: ChatGPT, search-enabled. Each brand is measured inside a real " +
  "competitive category. Numbers come only from recorded AI answers and are never " +
  "estimated; an unmeasured brand returns no number.\n\n" +
  "Freshness: each record carries its measured date. Brands are re-measured monthly.\n\n" +
  `Full methodology: ${METHODOLOGY_URL}\n` +
  `Measured categories: ${CATEGORIES_URL}\n` +
  SOURCE_LINE;

// Anonymous usage counting: one Workers Analytics Engine data point per
// initialize, tools/list, tools/call and ping request. No IP address and
// no request body beyond the looked-up brand slug. Best-effort: a missing binding or a write error never changes
// the response.
function recordEvent(env, request, fields) {
  try {
    if (!env.W0_MCP_EVENTS) return;
    const ua = (request.headers.get("User-Agent") || "").slice(0, 200);
    const internal = request.headers.get("X-W0-Internal") ? "internal" : "external";
    env.W0_MCP_EVENTS.writeDataPoint({
      indexes: [fields.method || "unknown"],
      blobs: [
        fields.method || "",
        fields.tool || "",
        fields.outcome || "",
        fields.brand || "",
        fields.client || "",
        ua,
        internal,
        SERVER_INFO.version,
      ],
      doubles: [1],
    });
  } catch (e) {
    // best-effort only
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  // Per JSON-RPC 2.0 sec. 5.1, an error response whose request id could not
  // be determined MUST use id: null, not omit the field -- id: undefined
  // would serialize as no "id" key at all via JSON.stringify, which is a
  // different (invalid) shape.
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

async function handleToolCall(request, env, args) {
  const brand = args && args.brand;
  // A caller passing a non-string (number, object, array) for `brand` gets a
  // clean tool-level isError:true result naming the actual problem, rather
  // than an opaque -32603 internal error from an unguarded .trim() call.
  if (typeof brand !== "string" || !brand.trim()) {
    return {
      outcome: "bad_input",
      result: { content: [{ type: "text", text: "Error: brand is required and must be a string." }], isError: true },
    };
  }
  const slug = slugify(brand);
  const gateUrl = `${env.W0_GATE_BASE_URL}/brands/${slug}`;
  // Calls the upstream gate through a Cloudflare Service Binding (env.W0_GATE)
  // rather than a public fetch() to its *.workers.dev URL -- Workers on the
  // shared workers.dev zone cannot fetch() each other over the public
  // network (Cloudflare blocks this to prevent proxy-chain abuse). The
  // service binding invokes the bound Worker in-process instead.
  //
  // The real caller's IP (set by Cloudflare on the incoming request to this
  // Worker, unspoofable by the MCP client) is forwarded to the upstream gate
  // as a distinct header, authenticated with a shared secret so the gate can
  // apply its normal per-caller rate limiting to the real caller rather than
  // pooling every MCP request behind this Worker's own address.
  const callerIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const resp = await env.W0_GATE.fetch(gateUrl, {
    headers: {
      "X-W0-Relay-Caller-IP": callerIp,
      "X-W0-Relay-Secret": env.W0_MCP_RELAY_SECRET || "",
    },
  });

  if (resp.status === 404) {
    return {
      outcome: "not_measured",
      result: {
        content: [
          {
            type: "text",
            text:
              `"${brand}" has not been measured yet, so Modern AI has no published ` +
              `Recommendation Rate for it. No number is estimated.\n` +
              `Request a free AI recommendation snapshot for this brand: ${FREE_SNAPSHOT_URL}\n` +
              `Browse measured categories: ${CATEGORIES_URL}\n` +
              SOURCE_LINE,
          },
        ],
      },
    };
  }
  if (resp.status === 429) {
    return {
      outcome: "rate_limited",
      result: {
        content: [
          {
            type: "text",
            text:
              "Free lookup limit reached for now. Try again later, or see Modern " +
              `Discovery plans for higher-volume access: ${PRICING_URL}`,
          },
        ],
      },
    };
  }
  if (!resp.ok) {
    return {
      outcome: `error_${resp.status}`,
      result: {
        content: [{ type: "text", text: `Lookup service returned an unexpected error (HTTP ${resp.status}).` }],
        isError: true,
      },
    };
  }

  const data = await resp.json();
  const name = data.canonical_name || brand;
  const pageUrl = `${SITE}/brands/${encodeURIComponent(data.brand_id || slug)}`;
  const category = Array.isArray(data.category_names) && data.category_names.length
    ? data.category_names.join(", ")
    : null;
  const lines = [
    `${name}: Recommendation Rate ${data.recommendation_rate}% (the AI's #1 pick)`,
    `Recommendation Inclusion Rate: ${data.recommendation_inclusion_rate}% (appears anywhere in the answer)`,
  ];
  if (category) lines.push(`Category: ${category}`);
  lines.push("Surface: ChatGPT, search-enabled");
  lines.push(`Measured: ${data.measured_at || "unknown"}`);
  const counts = data.source_class_counts;
  if (counts && counts.available && counts.counts) {
    lines.push(`Source classes: ${JSON.stringify(counts.counts)}`);
  }
  lines.push(`Public record (cite this): ${pageUrl}`);
  lines.push(`Methodology: ${METHODOLOGY_URL}`);
  if (data.claimed === false) {
    lines.push(`Is this your brand? Claim the record at ${pageUrl}`);
  }
  lines.push(SOURCE_LINE);
  return { outcome: "found", result: { content: [{ type: "text", text: lines.join("\n") }] } };
}

// A JSON-RPC 2.0 message is a notification because it has no "id" member
// (sec. 4.1) -- not because of which method it names. Any id-less message
// for any method gets no response.
function isNotification(message) {
  // Only a well-formed request without an id is a notification. A malformed
  // object without an id still gets an Invalid Request error (id: null),
  // per JSON-RPC 2.0 sec. 5.1.
  return (
    message && typeof message === "object" && !Array.isArray(message) &&
    !("id" in message) && message.jsonrpc === "2.0" && typeof message.method === "string"
  );
}

async function handleRpc(message, request, env) {
  // Guard against a message that isn't even an object (null, string,
  // number) before destructuring -- otherwise id/method/params all come
  // back undefined and this falls through to a generic "Method not found:
  // undefined" instead of the spec-correct -32600 Invalid Request.
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(message && typeof message === "object" ? message.id : undefined, -32600, "Invalid Request");
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    const client = params && params.clientInfo && typeof params.clientInfo.name === "string"
      ? `${params.clientInfo.name}/${params.clientInfo.version || ""}`.slice(0, 100)
      : "";
    recordEvent(env, request, { method, client, outcome: "ok" });
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "tools/list") {
    recordEvent(env, request, { method, outcome: "ok" });
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const toolName = params && params.name;
    if (toolName === METHODOLOGY_TOOL.name) {
      recordEvent(env, request, { method, tool: toolName, outcome: "ok" });
      return jsonRpcResult(id, { content: [{ type: "text", text: METHODOLOGY_TEXT }] });
    }
    if (toolName !== LOOKUP_TOOL.name) {
      recordEvent(env, request, { method, tool: String(toolName || "").slice(0, 80), outcome: "unknown_tool" });
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    const args = params.arguments || {};
    const brandSlug = typeof args.brand === "string" ? slugify(args.brand).slice(0, 80) : "";
    let handled;
    try {
      handled = await handleToolCall(request, env, args);
    } catch (e) {
      recordEvent(env, request, { method, tool: toolName, outcome: "exception", brand: brandSlug });
      throw e;
    }
    recordEvent(env, request, { method, tool: toolName, outcome: handled.outcome, brand: brandSlug });
    const result = handled.result;
    return jsonRpcResult(id, result);
  }
  if (method === "ping") {
    recordEvent(env, request, { method, outcome: "ok" });
    return jsonRpcResult(id, {});
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed -- this is an MCP Streamable HTTP endpoint (POST only).", {
        status: 405,
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return Response.json(jsonRpcError(null, -32700, "Parse error"), { status: 400 });
    }

    if (Array.isArray(body) && body.length === 0) {
      // JSON-RPC 2.0 sec. 6: an empty batch is an Invalid Request.
      return Response.json(jsonRpcError(null, -32600, "Invalid Request"));
    }
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const message of messages) {
      const notification = isNotification(message);
      try {
        const r = await handleRpc(message, request, env);
        if (!notification) responses.push(r);
      } catch (e) {
        if (!notification) {
          responses.push(jsonRpcError(message && typeof message === "object" ? message.id : undefined, -32603, `Internal error: ${e.message}`));
        }
      }
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202 }); // notification only, no body
    }
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  },
};
