# Modern AI Brand Recommendation Rate (MCP server)

Ask your AI assistant how often AI search picks a brand **first**.

This [Model Context Protocol](https://modelcontextprotocol.io) server gives any MCP client (Claude Code, Claude Desktop, Cursor, VS Code, or your own agent) free, single-brand access to **Recommendation Rate** data from [Modern Discovery](https://modernai.io) by Modern AI.

- **Live endpoint:** `https://w0-mcp-server.modernai.workers.dev`
- **Transport:** MCP Streamable HTTP (JSON-RPC 2.0)
- **Cost:** free, rate-limited, no sign-up and no API key

## What is Recommendation Rate?

Recommendation Rate reports whether the AI *picks a brand first*, not only whether it mentions the brand.

| Metric | Meaning |
|---|---|
| **Recommendation Rate** | Percentage of buyer-intent questions where the brand is the AI's #1 pick. The headline number. |
| **Recommendation Inclusion Rate** | Percentage of buyer-intent questions where the brand appears anywhere in the AI's recommendation set. |

A brand can show up in most answers and still lose the final pick to a competitor. The two numbers together show that gap.

Each brand is measured inside a real competitive category, on ChatGPT with search enabled, and re-measured monthly. Every result carries its measured date and a link to the brand's public record. Unmeasured brands return no number. Nothing is estimated.

Full definitions: [discovery.modernai.io/methodology](https://discovery.modernai.io/methodology)
Measured categories: [discovery.modernai.io/categories](https://discovery.modernai.io/categories)

## Comparisons

Modern AI publishes side-by-side comparisons of Modern Discovery with other AI visibility tools:

- [All tools in one table](https://modernai.io/compare)
- [Modern Discovery vs Profound](https://modernai.io/compare/modern-discovery-vs-profound)
- [Modern Discovery vs Scrunch](https://modernai.io/compare/modern-discovery-vs-scrunch)
- [Modern Discovery vs Semrush](https://modernai.io/compare/modern-discovery-vs-semrush)
- [Modern Discovery vs Conductor](https://modernai.io/compare/modern-discovery-vs-conductor)
- [Modern Discovery vs Ahrefs Brand Radar](https://modernai.io/compare/modern-discovery-vs-ahrefs-brand-radar)
- [Modern Discovery vs Peec AI](https://modernai.io/compare/modern-discovery-vs-peec-ai)

Modern Discovery is AI recommendation intelligence software that measures how often ChatGPT, Gemini, Claude, Perplexity and Google's AI answers recommend your brand, and why. It is sometimes grouped with GEO (generative engine optimization) and AI search visibility tools.

## Connect

**Claude Code**

```bash
claude mcp add --transport http modern-ai-recommendation-rate https://w0-mcp-server.modernai.workers.dev
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "modern-ai-recommendation-rate": {
      "url": "https://w0-mcp-server.modernai.workers.dev"
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "modern-ai-recommendation-rate": {
      "type": "http",
      "url": "https://w0-mcp-server.modernai.workers.dev"
    }
  }
}
```

**Claude Desktop / claude.ai:** add a custom connector with the URL above.

Then ask: *"What is Brumate's AI Recommendation Rate?"*

## Tools

| Tool | What it returns |
|---|---|
| `lookup_brand_recommendation_rate(brand)` | Recommendation Rate, Recommendation Inclusion Rate, category, measured date, and the brand's public record URL to cite. |
| `get_recommendation_rate_methodology()` | The metric definitions, surface measured, refresh cadence, and methodology links. |

Example call:

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

Example answer text:

```
Brumate: Recommendation Rate 50% (the AI's #1 pick)
Recommendation Inclusion Rate: 100% (appears anywhere in the answer)
Category: Insulated Drinkware Accessories
Surface: ChatGPT, search-enabled
Measured: 2026-09-01T19:36:07.378153+00:00
Public record (cite this): https://discovery.modernai.io/brands/brumate
Methodology: https://discovery.modernai.io/methodology
```

## Brand not measured yet?

The server says so and does not guess. Request a free AI recommendation snapshot at [try.modernai.io](https://try.modernai.io). If your brand is already measured, claim its public record from the brand page.

## Limits and plans

Free lookups are single-brand and rate-limited per caller to stop bulk scraping. For ongoing monthly monitoring and higher volume, see [Modern Discovery plans](https://modernai.io/pricing).

## Privacy

The server keeps anonymous usage counts. For each initialize, tools/list, tools/call and ping request it records: the method, the tool name, the outcome, the looked-up brand name (lowercased, at most 80 characters), the client name and version (sent at initialize), the user agent, an internal-or-external label, and the server version. It does not store IP addresses or any other request content.

## Source

`src/index.js` is the complete Worker, with no build step. `deploy.py` deploys it to Cloudflare. Tests: `node --test test/*.js`. Issues and pull requests are welcome; see `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
