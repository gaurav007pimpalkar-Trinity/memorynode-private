# Node Quickstart Example

Minimal ingest -> search -> context flow using MemoryNode API.

## Prereqs

- Node.js 20+
- A valid MemoryNode API key

## Run

### Bash

```bash
export BASE_URL="https://<your-api-host>"
export API_KEY="mn_live_..."
export USER_ID="beta-user-1"
export NAMESPACE="demo"
node examples/node-quickstart/index.mjs
```

### PowerShell

```powershell
$env:BASE_URL="https://<your-api-host>"
$env:API_KEY="mn_live_..."
$env:USER_ID="beta-user-1"
$env:NAMESPACE="demo"
node examples/node-quickstart/index.mjs
```

## Expected output

- `INGEST` section with `memory_id`
- `SEARCH` section with at least one result
- `CONTEXT` section with `context_text` and citations
- final `PASS` line
