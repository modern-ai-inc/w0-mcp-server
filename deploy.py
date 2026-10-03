"""Deploy the w0-mcp-server Worker to Cloudflare via the REST API.

Uploads a single-file Worker implementing MCP's Streamable HTTP transport,
with a plain-text env var binding pointing at the upstream brand-lookup gate
a Service Binding used to reach it in-process (see src/index.js for why
a plain fetch() between two workers.dev Workers does not work), and an
optional Workers Analytics Engine binding for anonymous usage counts.

Reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and W0_MCP_RELAY_SECRET
from the process environment. This script assumes a Worker named
"w0-brand-gate" already exists in the same Cloudflare account and that its
secrets store includes a matching W0_MCP_RELAY_SECRET value.

Usage:
    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... W0_MCP_RELAY_SECRET=... \
        python3 deploy.py
"""
import json
import os
import sys
from pathlib import Path

import requests

SERVER_DIR = Path(__file__).resolve().parent

SCRIPT_NAME = "w0-mcp-server"
GATE_BASE_URL = "https://w0-brand-gate.modernai.workers.dev"
UPSTREAM_SERVICE_NAME = "w0-brand-gate"


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    relay_secret = os.environ.get("W0_MCP_RELAY_SECRET")
    if not token or not account_id:
        print("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID must be set in the environment", file=sys.stderr)
        return 1
    if not relay_secret:
        print("W0_MCP_RELAY_SECRET must be set in the environment -- required so this Worker "
              "and the upstream gate share the same relay-identity secret.", file=sys.stderr)
        return 1

    headers = {"Authorization": f"Bearer {token}"}
    base = f"https://api.cloudflare.com/client/v4/accounts/{account_id}"

    index_js = (SERVER_DIR / "src" / "index.js").read_text()

    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2026-08-24",
        "bindings": [
            {"type": "plain_text", "name": "W0_GATE_BASE_URL", "text": GATE_BASE_URL},
            # Service Binding, not a public fetch() -- see src/index.js.
            {"type": "service", "name": "W0_GATE", "service": UPSTREAM_SERVICE_NAME},
            # Optional anonymous usage counts (Workers Analytics Engine).
            {"type": "analytics_engine", "name": "W0_MCP_EVENTS", "dataset": "w0_mcp_events"},
        ],
    }

    files = {
        "metadata": (None, json.dumps(metadata), "application/json"),
        "index.js": ("index.js", index_js, "application/javascript+module"),
    }

    print(f"Uploading {SCRIPT_NAME} ...")
    resp = requests.put(f"{base}/workers/scripts/{SCRIPT_NAME}", headers=headers, files=files, timeout=60)
    body = resp.json()
    if not body.get("success") and any(e.get("code") == 10089 for e in body.get("errors") or []):
        # Analytics Engine not enabled on the account: deploy without usage
        # counting. The Worker treats a missing W0_MCP_EVENTS binding as a no-op.
        print("WARNING: Analytics Engine is not enabled on this account; deploying without "
              "usage counting.", file=sys.stderr)
        metadata["bindings"] = [b for b in metadata["bindings"] if b.get("type") != "analytics_engine"]
        files["metadata"] = (None, json.dumps(metadata), "application/json")
        resp = requests.put(f"{base}/workers/scripts/{SCRIPT_NAME}", headers=headers, files=files, timeout=60)
        body = resp.json()
    if not body.get("success"):
        print(f"UPLOAD FAILED ({resp.status_code}): {json.dumps(body.get('errors'), indent=2)}", file=sys.stderr)
        return 1
    print("Upload OK.")

    print("Setting W0_MCP_RELAY_SECRET (idempotent -- safe to repeat every deploy) ...")
    resp = requests.put(
        f"{base}/workers/scripts/{SCRIPT_NAME}/secrets",
        headers={**headers, "Content-Type": "application/json"},
        json={"name": "W0_MCP_RELAY_SECRET", "text": relay_secret, "type": "secret_text"},
        timeout=30,
    )
    body = resp.json()
    if not body.get("success"):
        print(f"SECRET SET FAILED ({resp.status_code}): {json.dumps(body.get('errors'), indent=2)}", file=sys.stderr)
        return 1
    print("Relay secret set.")

    print("Enabling workers.dev subdomain for the script ...")
    resp = requests.post(
        f"{base}/workers/scripts/{SCRIPT_NAME}/subdomain",
        headers={**headers, "Content-Type": "application/json"},
        json={"enabled": True},
        timeout=30,
    )
    body = resp.json()
    if not body.get("success"):
        print(f"SUBDOMAIN ENABLE FAILED ({resp.status_code}): {json.dumps(body.get('errors'), indent=2)}", file=sys.stderr)
        return 1
    print("workers.dev route enabled.")

    resp = requests.get(f"{base}/workers/subdomain", headers=headers, timeout=30)
    body = resp.json()
    sub = (body.get("result") or {}).get("subdomain")
    if sub:
        print(f"LIVE MCP ENDPOINT: https://{SCRIPT_NAME}.{sub}.workers.dev")
    else:
        print("Deployed; account-level workers.dev subdomain not set yet (enable once in dash).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
