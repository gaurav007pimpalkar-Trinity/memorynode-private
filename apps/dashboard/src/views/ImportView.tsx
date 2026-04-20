import { useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, apiPostWithMeta, userFacingErrorMessage } from "../apiClient";
import { DashboardSessionAuthNote } from "../components/DashboardSessionAuthNote";
import { pathForTab } from "../consoleRoutes";
import { Panel } from "../components/Panel";
import { DOCS_BASE } from "../docsUrls";

type ImportMode = "upsert" | "skip_existing" | "error_on_conflict" | "replace_ids" | "replace_all";

/** Default server cap for POST /v1/import (see API `MAX_IMPORT_BYTES`, default 10 MB). */
const MAX_IMPORT_BYTES = 10_000_000;

const IMPORT_MODES: { value: ImportMode; label: string; description: string }[] = [
  {
    value: "upsert",
    label: "Upsert (default)",
    description: "Create new memories or update ones that already match the import keys.",
  },
  {
    value: "skip_existing",
    label: "Skip existing",
    description: "Only insert new items; do not overwrite when a memory already exists.",
  },
  {
    value: "error_on_conflict",
    label: "Error on conflict",
    description: "Fail the import if a row would conflict with data that is already stored.",
  },
  {
    value: "replace_ids",
    label: "Replace by ID",
    description: "Replace records that match incoming IDs; use when re-importing a known dataset.",
  },
  {
    value: "replace_all",
    label: "Replace all in scope",
    description: "Most destructive: replace a wide set of data per the artifact. Use with care.",
  },
];

function readFileAsBase64Payload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = fr.result;
      if (typeof dataUrl !== "string") {
        reject(new Error("read"));
        return;
      }
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    fr.onerror = () => reject(fr.error ?? new Error("read"));
    fr.readAsDataURL(file);
  });
}

export function ImportView({ isPaid }: { isPaid: boolean }): JSX.Element {
  const [artifactBase64, setArtifactBase64] = useState("");
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("upsert");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastImportRequestId, setLastImportRequestId] = useState<string | null>(null);
  const modeMeta = IMPORT_MODES.find((m) => m.value === mode) ?? IMPORT_MODES[0];

  const runImport = async () => {
    if (!artifactBase64.trim()) return;
    setBusy(true);
    setMessage(null);
    setLastImportRequestId(null);
    try {
      const { data: res, requestId } = await apiPostWithMeta<{ imported_memories: number; imported_chunks: number }>(
        "/v1/import",
        {
          artifact_base64: artifactBase64.trim(),
          mode,
        },
      );
      setLastImportRequestId(requestId ?? null);
      setMessage(`Imported ${res.imported_memories} memories and ${res.imported_chunks} chunks.`);
      setArtifactBase64("");
      setSourceName(null);
    } catch (err: unknown) {
      setLastImportRequestId(err instanceof ApiClientError ? err.requestId ?? null : null);
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!isPaid) return;
    setMessage(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setMessage(`File is larger than ${Math.round(MAX_IMPORT_BYTES / 1_000_000)} MB. Split the artifact or raise MAX_IMPORT_BYTES on the API.`);
      return;
    }
    try {
      const b64 = await readFileAsBase64Payload(file);
      setArtifactBase64(b64);
      setSourceName(`${file.name} (${(file.size / 1024).toFixed(file.size >= 102_400 ? 0 : 1)} KB)`);
    } catch {
      setMessage("Could not read that file. Try another format or paste base64 instead.");
    }
  };

  const clearPayload = () => {
    setArtifactBase64("");
    setSourceName(null);
    setMessage(null);
  };

  const onPasteAreaChange = (value: string) => {
    setArtifactBase64(value);
    setSourceName(null);
  };

  return (
    <Panel title="Import Data">
      {!isPaid ? (
        <div className="alert alert--warning" role="status">
          <div className="alert__title">Import requires a paid plan</div>
          <p className="alert__body muted small mb-sm">
            Bulk import from prepared artifacts is enabled after checkout. Open{" "}
            <Link to={pathForTab("billing")} className="import-billing-link">
              Billing
            </Link>{" "}
            to upgrade, then return here.
          </p>
        </div>
      ) : null}

      {isPaid ? <DashboardSessionAuthNote variant="writes" id="guardnote" /> : null}

      <div className="muted small">
        Upload or paste produces the same payload as{" "}
        <code className="small">POST /v1/import</code>: <code className="small">artifact_base64</code>,{" "}
        <code className="small">mode</code>. See also{" "}
        <a href={DOCS_BASE} target="_blank" rel="noopener noreferrer" className="import-docs-link">
          docs
        </a>
        .
      </div>

      <div className="field">
        <span>Artifact file</span>
        <div className="row import-file-row">
          <input
            type="file"
            aria-label="Choose artifact file to encode as base64"
            onChange={(ev) => void onFile(ev)}
            disabled={!isPaid || busy}
          />
          {sourceName ? (
            <span className="muted small">
              Loaded: <strong>{sourceName}</strong>
            </span>
          ) : null}
          {(artifactBase64.trim() || sourceName) && (
            <button type="button" className="ghost ghost--xs" onClick={clearPayload} disabled={busy || !isPaid}>
              Clear payload
            </button>
          )}
        </div>
      </div>

      <label className="field">
        <span>Artifact (base64)</span>
        <textarea
          value={artifactBase64}
          onChange={(e) => onPasteAreaChange(e.target.value)}
          rows={8}
          disabled={!isPaid || busy}
          placeholder="Paste base64 here, or choose a file above."
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span>Import mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as ImportMode)} disabled={!isPaid || busy}>
          {IMPORT_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small import-mode-hint">{modeMeta.description}</p>

      <button type="button" disabled={!isPaid || !artifactBase64.trim() || busy} onClick={() => void runImport()}>
        {busy ? "Importing..." : "Run import"}
      </button>

      {message ? (
        <div
          className={`alert mt-sm ${message.startsWith("Imported") ? "alert--success" : "alert--error"}`}
          role="status"
        >
          <div>{message}</div>
          {lastImportRequestId ? (
            <div className="alert__meta">Request ID (x-request-id): {lastImportRequestId}</div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
