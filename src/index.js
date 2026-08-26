// Modern AI Brand Recommendation Rate -- Model Context Protocol server.
// Exposes ONE tool: lookup_brand_recommendation_rate. This server has no
// state of its own -- every call is a pass-through fetch to Modern AI's
// already-deployed, already rate-limited brand lookup service, so the same
// anti-scrape / anti-abuse protection applies here as on the REST endpoint
// directly.
//
// Implements MCP's Streamable HTTP transport (single POST endpoint,
// JSON-RPC 2.0) by hand, with no SDK dependency.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "modernai-w0-brand-gate", version: "1.0.0" };

const TOOL_DEF = {
  name: "lookup_brand_recommendation_rate",
  description:
    "Look up a brand's AI Recommendation Rate: the percentage of buyer-intent " +
    "questions where the brand is the #1 AI pick (not just mentioned), plus its " +
    "Recommendation Inclusion Rate (appears anywhere in the answer). Free, single-brand " +
    "lookup only -- rate-limited per Modern AI's published anti-scrape policy.",
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
};

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
    return { content: [{ type: "text", text: "Error: brand is required and must be a string." }], isError: true };
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
      content: [
        {
          type: "text",
          text: `"${brand}" has not been measured yet -- no data published for this brand.`,
        },
      ],
    };
  }
  if (resp.status === 429) {
    return {
      content: [
        {
          type: "text",
          text: "Free lookup ceiling reached for this session. Modern AI offers a " +
            "commercial access tier with a higher ceiling -- see the gate's own " +
            "response for upgrade details.",
        },
      ],
    };
  }
  if (!resp.ok) {
    return {
      content: [{ type: "text", text: `Gate returned an unexpected error (HTTP ${resp.status}).` }],
      isError: true,
    };
  }

  const data = await resp.json();
  const text =
    `${brand} -- Recommendation Rate: ${data.recommendation_rate}% (first-choice AI pick)\n` +
    `Recommendation Inclusion Rate: ${data.recommendation_inclusion_rate}% (mentioned anywhere)\n` +
    `Source classes: ${JSON.stringify(data.source_class_counts || {})}\n` +
    `Measured at: ${data.measured_at || "unknown"}`;
  return { content: [{ type: "text", text }] };
}

// A JSON-RPC 2.0 message is a notification because it has no "id" member
// (sec. 4.1) -- not because of which method it names. Any id-less message
// for any method gets no response.
function isNotification(message) {
  return message && typeof message === "object" && !("id" in message);
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
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: [TOOL_DEF] });
  }
  if (method === "tools/call") {
    if (!params || params.name !== TOOL_DEF.name) {
      return jsonRpcError(id, -32602, `Unknown tool: ${params && params.name}`);
    }
    const result = await handleToolCall(request, env, params.arguments || {});
    return jsonRpcResult(id, result);
  }
  if (method === "ping") {
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
