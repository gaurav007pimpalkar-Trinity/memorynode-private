# Python quickstart

Minimal **ingest → search → context** flow using the MemoryNode HTTP API (same behavior as [examples/node-quickstart](../node-quickstart/README.md)).

## Prereqs

- Python **3.10+**
- `pip install -r requirements.pip` (installs **httpx**)

## Run

### Bash

```bash
export BASE_URL="https://api.memorynode.ai"
export API_KEY="mn_live_..."
export USER_ID="beta-user-1"
export NAMESPACE="demo"
python examples/python-quickstart/main.py
```

### PowerShell

```powershell
$env:BASE_URL="https://api.memorynode.ai"
$env:API_KEY="mn_live_..."
$env:USER_ID="beta-user-1"
$env:NAMESPACE="demo"
python examples/python-quickstart/main.py
```

## Expected output

- `INGEST` section with `memory_id`
- `SEARCH` with hits when data is visible
- `CONTEXT` with `context_text` / citations
- Final lines include **`PASS`** (simple health check for scripts / CI)

## Docs

- [Start here](../../docs/start-here/README.md)
- [Build mode](../../docs/external/API_USAGE.md)
