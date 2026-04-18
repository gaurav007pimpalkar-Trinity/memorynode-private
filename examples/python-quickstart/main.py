#!/usr/bin/env python3
"""MemoryNode Python quickstart: ingest -> search -> context (mirrors examples/node-quickstart)."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import httpx

BASE_URL = os.environ.get("BASE_URL", "").strip()
API_KEY = os.environ.get("API_KEY", "").strip()
USER_ID = os.environ.get("USER_ID", "beta-user").strip()
NAMESPACE = os.environ.get("NAMESPACE", "beta-default").strip()
TIMEOUT_MS = float(os.environ.get("MEMORYNODE_TIMEOUT_MS", "15000"))


def fail(msg: str) -> None:
    print(f"[python-quickstart] {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if not BASE_URL:
        fail("Missing BASE_URL")
    if not API_KEY:
        fail("Missing API_KEY")

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "content-type": "application/json",
    }
    timeout = httpx.Timeout(TIMEOUT_MS / 1000.0)

    print("[python-quickstart] starting")
    print(f"[python-quickstart] BASE_URL={BASE_URL}")
    print(f"[python-quickstart] USER_ID={USER_ID} NAMESPACE={NAMESPACE}")

    text = f"MemoryNode beta quickstart memory at {datetime.now(timezone.utc).isoformat()}"

    with httpx.Client(base_url=BASE_URL, headers=headers, timeout=timeout) as client:
        r_ingest = client.post(
            "/v1/memories",
            json={
                "user_id": USER_ID,
                "namespace": NAMESPACE,
                "text": text,
                "metadata": {"source": "python-quickstart"},
            },
        )
        if not r_ingest.is_success:
            fail(
                f"ingest failed ({r_ingest.status_code}) {r_ingest.text[:500]}",
            )
        print("\n=== INGEST ===")
        print(json.dumps({"status": r_ingest.status_code, "body": r_ingest.json()}, indent=2))

        r_search = client.post(
            "/v1/search",
            json={
                "user_id": USER_ID,
                "namespace": NAMESPACE,
                "query": "quickstart memory",
                "top_k": 3,
            },
        )
        if not r_search.is_success:
            fail(f"search failed ({r_search.status_code}) {r_search.text[:500]}")
        sj = r_search.json()
        print("\n=== SEARCH ===")
        print(
            json.dumps(
                {
                    "status": r_search.status_code,
                    "hits": len(sj.get("results") or []),
                    "body": sj,
                },
                indent=2,
            ),
        )

        r_ctx = client.post(
            "/v1/context",
            json={
                "user_id": USER_ID,
                "namespace": NAMESPACE,
                "query": "Summarize what you remember about the quickstart memory.",
                "top_k": 3,
            },
        )
        if not r_ctx.is_success:
            fail(f"context failed ({r_ctx.status_code}) {r_ctx.text[:500]}")
        cj = r_ctx.json()
        print("\n=== CONTEXT ===")
        print(
            json.dumps(
                {
                    "status": r_ctx.status_code,
                    "citations": len(cj.get("citations") or []),
                    "body": cj,
                },
                indent=2,
            ),
        )

    print("\n[python-quickstart] PASS")
    print("PASS")


if __name__ == "__main__":
    main()
