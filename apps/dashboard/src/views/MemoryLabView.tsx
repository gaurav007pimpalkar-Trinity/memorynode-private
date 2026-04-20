import { useEffect, useMemo, useRef, useState } from "react";
import { Panel } from "../components/Panel";
import type { MemoryRow } from "../types";
import { loadMemoryLabIdentity, persistMemoryLabIdentity } from "../memoryLabIdentity";
import { buildCurlPostJson } from "../apiCurl";
import { ApiClientError, apiDelete, apiGet, apiPost, apiPostWithMeta, userFacingErrorMessage } from "../apiClient";
import { DashboardSessionAuthNote } from "../components/DashboardSessionAuthNote";
import { ConsoleDocsDrawer } from "../components/ConsoleDocsDrawer";
import { DOCS_BASE, DOCS_QUICKSTART } from "../docsUrls";
import { mapSearchResultsToRows, type MemorySearchRow, type SearchApiResult } from "../memorySearch";

type RetrievalExplainPayload = {
  explain_requested: true;
  results: Array<{
    memory_id: string;
    chunk_id: string;
    chunk_index: number;
    score: number;
    _explain: unknown | null;
  }>;
};

const SESSION_LAST_QUERY = "mn_lab_last_query";
const SESSION_LAST_CONTEXT_Q = "mn_lab_last_context_q";
const SESSION_ACTIVE_TAB = "mn_lab_active_tab";
const CONTEXT_PREVIEW_CHARS = 6000;

type LabTabId = "search" | "context" | "explain" | "advanced";

function loadLabTab(): LabTabId {
  try {
    const v = sessionStorage.getItem(SESSION_ACTIVE_TAB);
    if (v === "search" || v === "context" || v === "explain" || v === "advanced") return v;
  } catch {
    /* ignore */
  }
  return "search";
}

