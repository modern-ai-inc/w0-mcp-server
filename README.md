# w0-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Modern AI's Brand Recommendation Rate lookup** -- ask any MCP-compatible AI assistant (Claude, ChatGPT, etc.) how often a brand gets recommended by AI search and chat surfaces.

**Live endpoint:** `https://w0-mcp-server.modernai.workers.dev`
**Health check:** `GET /health` -> `ok`
**Transport:** MCP Streamable HTTP (single POST endpoint, JSON-RPC 2.0), hand-implemented, no SDK/build step.

## What it exposes

One tool: `lookup_brand_recommendation_rate(brand: string)`.

Given a brand name, returns:
- **Recommendation Rate** -- the percentage of buyer-intent questions where the brand is the AI's #1 pick (not just mentioned).
- **Recommendation Inclusion Rate** -- the percentage of buyer-intent questions where the brand appears anywhere in the answer.

This is a free, single-brand, rate-limited lookup backed by Modern AI's Discovery product. Brands that haven't been measured yet return an honest "not measured" response rather than a fabricated number.

## Usage

Point any MCP-compatible client at `https://w0-mcp-server.modernai.workers.dev` using the Streamable HTTP transport. Example `tools/call` request body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "lookup_brand_recommendation_rate",
    "arguments": { "brand": "Brumate" }
  }
}
```

## Rate limits

Free lookups are capped per caller under Modern AI's published anti-scrape policy. A 429 response indicates the ceiling was reached for that session; Modern AI offers a commercial access tier with a higher ceiling.

## Source

`src/index.js` is the complete Worker. It is a stateless pass-through: every call forwards to Modern AI's already-deployed, already rate-limited brand-lookup service, so no separate rate limit or attack surface is introduced by this server.

`deploy.py` deploys the Worker to Cloudflare via the direct REST API. It requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and a shared `W0_MCP_RELAY_SECRET` set in the environment, and assumes the upstream gate Worker (`w0-brand-gate`) already exists in the same Cloudflare account with a matching secret.

## More about Modern AI

[Modern Discovery](https://modernai.io) measures and improves how brands show up in AI search and chat answers. This server is one of several public integration points into that data.

## Issues / notifications

This repository is monitored by Modern AI. Open an issue for bugs or questions.