function ExplainTraceBlock({ trace }: { trace: unknown }): JSX.Element {
  if (trace == null) {
    return <p className="muted small">No per-hit trace payload from the API for this row.</p>;
  }
  if (typeof trace === "object" && !Array.isArray(trace)) {
    const entries = Object.entries(trace as Record<string, unknown>);
    return (
      <dl className="memory-lab__explain-dl">
        {entries.map(([k, v]) => (
          <div key={k} className="memory-lab__explain-dl-row">
            <dt className="memory-lab__explain-dt">{k}</dt>
            <dd className="memory-lab__explain-dd">
              <pre className="memory-lab__explain-snippet-inline">{formatExplainValue(v)}</pre>
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <pre className="code-block memory-lab__explain-snippet">{formatExplainValue(trace)}</pre>;
}

function ExplainStructuredView({ payload }: { payload: RetrievalExplainPayload }): JSX.Element {
  return (
    <div className="memory-lab__explain-structured">
      {payload.results.map((r, i) => (
        <section key={`${r.chunk_id}-${r.memory_id}-${i}`} className="memory-lab__explain-hit panel--nested">
          <div className="memory-lab__explain-hit-head row-space">
            <div className="memory-lab__explain-hit-title">
              <span className="memory-lab__score-pill">{r.score.toFixed(4)}</span>
              <span className="muted small">Hit {i + 1}</span>
              <code className="memory-lab__result-id" title={r.memory_id}>
                {r.memory_id.slice(0, 14)}…
              </code>
              <span className="muted small">chunk {r.chunk_index}</span>
            </div>
          </div>
          <ExplainTraceBlock trace={r._explain} />
        </section>
      ))}
    </div>
  );
}

function formatExplainValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function summarizeExplainPayload(p: RetrievalExplainPayload): string {
  return JSON.stringify(
    {
      explain_requested: true,
      results: p.results.map((r) => ({
        memory_id: r.memory_id,
        chunk_id: r.chunk_id,
        chunk_index: r.chunk_index,
        score: r.score,
        explain: r._explain,
      })),
    },
    null,
    2,
  );
}

function stripRequestIdSuffix(message: string, requestId?: string): string {
  if (!requestId?.trim()) return message;
  const escaped = requestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(`\\s*Request ID:\\s*${escaped}\\s*$`, "i"), "").trim();
}

function labErrorMeta(err: unknown): { message: string; requestId?: string } {
  const raw = userFacingErrorMessage(err);
  let requestId: string | undefined;
  if (err instanceof ApiClientError && err.requestId?.trim()) {
    requestId = err.requestId.trim();
  } else {
    const m = raw.match(/Request ID:\s*(\S+)/i);
    if (m) requestId = m[1];
  }
  return { message: stripRequestIdSuffix(raw, requestId), requestId };
}

export function MemoryLabView({
  workspaceId,
  onLabCriteriaMet,
}: {
  workspaceId: string;
  /** Called when search returns hits or POST /v1/context returns usable context_text (onboarding step). */
  onLabCriteriaMet: () => void;
}) {
  const [subjectUserId, setSubjectUserId] = useState("");
  const [rows, setRows] = useState<MemorySearchRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [metadata, setMetadata] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [selected, setSelected] = useState<MemoryRow | null>(null);
  const [saveToHistory, setSaveToHistory] = useState(false);
  const [searchExplainEnabled, setSearchExplainEnabled] = useState(false);
  const [explainPayload, setExplainPayload] = useState<RetrievalExplainPayload | null>(null);
  const [historyRows, setHistoryRows] = useState<Array<{ id: string; query: string; created_at: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [replayLoadingId, setReplayLoadingId] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<{
    query_id: string;
    previous: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
    current: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
  } | null>(null);
  const [evalSets, setEvalSets] = useState<Array<{ id: string; name: string; created_at: string }>>([]);
  const [selectedEvalSetId, setSelectedEvalSetId] = useState<string>("");
  const [newEvalSetName, setNewEvalSetName] = useState("");
  const [evalItems, setEvalItems] = useState<Array<{ id: string; query: string; expected_memory_ids: string[] }>>([]);
  const [newEvalQuery, setNewEvalQuery] = useState("");
  const [newEvalExpectedIds, setNewEvalExpectedIds] = useState("");
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalItemsLoading, setEvalItemsLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalRunLoading, setEvalRunLoading] = useState(false);
  const [evalRunResult, setEvalRunResult] = useState<{
    item_count: number;
    avg_precision_at_k: number;
    avg_recall: number;
    items: Array<{
      eval_item_id: string;
      query: string;
      precision_at_k: number;
      recall: number;
      matched_expected_memory_ids: string[];
    }>;
  } | null>(null);
  const [evalItemsPage, setEvalItemsPage] = useState(1);
  const [evalItemsPageSize] = useState(5);
  const [expectedIdsValidationError, setExpectedIdsValidationError] = useState<string | null>(null);
  const [feedbackTraceId, setFeedbackTraceId] = useState("");
  const [feedbackUsedIds, setFeedbackUsedIds] = useState("");
  const [feedbackUnusedIds, setFeedbackUnusedIds] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [contextQuery, setContextQuery] = useState("");
  const [showNoResultsHint, setShowNoResultsHint] = useState(false);
  const [contextProbeLoading, setContextProbeLoading] = useState(false);
  const [contextProbeError, setContextProbeError] = useState<string | null>(null);
  const [curlCopied, setCurlCopied] = useState<"search" | "context" | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  /** Exact curl for the last successful POST /v1/search (same JSON + optional headers as the browser request). */
  const [lastSuccessfulSearchCurl, setLastSuccessfulSearchCurl] = useState<string | null>(null);
  /** Exact curl for the last successful POST /v1/context. */
  const [lastSuccessfulContextCurl, setLastSuccessfulContextCurl] = useState<string | null>(null);
  const [labDensity, setLabDensity] = useState<"comfortable" | "compact">(() => {
    try {
      return sessionStorage.getItem("mn_lab_density") === "compact" ? "compact" : "comfortable";
    } catch {
      return "comfortable";
    }
  });
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const [contextErrorRequestId, setContextErrorRequestId] = useState<string | null>(null);
  /** From HTTP `x-request-id` on successful POST /v1/search (paired with curl block). */
  const [searchResponseRequestId, setSearchResponseRequestId] = useState<string | null>(null);
  /** From HTTP `x-request-id` on successful POST /v1/context (paired with curl block). */
  const [contextResponseRequestId, setContextResponseRequestId] = useState<string | null>(null);
  const [contextOutputText, setContextOutputText] = useState<string | null>(null);
  const [contextOutputRaw, setContextOutputRaw] = useState(false);
  const [contextOutputExpanded, setContextOutputExpanded] = useState(false);
  const [explainDrawerOpen, setExplainDrawerOpen] = useState(false);
  /** Tab IA: identity + scope preserved across panels (no route remount). */
  const [labTab, setLabTab] = useState<LabTabId>(() => loadLabTab());
  const sessionRestored = useRef(false);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  useEffect(() => {
    const next = loadMemoryLabIdentity(workspaceId);
    setSubjectUserId(next.subjectUserId);
    setNamespace(next.namespace);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId?.trim()) return;
    persistMemoryLabIdentity(workspaceId, { subjectUserId, namespace });
  }, [workspaceId, subjectUserId, namespace]);

  useEffect(() => {
    if (!workspaceId?.trim() || sessionRestored.current) return;
    sessionRestored.current = true;
    try {
      const sq = sessionStorage.getItem(SESSION_LAST_QUERY);
      if (sq?.trim()) setQuery(sq);
      const cq = sessionStorage.getItem(SESSION_LAST_CONTEXT_Q);
      if (cq != null) setContextQuery(cq);
    } catch {
      /* ignore */
    }
  }, [workspaceId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_ACTIVE_TAB, labTab);
    } catch {
      /* ignore */
    }
  }, [labTab]);

  type SearchFilters = { metadata?: Record<string, unknown>; start_time?: string; end_time?: string };
  type SearchBody = {
    user_id: string;
    namespace?: string;
    query: string;
    page: number;
    page_size: number;
    explain?: boolean;
    filters?: SearchFilters;
  };

  /** Same JSON your app should POST to `/v1/search` (also used for Copy as curl). */
  function buildSearchBody(pageToUse: number, queryValue: string): SearchBody | null {
    if (!subjectUserId.trim() || !queryValue.trim()) return null;
    const body: SearchBody = {
      user_id: subjectUserId.trim(),
      namespace: namespace || undefined,
      query: queryValue,
      page: pageToUse,
      page_size: pageSize,
    };
    if (searchExplainEnabled) body.explain = true;
    if (metadata.trim()) {
      try {
        body.filters = { metadata: JSON.parse(metadata) as Record<string, unknown> };
      } catch {
        return null;
      }
    }
    if (start || end) {
      body.filters = body.filters || {};
      body.filters.start_time = start || undefined;
      body.filters.end_time = end || undefined;
    }
    return body;
  }

  const search = async (resetPage = true, fetchPage?: number) => {
    if (!subjectUserId.trim()) {
      setError("Enter an end-user ID — the same subject your app sends as user_id / userId to the API (not your dashboard login).");
      return;
    }
    const pageToUse = fetchPage ?? (resetPage ? 1 : page);
    if (resetPage) setPage(1);
    else setPage(pageToUse);
    setLoading(true);
    setError(null);
    setErrorRequestId(null);
    setShowNoResultsHint(false);
    try {
      const queryValue = query.trim();
      if (!queryValue) {
        setRows([]);
        setTotal(0);
        setHasMore(false);
        setExplainPayload(null);
        setLastSuccessfulSearchCurl(null);
        setSearchResponseRequestId(null);
        setError("Enter a search query to run semantic search.");
        return;
      }
      const body = buildSearchBody(pageToUse, queryValue);
      if (!body) {
        setLastSuccessfulSearchCurl(null);
        setSearchResponseRequestId(null);
        setError("Metadata filter must be valid JSON.");
        return;
      }

      const historyHeaders = saveToHistory ? { "x-save-history": "true" } : undefined;
      // Same JSON as curl below; browser uses dashboard session cookies + CSRF — not Bearer — see DashboardSessionAuthNote.
      const { data: res, requestId: searchRid } = await apiPostWithMeta<{
        results: SearchApiResult[];
        total?: number;
        has_more?: boolean;
      }>("/v1/search", body, historyHeaders);
      setSearchResponseRequestId(searchRid ?? null);
      setLastSuccessfulSearchCurl(buildCurlPostJson("/v1/search", body, historyHeaders));
      try {
        sessionStorage.setItem(SESSION_LAST_QUERY, queryValue);
      } catch {
        /* ignore */
      }
      const rawResults = res.results ?? [];
      const mappedRows = mapSearchResultsToRows(rawResults);
      setRows((prev) => {
        const next = resetPage ? mappedRows : [...prev, ...mappedRows];
        if (next.length > 0) {
          queueMicrotask(() => onLabCriteriaMet());
        }
        return next;
      });
      if (searchExplainEnabled) {
        const slice = rawResults.map((row) => ({
          memory_id: row.memory_id,
          chunk_id: row.chunk_id,
          chunk_index: row.chunk_index,
          score: row.score,
          _explain: row._explain ?? null,
        }));
        setExplainPayload((prev) => {
          if (resetPage) return { explain_requested: true, results: slice };
          const mergedExplain = [...(prev?.results ?? []), ...slice];
          return { explain_requested: true, results: mergedExplain };
        });
      } else {
        setExplainPayload(null);
      }
      setTotal(res.total ?? null);
      setHasMore(res.has_more ?? false);
      setShowNoResultsHint(Boolean(resetPage && mappedRows.length === 0 && queryValue.trim().length > 0));
      if (saveToHistory) {
        void loadHistory();
      }
    } catch (err: unknown) {
      setLastSuccessfulSearchCurl(null);
      setSearchResponseRequestId(null);
      const { message, requestId } = labErrorMeta(err);
      setError(message);
      setErrorRequestId(requestId ?? null);
    } finally {
      setLoading(false);
    }
  };

  const copySearchCurl = () => {
    const q = query.trim();
    if (!subjectUserId.trim()) {
      setError("Enter an end-user ID first — the same value your app sends as user_id / userId.");
      return;
    }
    if (!q) {
      setError("Enter a search query so we can build the JSON body.");
      return;
    }
    const body = buildSearchBody(1, q);
    if (!body) {
      setError("Metadata filter must be valid JSON.");
      return;
    }
    const historyHeaders = saveToHistory ? { "x-save-history": "true" } : undefined;
    void navigator.clipboard.writeText(buildCurlPostJson("/v1/search", body, historyHeaders));
    setCurlCopied("search");
    window.setTimeout(() => setCurlCopied(null), 2500);
  };

  const copyContextCurl = () => {
    if (!subjectUserId.trim()) {
      setError("Enter an end-user ID first — the same value your app sends as user_id / userId.");
      return;
    }
    const q = contextQuery.trim();
    if (!q) {
      setError("Enter a context query (what you’d send with POST /v1/context).");
      return;
    }
    const ctxBody: { user_id: string; query: string; namespace?: string } = {
      user_id: subjectUserId.trim(),
      query: q,
    };
    if (namespace.trim()) ctxBody.namespace = namespace.trim();
    void navigator.clipboard.writeText(buildCurlPostJson("/v1/context", ctxBody));
    setCurlCopied("context");
    window.setTimeout(() => setCurlCopied(null), 2500);
  };

  const runContextProbe = async () => {
    if (!subjectUserId.trim() || !contextQuery.trim()) {
      setContextProbeError("Enter an end-user ID and a context query.");
      return;
    }
    setContextProbeLoading(true);
    setContextProbeError(null);
    setContextErrorRequestId(null);
    setContextResponseRequestId(null);
    try {
      const ctxBody: { user_id: string; query: string; namespace?: string } = {
        user_id: subjectUserId.trim(),
        query: contextQuery.trim(),
      };
      if (namespace.trim()) ctxBody.namespace = namespace.trim();
      const { data: res, requestId: ctxRid } = await apiPostWithMeta<{ context_text?: string }>("/v1/context", ctxBody);
      setContextResponseRequestId(ctxRid ?? null);
      setLastSuccessfulContextCurl(buildCurlPostJson("/v1/context", ctxBody));
      const rawText = typeof res.context_text === "string" ? res.context_text : "";
      setContextOutputText(rawText);
      setContextOutputExpanded(false);
      try {
        sessionStorage.setItem(SESSION_LAST_CONTEXT_Q, contextQuery.trim());
      } catch {
        /* ignore */
      }
      const text = rawText.trim();
      if (text.length > 0) {
        onLabCriteriaMet();
      }
    } catch (err: unknown) {
      setLastSuccessfulContextCurl(null);
      setContextResponseRequestId(null);
      setContextOutputText(null);
      const { message, requestId } = labErrorMeta(err);
      setContextProbeError(message);
      setContextErrorRequestId(requestId ?? null);
    } finally {
      setContextProbeLoading(false);
    }
  };

  const loadMore = () => {
    void search(false, page + 1);
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await apiGet<{ history?: Array<{ id: string; query: string; created_at: string }> }>("/v1/search/history?limit=20");
      setHistoryRows(res.history ?? []);
    } catch (err: unknown) {
      setHistoryError(userFacingErrorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  };

  const replayQuery = async (queryId: string) => {
    setReplayLoadingId(queryId);
    setReplayError(null);
    try {
      const res = await apiPost<{
        query_id: string;
        previous: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
        current: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
      }>("/v1/search/replay", { query_id: queryId });
      setReplayResult(res);
      setFeedbackTraceId(res.query_id);
    } catch (err: unknown) {
      setReplayError(userFacingErrorMessage(err));
    } finally {
      setReplayLoadingId(null);
    }
  };

  const loadEvalSets = async () => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      const res = await apiGet<{ eval_sets?: Array<{ id: string; name: string; created_at: string }> }>("/v1/evals/sets");
      const sets = res.eval_sets ?? [];
      setEvalSets(sets);
      if (sets.length > 0 && !selectedEvalSetId) {
        setSelectedEvalSetId(sets[0].id);
      }
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalLoading(false);
    }
  };

  const createEvalSet = async () => {
    if (!newEvalSetName.trim()) return;
    setEvalLoading(true);
    setEvalError(null);
    try {
      const res = await apiPost<{ eval_set?: { id: string; name: string; created_at: string } }>("/v1/evals/sets", {
        name: newEvalSetName.trim(),
      });
      setNewEvalSetName("");
      await loadEvalSets();
      if (res.eval_set?.id) setSelectedEvalSetId(res.eval_set.id);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalLoading(false);
    }
  };

  const deleteEvalSet = async (id: string) => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      await apiDelete<{ deleted: boolean; id: string }>(`/v1/evals/sets/${encodeURIComponent(id)}`);
      if (selectedEvalSetId === id) setSelectedEvalSetId("");
      setEvalItems([]);
      setEvalRunResult(null);
      await loadEvalSets();
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalLoading(false);
    }
  };

  const loadEvalItems = async (evalSetId: string) => {
    if (!evalSetId) {
      setEvalItems([]);
      return;
    }
    setEvalItemsLoading(true);
    setEvalError(null);
    try {
      const res = await apiGet<{ eval_items?: Array<{ id: string; query: string; expected_memory_ids: string[] }> }>(
        `/v1/evals/items?eval_set_id=${encodeURIComponent(evalSetId)}`,
      );
      setEvalItems(res.eval_items ?? []);
      setEvalItemsPage(1);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalItemsLoading(false);
    }
  };

  const createEvalItem = async () => {
    if (!selectedEvalSetId || !newEvalQuery.trim()) return;
    setEvalItemsLoading(true);
    setEvalError(null);
    setExpectedIdsValidationError(null);
    try {
      const expectedIds = newEvalExpectedIds
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const invalidExpected = expectedIds.filter((id) => !uuidRe.test(id));
      if (invalidExpected.length > 0) {
        setExpectedIdsValidationError(
          `Expected values must be memory row UUIDs from the API (not end-user ids): ${invalidExpected.slice(0, 3).join(", ")}${invalidExpected.length > 3 ? "…" : ""}`,
        );
        return;
      }
      await apiPost<{ eval_item?: { id: string } }>("/v1/evals/items", {
        eval_set_id: selectedEvalSetId,
        query: newEvalQuery.trim(),
        expected_memory_ids: expectedIds,
      });
      setNewEvalQuery("");
      setNewEvalExpectedIds("");
      await loadEvalItems(selectedEvalSetId);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalItemsLoading(false);
    }
  };

  const exportEvalRunJson = () => {
    if (!evalRunResult) return;
    const blob = new Blob([JSON.stringify(evalRunResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eval-run-${selectedEvalSetId || "set"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const submitContextFeedback = async () => {
    const traceId = feedbackTraceId.trim() || replayResult?.query_id;
    if (!traceId) {
      setFeedbackMessage("Trace ID is required.");
      return;
    }
    const parseCsv = (raw: string): string[] => raw.split(",").map((v) => v.trim()).filter(Boolean);
    setFeedbackBusy(true);
    setFeedbackMessage(null);
    try {
      await apiPost<{ accepted: boolean }>("/v1/context/feedback", {
        trace_id: traceId,
        query_id: replayResult?.query_id,
        chunk_ids_used: parseCsv(feedbackUsedIds),
        chunk_ids_unused: parseCsv(feedbackUnusedIds),
      });
      setFeedbackMessage("Feedback submitted.");
    } catch (err: unknown) {
      setFeedbackMessage(userFacingErrorMessage(err));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const deleteEvalItem = async (id: string) => {
    if (!selectedEvalSetId) return;
    setEvalItemsLoading(true);
    setEvalError(null);
    try {
      await apiDelete<{ deleted: boolean; id: string }>(`/v1/evals/items/${encodeURIComponent(id)}`);
      await loadEvalItems(selectedEvalSetId);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalItemsLoading(false);
    }
  };

  const runEvalSet = async () => {
    if (!selectedEvalSetId) return;
    if (!subjectUserId.trim()) {
      setEvalError("Enter an end-user ID above before running an eval (same subject as search).");
      return;
    }
    setEvalRunLoading(true);
    setEvalError(null);
    try {
      const res = await apiPost<{
        item_count: number;
        avg_precision_at_k: number;
        avg_recall: number;
        items: Array<{
          eval_item_id: string;
          query: string;
          precision_at_k: number;
          recall: number;
          matched_expected_memory_ids: string[];
        }>;
      }>("/v1/evals/run", {
        eval_set_id: selectedEvalSetId,
        user_id: subjectUserId.trim(),
        namespace: namespace || undefined,
        top_k: 5,
        search_mode: "hybrid",
      });
      setEvalRunResult(res);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalRunLoading(false);
    }
  };

  useEffect(() => {
    if (!workspaceId?.trim()) return;
    void loadEvalSets();
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedEvalSetId) return;
    void loadEvalItems(selectedEvalSetId);
  }, [selectedEvalSetId]);

  useEffect(() => {
    setEvalItemsPage((p) => Math.min(Math.max(1, p), Math.max(1, Math.ceil(evalItems.length / evalItemsPageSize))));
  }, [evalItems, evalItemsPageSize]);

  const replayPrevIds = useMemo(
    () => new Set((replayResult?.previous?.results ?? []).map((r) => r.chunk_id).filter((id): id is string => Boolean(id))),
    [replayResult],
  );
  const replayCurrIds = useMemo(
    () => new Set((replayResult?.current?.results ?? []).map((r) => r.chunk_id).filter((id): id is string => Boolean(id))),
    [replayResult],
  );
  const replayAdded = useMemo(() => Array.from(replayCurrIds).filter((id) => !replayPrevIds.has(id)), [replayCurrIds, replayPrevIds]);
  const replayRemoved = useMemo(() => Array.from(replayPrevIds).filter((id) => !replayCurrIds.has(id)), [replayCurrIds, replayPrevIds]);
  const replayUnchanged = useMemo(() => Array.from(replayCurrIds).filter((id) => replayPrevIds.has(id)), [replayCurrIds, replayPrevIds]);
  const evalItemsTotalPages = Math.max(1, Math.ceil(evalItems.length / evalItemsPageSize));
  const pagedEvalItems = useMemo(
    () => evalItems.slice((evalItemsPage - 1) * evalItemsPageSize, evalItemsPage * evalItemsPageSize),
    [evalItems, evalItemsPage, evalItemsPageSize],
  );

  if (!workspaceId?.trim()) {
    return (
      <Panel title="Memory Lab">
        <div className="alert alert--warning" role="status">
          Connect a project in Get started to open Memory Lab.
        </div>
        <div className="muted small">Open the <strong>Projects</strong> tab, pick a project, then <strong>Connect project</strong>.</div>
      </Panel>
    );
  }

  const openMemory = async (id: string) => {
    try {
      const res = await apiGet<MemoryRow>(`/v1/memories/${id}`);
      setSelected(res);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    }
  };

  return (
    <Panel title="Memory Lab">
      <div className={`memory-lab ${labDensity === "compact" ? "memory-lab--compact" : ""}`}>
        <div className="memory-lab__toolbar row-space">
          <span className="muted small">Uses the same REST endpoints as production; curl examples use an API key.</span>
          <button type="button" className="ghost ghost--xs" onClick={() => setDocsOpen(true)}>
            View docs
          </button>
        </div>
        <DashboardSessionAuthNote variant="lab" id="auth-parity-memory-lab" />

        <section className="memory-lab__identity panel--elevated" aria-label="Subject and scope">
          <h4 className="memory-lab__micro-zone">Inputs · subject & scope</h4>
          <p className="muted small">Shared across Search, Context, Explain, and Advanced — persisted per project in this browser.</p>
          <div className="row memory-lab__two-col">
            <label className="field memory-lab__field-grow">
              <span>End-user ID</span>
              <span
                className="field-hint muted small"
                title="Matches user_id / userId in POST /v1/search and POST /v1/context (your product’s subject, not the dashboard account)."
              >
                Same as <code className="small">user_id</code> or <code className="small">userId</code> in API JSON — not your dashboard login.
              </span>
              <input
                value={subjectUserId}
                onChange={(e) => setSubjectUserId(e.target.value)}
                placeholder="e.g. user_123 or your auth subject id"
                autoComplete="off"
              />
            </label>
            <label className="field memory-lab__field-grow">
              <span>Scope / namespace</span>
              <span
                className="field-hint muted small"
                title="Optional. Same as namespace on search/context APIs; may map to containerTag depending on your integration."
              >
                Optional. Same as <code className="small">namespace</code> (and scope / <code className="small">containerTag</code>) in the API.
              </span>
              <input
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="Omit unless your app scopes by namespace"
              />
            </label>
          </div>
        </section>

        <nav className="memory-lab__tablist" role="tablist" aria-label="Memory Lab tools">
          <button
            id="memory-lab-tab-search"
            type="button"
            role="tab"
            aria-selected={labTab === "search"}
            aria-controls="memory-lab-panel-search"
            className={`memory-lab__tab${labTab === "search" ? " memory-lab__tab--active" : ""}`}
            onClick={() => setLabTab("search")}
          >
            Search
          </button>
          <button
            id="memory-lab-tab-context"
            type="button"
            role="tab"
            aria-selected={labTab === "context"}
            aria-controls="memory-lab-panel-context"
            className={`memory-lab__tab${labTab === "context" ? " memory-lab__tab--active" : ""}`}
            onClick={() => setLabTab("context")}
          >
            Context
          </button>
          <button
            id="memory-lab-tab-explain"
            type="button"
            role="tab"
            aria-selected={labTab === "explain"}
            aria-controls="memory-lab-panel-explain"
            className={`memory-lab__tab${labTab === "explain" ? " memory-lab__tab--active" : ""}`}
            onClick={() => setLabTab("explain")}
          >
            Explain
          </button>
          <button
            id="memory-lab-tab-advanced"
            type="button"
            role="tab"
            aria-selected={labTab === "advanced"}
            aria-controls="memory-lab-panel-advanced"
            className={`memory-lab__tab${labTab === "advanced" ? " memory-lab__tab--active" : ""}`}
            onClick={() => setLabTab("advanced")}
          >
            Advanced
          </button>
        </nav>

        <div
          role="tabpanel"
          id="memory-lab-panel-search"
          aria-labelledby="memory-lab-tab-search"
          hidden={labTab !== "search"}
          className="memory-lab__tab-panel"
        >
        <section className="memory-lab__controls panel--elevated" aria-label="Memory search">
          <div className="memory-lab__bar">
            <div className="memory-lab__heading-cluster">
              <span className="memory-lab__section-title">Search</span>
              <span className="api-endpoint-chip" translate="no">
                POST /v1/search
              </span>
            </div>
            <button
              type="button"
              className="ghost ghost--xs"
              onClick={() => {
                setLabDensity((d) => {
                  const next = d === "compact" ? "comfortable" : "compact";
                  try {
                    sessionStorage.setItem("mn_lab_density", next);
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }}
            >
              {labDensity === "compact" ? "Comfortable layout" : "Compact layout"}
            </button>
          </div>
          <p className="muted small">Semantic retrieval — same JSON body as Copy as curl below.</p>
          <h4 className="memory-lab__micro-zone">Search inputs</h4>
      <label className="field">
        <span>Search query</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Semantic query string for POST /v1/search body field "query"'
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void search(true);
            }
          }}
        />
      </label>
      <div className="row">
        <input value={metadata} onChange={(e) => setMetadata(e.target.value)} placeholder='Metadata JSON {"tag":"x"}' />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} title="Start date" />
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} title="End date" />
      </div>
      <div className="row">
        <label>
          <input type="checkbox" checked={saveToHistory} onChange={(e) => setSaveToHistory(e.target.checked)} />
          Save to history (for replay)
        </label>
        <label title="Adds explain: true to the search request and shows structured trace JSON when present">
          <input type="checkbox" checked={searchExplainEnabled} onChange={(e) => setSearchExplainEnabled(e.target.checked)} />
          Retrieval explain (debug)
        </label>
        <button type="button" className="ghost" onClick={() => void search(true)} disabled={loading || !query.trim()}>
          Re-run
        </button>
        <button
          type="button"
          onClick={() => search(true)}
          disabled={loading}
          className={loading ? "btn-loading" : undefined}
          {...(loading ? { "aria-busy": true as const } : {})}
        >
          {loading ? (
            <>
              <span className="btn-spinner" aria-hidden />
              Searching…
            </>
          ) : (
            "Search"
          )}
        </button>
        <button
          className="ghost"
          onClick={() => {
            setRows([]);
            setTotal(null);
            setHasMore(false);
            setExplainPayload(null);
            setShowNoResultsHint(false);
            setLastSuccessfulSearchCurl(null);
            setSearchResponseRequestId(null);
            setContextOutputText(null);
            setContextResponseRequestId(null);
            setErrorRequestId(null);
          }}
        >
          Clear
        </button>
        <button type="button" className="ghost" onClick={copySearchCurl}>
          {curlCopied === "search" ? "Copied" : "Copy as curl (search)"}
        </button>
      </div>
      <div className="muted small mt-sm">
        Curl uses <code>Authorization: Bearer YOUR_API_KEY</code> — replace with a key from <strong>API Keys</strong>. This page uses your signed-in session, not that header.
      </div>
        </section>

        <hr className="memory-lab__zone-rule memory-lab__zone-rule--tabgap" aria-hidden />
      <h4 className="memory-lab__micro-zone">Results & retrieval debug</h4>
      {error ? (
        <div className="alert alert--error memory-lab__search-error" role="alert">
          <div>{error}</div>
          {errorRequestId ? <div className="alert__meta">Request ID: {errorRequestId}</div> : null}
          <div className="memory-lab__actions">
            <button type="button" className="ghost" onClick={() => void search(true)} disabled={loading}>
              Retry search
            </button>
          </div>
        </div>
      ) : null}
      {rows.length === 0 && !loading && showNoResultsHint && (
        <div className="card mt-sm" role="status">
          <p className="muted small">
            <strong>No results found.</strong>
          </p>
          <p className="muted small mt-sm">
            Make sure:
            <br />
            - End-user ID matches what your app uses
            <br />- Scope (if used) is correct
            <br />- Or try the Continuity demo from Home.
          </p>
        </div>
      )}
      {rows.length === 0 && !loading && !showNoResultsHint && !error && query.trim() === "" && (
        <div className="muted small">Enter a search query and click Search.</div>
      )}
      {rows.length > 0 ? (
        <section className="memory-lab__results mt-md panel--elevated" aria-label="Search results">
          <div className="memory-lab__results-head row-space">
            <div className="memory-lab__heading-cluster">
              <span className="memory-lab__section-title">Hits</span>
              <span className="api-endpoint-chip" translate="no">
                POST /v1/search
              </span>
            </div>
            {searchExplainEnabled && explainPayload != null && explainPayload.results.length > 0 ? (
              <button
                type="button"
                className="ghost ghost--xs"
                onClick={() => {
                  setLabTab("explain");
                  setExplainDrawerOpen(true);
                }}
              >
                Explain tab · trace
              </button>
            ) : null}
          </div>
          {lastSuccessfulSearchCurl ? (
            <details className="memory-lab__curl-details memory-lab__curl-for-results">
              <summary className="muted small">Equivalent curl · same request as the rows below</summary>
              <pre className="code-block memory-lab__curl-pre">{lastSuccessfulSearchCurl}</pre>
              <button
                type="button"
                className="ghost ghost--xs"
                onClick={() => void navigator.clipboard.writeText(lastSuccessfulSearchCurl)}
              >
                Copy curl
              </button>
            </details>
          ) : null}
          {searchResponseRequestId ? (
            <div className="memory-lab__curl-request-id muted small mt-sm" role="status">
              Response <code className="small">x-request-id</code> (last search):{" "}
              <code className="small">{searchResponseRequestId}</code>
            </div>
          ) : null}
          <ul className="memory-lab__result-list">
            {rows.map((r) => (
              <li key={r.key} className="memory-lab__result-card">
                <div className="memory-lab__result-card-head row-space">
                  <div className="memory-lab__result-meta-line">
                    <span className="memory-lab__score-pill" title="Relevance score from the API">
                      {r.score.toFixed(4)}
                    </span>
                    <code className="memory-lab__result-id" title={r.memoryId}>
                      {r.memoryId.slice(0, 16)}…
                    </code>
                    <span className="muted small">chunk {r.chunkIndex}</span>
                  </div>
                  <div className="memory-lab__result-card-actions">
                    <button
                      type="button"
                      className="ghost ghost--xs"
                      onClick={() => void navigator.clipboard.writeText(r.memoryId)}
                    >
                      Copy id
                    </button>
                    <button type="button" className="ghost ghost--xs" onClick={() => void openMemory(r.memoryId)}>
                      Open memory
                    </button>
                  </div>
                </div>
                <p className="memory-lab__result-snippet">
                  {r.text.length > 480 ? `${r.text.slice(0, 480)}…` : r.text}
                </p>
                {r.explain != null ? (
                  <details className="memory-lab__result-meta">
                    <summary className="muted small">Trace / explain metadata</summary>
                    <pre className="code-block memory-lab__explain-snippet">{formatExplainValue(r.explain)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          {total != null ? (
            <div className="muted small memory-lab__result-count">
              {rows.length} of {total} result{total !== 1 ? "s" : ""}.
            </div>
          ) : null}
          <div className="memory-lab__actions mt-sm">
            <button
              type="button"
              className="ghost"
              onClick={loadMore}
              disabled={loading || !hasMore || (total != null && rows.length >= total)}
            >
              {loading ? "Loading…" : !hasMore || (total != null && rows.length >= total) ? "No more results" : "Load more"}
            </button>
          </div>
        </section>
      ) : null}

        </div>

        <div
          role="tabpanel"
          id="memory-lab-panel-context"
          aria-labelledby="memory-lab-tab-context"
          hidden={labTab !== "context"}
          className="memory-lab__tab-panel"
        >
      <hr className="memory-lab__zone-rule memory-lab__zone-rule--tabgap" aria-hidden />
      <h4 className="memory-lab__micro-zone">Inputs · context request</h4>
      <div className="panel mt-md panel--nested">
        <div className="panel-head memory-lab__context-panel-head row-space">
          <span>Context</span>
          <span className="api-endpoint-chip" translate="no">
            POST /v1/context
          </span>
        </div>
        <div className="panel-body">
          <div className="muted small">
            Uses subject & scope from the header above. Paste the question or task string you send as <code>query</code>.
          </div>
          <label className="field">
            <span>Context query</span>
            <input
              value={contextQuery}
              onChange={(e) => setContextQuery(e.target.value)}
              placeholder='e.g. "What should we remember about this user preferences?"'
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runContextProbe();
                }
              }}
            />
          </label>
          <div className="row mt-sm">
            <button type="button" className="ghost" onClick={copyContextCurl}>
              {curlCopied === "context" ? "Copied" : "Copy as curl (context)"}
            </button>
            <button
              type="button"
              onClick={() => void runContextProbe()}
              disabled={contextProbeLoading}
              className={contextProbeLoading ? "btn-loading" : undefined}
              {...(contextProbeLoading ? { "aria-busy": true as const } : {})}
            >
              {contextProbeLoading ? (
                <>
                  <span className="btn-spinner" aria-hidden />
                  Running…
                </>
              ) : (
                "Run context"
              )}
            </button>
          </div>
          {contextProbeError ? (
            <div className="alert alert--error mt-sm" role="alert">
              <div>{contextProbeError}</div>
              {contextErrorRequestId ? (
                <div className="alert__meta">Request ID: {contextErrorRequestId}</div>
              ) : null}
              <div className="memory-lab__actions mt-sm">
                <button type="button" className="ghost ghost--xs" onClick={() => void runContextProbe()} disabled={contextProbeLoading}>
                  Retry context
                </button>
              </div>
            </div>
          ) : null}
          {lastSuccessfulContextCurl ? (
            <details className="memory-lab__curl-details mt-sm memory-lab__curl-for-context">
              <summary className="muted small">Equivalent curl (last successful context request)</summary>
              <pre className="code-block memory-lab__curl-pre">{lastSuccessfulContextCurl}</pre>
              <button
                type="button"
                className="ghost ghost--xs"
                onClick={() => void navigator.clipboard.writeText(lastSuccessfulContextCurl)}
              >
                Copy curl
              </button>
            </details>
          ) : null}
          {contextResponseRequestId ? (
            <div className="memory-lab__curl-request-id muted small mt-sm" role="status">
              Response <code className="small">x-request-id</code> (last context request):{" "}
              <code className="small">{contextResponseRequestId}</code>
            </div>
          ) : null}
          {contextOutputText !== null ? (
            <div className="memory-lab__context-output mt-md">
              <div className="memory-lab__context-output-head row-space">
                <span className="memory-lab__mini-title">Context output</span>
                <div className="memory-lab__toggle-group">
                  <button
                    type="button"
                    className={`ghost ghost--xs${!contextOutputRaw ? " memory-lab__toggle--active" : ""}`}
                    onClick={() => setContextOutputRaw(false)}
                  >
                    Formatted
                  </button>
                  <button
                    type="button"
                    className={`ghost ghost--xs${contextOutputRaw ? " memory-lab__toggle--active" : ""}`}
                    onClick={() => setContextOutputRaw(true)}
                  >
                    Raw
                  </button>
                </div>
              </div>
              <pre
                className={
                  contextOutputRaw ? "code-block memory-lab__context-pre" : "memory-lab__context-formatted"
                }
              >
                {(() => {
                  const t = contextOutputText;
                  const long = t.length > CONTEXT_PREVIEW_CHARS;
                  const body = contextOutputExpanded || !long ? t : `${t.slice(0, CONTEXT_PREVIEW_CHARS)}…`;
                  return body;
                })()}
              </pre>
              {contextOutputText.length > CONTEXT_PREVIEW_CHARS ? (
                <button
                  type="button"
                  className="ghost ghost--xs mt-sm"
                  onClick={() => setContextOutputExpanded((x) => !x)}
                >
                  {contextOutputExpanded ? "Show less" : "Show full output"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

        </div>

        <div
          role="tabpanel"
          id="memory-lab-panel-explain"
          aria-labelledby="memory-lab-tab-explain"
          hidden={labTab !== "explain"}
          className="memory-lab__tab-panel"
        >
          <hr className="memory-lab__zone-rule memory-lab__zone-rule--tabgap" aria-hidden />
          <h4 className="memory-lab__micro-zone">Retrieval explain</h4>
          {explainPayload != null && explainPayload.results.length > 0 ? (
            <>
              <ExplainStructuredView payload={explainPayload} />
              <div className="memory-lab__actions mt-md">
                <button type="button" className="ghost ghost--xs" onClick={() => setExplainDrawerOpen(true)}>
                  Open raw trace in drawer
                </button>
              </div>
            </>
          ) : !searchExplainEnabled ? (
            <div className="memory-lab__empty-panel card mt-sm" role="status">
              <p className="muted small">
                <strong>Explain is off.</strong>
              </p>
              <p className="muted small mt-sm">
                On the <strong>Search</strong> tab, enable <strong>Retrieval explain (debug)</strong>, then run a search to populate this tab.
              </p>
            </div>
          ) : (
            <div className="memory-lab__empty-panel card mt-sm" role="status">
              <p className="muted small">
                <strong>No explain payload yet.</strong>
              </p>
              <p className="muted small mt-sm">
                Run a search from the <strong>Search</strong> tab with explain enabled — traces appear here grouped by hit.
              </p>
            </div>
          )}
        </div>

        <div
          role="tabpanel"
          id="memory-lab-panel-advanced"
          aria-labelledby="memory-lab-tab-advanced"
          hidden={labTab !== "advanced"}
          className="memory-lab__tab-panel"
        >
          <hr className="memory-lab__zone-rule memory-lab__zone-rule--tabgap" aria-hidden />
          <h4 className="memory-lab__micro-zone">Power tools</h4>
          <p className="muted small">
            Evaluations, replay, and feedback — collapsed by default. Uses the same APIs as production.
          </p>
          <div className="memory-lab__advanced-actions mb-md">
            <button type="button" className="ghost ghost--xs" onClick={loadHistory} disabled={historyLoading}>
              {historyLoading ? "Loading history…" : "Load history"}
            </button>
          </div>

          <details className="memory-lab__adv-details panel mt-md panel--nested">
            <summary className="memory-lab__adv-summary">Evaluation sets & runs</summary>
            <div className="panel-body">
          <div className="row">
            <input
              value={newEvalSetName}
              onChange={(e) => setNewEvalSetName(e.target.value)}
              placeholder="New eval set name"
            />
            <button onClick={createEvalSet} disabled={evalLoading || !newEvalSetName.trim()}>
              {evalLoading ? "Saving…" : "Create set"}
            </button>
            <button className="ghost" onClick={loadEvalSets} disabled={evalLoading}>
              Refresh sets
            </button>
          </div>
          {evalError ? (
            <div className="alert alert--error mt-sm" role="alert">
              {evalError}
            </div>
          ) : null}
          <ul className="list">
            {evalSets.map((s) => (
              <li key={s.id} className="card">
                <div className="row-space">
                  <div>
                    <strong>{s.name}</strong>
                    <div className="muted small">{new Date(s.created_at).toLocaleString()}</div>
                  </div>
                  <div className="row">
                    <button
                      className={selectedEvalSetId === s.id ? "" : "ghost"}
                      onClick={() => {
                        setSelectedEvalSetId(s.id);
                        setEvalRunResult(null);
                      }}
                    >
                      {selectedEvalSetId === s.id ? "Selected" : "Use"}
                    </button>
                    <button className="ghost" onClick={() => deleteEvalSet(s.id)} disabled={evalLoading}>
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {selectedEvalSetId && (
            <>
              <div className="row mt-sm">
                <input
                  value={newEvalQuery}
                  onChange={(e) => setNewEvalQuery(e.target.value)}
                  placeholder="Eval query"
                />
                <input
                  value={newEvalExpectedIds}
                  onChange={(e) => setNewEvalExpectedIds(e.target.value)}
                  placeholder="Expected memory IDs (comma-separated UUIDs)"
                />
                <button onClick={createEvalItem} disabled={evalItemsLoading || !newEvalQuery.trim()}>
                  {evalItemsLoading ? "Saving…" : "Add item"}
                </button>
              </div>
              {expectedIdsValidationError ? (
                <div className="alert alert--warning mt-sm" role="alert">
                  {expectedIdsValidationError}
                </div>
              ) : null}
              <div className="row mt-sm">
                <button onClick={runEvalSet} disabled={evalRunLoading || evalItems.length === 0}>
                  {evalRunLoading ? "Running…" : "Run eval set"}
                </button>
              </div>
              {evalItemsLoading && <div className="muted small">Loading eval items…</div>}
              <ul className="list">
                {pagedEvalItems.map((item) => (
                  <li key={item.id} className="card">
                    <div className="row-space">
                      <div>
                        <strong>{item.query}</strong>
                        <div className="muted small">
                          Expected IDs: {item.expected_memory_ids?.length ?? 0}
                        </div>
                      </div>
                      <button className="ghost" onClick={() => deleteEvalItem(item.id)} disabled={evalItemsLoading}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {evalItems.length > 0 && (
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() => setEvalItemsPage((p) => Math.max(1, p - 1))}
                    disabled={evalItemsPage <= 1}
                  >
                    Prev
                  </button>
                  <span className="muted small">Page {evalItemsPage} / {evalItemsTotalPages}</span>
                  <button
                    className="ghost"
                    onClick={() => setEvalItemsPage((p) => Math.min(evalItemsTotalPages, p + 1))}
                    disabled={evalItemsPage >= evalItemsTotalPages}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}

          {evalRunResult && (
            <div className="card mt-sm">
              <strong>Eval run result</strong>
              <div className="muted small">
                Items: {evalRunResult.item_count} · Avg Precision@k: {evalRunResult.avg_precision_at_k.toFixed(3)} · Avg Recall: {evalRunResult.avg_recall.toFixed(3)}
              </div>
              <div className="row mt-sm">
                <button className="ghost" onClick={exportEvalRunJson}>Export JSON</button>
              </div>
              <ul className="list">
                {evalRunResult.items.slice(0, 10).map((item) => (
                  <li key={item.eval_item_id} className="card">
                    <div className="row-space">
                      <span>{item.query}</span>
                      <span className="muted small">
                        P@k {item.precision_at_k.toFixed(3)} · R {item.recall.toFixed(3)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
            </div>
          </details>

          <details className="memory-lab__adv-details panel mt-md panel--nested">
            <summary className="memory-lab__adv-summary">Retrieval history & replay</summary>
            <div className="panel-body">
              {historyError ? (
                <div className="alert alert--error mt-sm" role="alert">
                  {historyError}
                </div>
              ) : null}
              {historyRows.length === 0 && !historyLoading && (
                <div className="muted small">
                  No saved history yet. Enable “Save to history” before searching, then click Load history.
                </div>
              )}
              <ul className="list">
                {historyRows.map((h) => (
                  <li key={h.id} className="card">
                    <div className="row-space">
                      <div>
                        <strong>{h.query || "(empty query)"}</strong>
                        <div className="muted small">{new Date(h.created_at).toLocaleString()}</div>
                      </div>
                      <button type="button" className="ghost" onClick={() => replayQuery(h.id)} disabled={replayLoadingId === h.id}>
                        {replayLoadingId === h.id ? "Replaying…" : "Replay"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {replayError ? (
                <div className="alert alert--error mt-sm" role="alert">
                  {replayError}
                </div>
              ) : null}
              {replayResult && (
                <div className="card">
                  <strong>Replay diff</strong>
                  <div className="muted small">Query ID: <code>{replayResult.query_id}</code></div>
                  <div className="muted small">
                    Previous results: {replayResult.previous?.results?.length ?? 0} · Current results: {replayResult.current?.results?.length ?? 0}
                  </div>
                  <div className="mt-sm">
                    <div className="muted small">
                      Added chunks: {replayAdded.length} · Removed chunks: {replayRemoved.length} · Unchanged: {replayUnchanged.length}
                    </div>
                    {replayAdded.length > 0 && (
                      <div className="muted small">
                        Added: {replayAdded.slice(0, 5).map((id) => id.slice(0, 8)).join(", ")}{replayAdded.length > 5 ? "…" : ""}
                      </div>
                    )}
                    {replayRemoved.length > 0 && (
                      <div className="muted small">
                        Removed: {replayRemoved.slice(0, 5).map((id) => id.slice(0, 8)).join(", ")}{replayRemoved.length > 5 ? "…" : ""}
                      </div>
                    )}
                    <div className="muted small mt-sm">
                      Submit chunk feedback from the <strong>Context feedback</strong> section — use{" "}
                      <button type="button" className="ghost ghost--xs" onClick={() => setFeedbackTraceId(replayResult.query_id)}>
                        Prefill trace ID from this replay
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </details>

          <details className="memory-lab__adv-details panel mt-md panel--nested">
            <summary className="memory-lab__adv-summary">Context feedback</summary>
            <div className="panel-body">
              <p className="muted small">
                POST <code className="small">/v1/context/feedback</code> — attach which chunks were useful for a retrieval trace.
              </p>
              <div className="row mt-sm">
                <input
                  value={feedbackTraceId}
                  onChange={(e) => setFeedbackTraceId(e.target.value)}
                  placeholder="Trace ID (required)"
                />
                {replayResult?.query_id ? (
                  <button type="button" className="ghost" onClick={() => setFeedbackTraceId(replayResult.query_id)}>
                    Use last replay ID
                  </button>
                ) : null}
              </div>
              <div className="row mt-sm">
                <input
                  value={feedbackUsedIds}
                  onChange={(e) => setFeedbackUsedIds(e.target.value)}
                  placeholder="Used chunk IDs (comma-separated)"
                />
                <input
                  value={feedbackUnusedIds}
                  onChange={(e) => setFeedbackUnusedIds(e.target.value)}
                  placeholder="Unused chunk IDs (comma-separated)"
                />
                <button type="button" onClick={() => void submitContextFeedback()} disabled={feedbackBusy}>
                  {feedbackBusy ? "Submitting…" : "Submit feedback"}
                </button>
              </div>
              {feedbackMessage ? <div className="muted small mt-sm" role="status">{feedbackMessage}</div> : null}
            </div>
          </details>

        </div>

      </div>

      {selected && (
        <div className="modal" onClick={() => setSelected(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Memory {selected.id}</h3>
            <div className="muted small">Created {new Date(selected.created_at).toLocaleString()}</div>
            {(selected.memory_type != null && selected.memory_type !== "") && (
              <div className="muted small">Type: <span className="badge">{selected.memory_type}</span></div>
            )}
            {(selected.source_memory_id != null && selected.source_memory_id !== "") && (
              <div className="muted small">Source memory: <code>{selected.source_memory_id}</code></div>
            )}
            <pre className="code-block">{selected.text}</pre>
            <div className="muted small">Metadata: {JSON.stringify(selected.metadata)}</div>
            <button className="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      <ConsoleDocsDrawer open={explainDrawerOpen} onClose={() => setExplainDrawerOpen(false)} title="Why these results?">
        <div className="docs-drawer-prose muted small memory-lab__explain-drawer">
          <p>
            Retrieval traces from <code className="small">explain: true</code> on <strong>POST /v1/search</strong>. Each row mirrors a hit;
            empty <code className="small">explain</code> means the API did not attach trace data for that chunk.
          </p>
          <pre className="code-block mt-sm memory-lab__explain-drawer-pre">
            {explainPayload ? summarizeExplainPayload(explainPayload) : ""}
          </pre>
        </div>
      </ConsoleDocsDrawer>

      <ConsoleDocsDrawer open={docsOpen} onClose={() => setDocsOpen(false)} title="Memory Lab & API">
        <div className="docs-drawer-prose muted small">
          <p>These controls call the same REST routes as your live integration. Copy/paste helpers use the same JSON bodies.</p>
          <ul className="docs-drawer-list">
            <li>
              <strong>Tabs</strong> — <strong>Search</strong> (hits, curl, request id), <strong>Context</strong> (formatted / raw preview),{" "}
              <strong>Explain</strong> (structured traces when <code>explain</code> is on), <strong>Advanced</strong> (evals, history / replay, feedback).
            </li>
            <li>
              <strong>POST /v1/search</strong> — semantic retrieval. Body includes <code>user_id</code>, <code>query</code>, pagination, optional{" "}
              <code>namespace</code>, filters, and <code>explain</code> when enabled.
            </li>
            <li>
              <strong>POST /v1/context</strong> — returns <code>context_text</code> for a prompt; uses <code>user_id</code>, <code>query</code>, optional{" "}
              <code>namespace</code>.
            </li>
            <li>
              <strong>Authentication</strong> — browser calls use your dashboard session (cookies; CSRF on writes). Curl examples use{" "}
              <code>YOUR_API_KEY</code> so you can replay the same JSON server-side. Success responses expose <code>x-request-id</code> when the Worker sends it (shown under each curl block here).
            </li>
          </ul>
          <p className="docs-drawer-links">
            <a href={DOCS_QUICKSTART} target="_blank" rel="noopener noreferrer">
              Quickstart
            </a>
            {" · "}
            <a href={DOCS_BASE} target="_blank" rel="noopener noreferrer">
              Documentation
            </a>
          </p>
        </div>
      </ConsoleDocsDrawer>
    </Panel>
  );
}