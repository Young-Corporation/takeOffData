// ExportPanel.jsx — Triggers YOLO dataset export and provides download link

import { useState } from "react";
import { exportYolo, exportAll } from "../lib/labelApi";

// Admin "Download All Sessions" UI is shown only when ?admin=1 is in the URL.
// Workers don't see it; the link is bookmarked by the developer.
function isAdminMode() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("admin") === "1";
}

// Fingerprint of dataset state — changes whenever something that affects the
// export changes (mark renamed/reshaped/added/removed, or count changed).
// Used to flag a downloaded zip as stale so users don't re-download an old
// export after editing a mark's shape.
function datasetFingerprint(marks, counts) {
  const m = (marks ?? [])
    .map((x) => `${x.id}:${x.shape}:${x.name}`)
    .sort()
    .join("|");
  const c = (counts ?? [])
    .map((x) => `${x.mark_id}:${x.count}`)
    .sort()
    .join("|");
  return `${m}::${c}`;
}

export default function ExportPanel({ sessionId, marks = [], counts = [], onRefresh }) {
  const [state,        setState]        = useState("idle"); // idle|loading|done|error
  const [downloadUrl,  setDownloadUrl]  = useState(null);
  const [error,        setError]        = useState(null);
  const [exportedFp,   setExportedFp]   = useState(null);
  const [refreshing,   setRefreshing]   = useState(false);

  // Admin aggregate export state — separate from per-session export.
  const adminMode = isAdminMode();
  const [aggState,    setAggState]    = useState("idle"); // idle|loading|done|error
  const [aggUrl,      setAggUrl]      = useState(null);
  const [aggStats,    setAggStats]    = useState(null);
  const [aggError,    setAggError]    = useState(null);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  };

  const handleExportAll = async () => {
    setAggState("loading"); setAggError(null);
    try {
      const { download_url, ...stats } = await exportAll();
      setAggUrl(download_url);
      setAggStats(stats);
      setAggState("done");
    } catch (e) {
      setAggError(e.message); setAggState("error");
    }
  };

  const totalAnnotations = counts.reduce((sum, c) => sum + c.count, 0);
  const currentFp        = datasetFingerprint(marks, counts);
  const isStale          = state === "done" && exportedFp !== null && exportedFp !== currentFp;

  // Collapse counts by shape for the preview summary
  const byShape = {};
  for (const c of counts) {
    byShape[c.shape] = (byShape[c.shape] ?? 0) + c.count;
  }

  const handleExport = async () => {
    setState("loading");
    setError(null);
    try {
      const { download_url } = await exportYolo(sessionId);
      setDownloadUrl(download_url);
      setExportedFp(currentFp);
      setState("done");
    } catch (e) {
      setError(e.message);
      setState("error");
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.headerRow}>
        <span style={styles.header}>YOLO Export</span>
        <button
          style={{ ...styles.refreshBtn, opacity: refreshing ? 0.5 : 1 }}
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh marks and counts from server"
        >
          {refreshing ? "↻ …" : "↻ Refresh"}
        </button>
      </div>

      {/* Summary */}
      <div style={styles.summary}>
        <div style={styles.totalRow}>
          <span style={styles.totalLabel}>Total annotations</span>
          <span style={styles.totalCount}>{totalAnnotations}</span>
        </div>
        {Object.entries(byShape).map(([shape, count]) => (
          <div key={shape} style={styles.shapeRow}>
            <span style={styles.shapeName}>{shape}</span>
            <span style={styles.shapeCount}>{count}</span>
          </div>
        ))}
        {counts.length > 0 && (
          <div style={styles.classNote}>
            {Object.keys(byShape).length} YOLO class{Object.keys(byShape).length !== 1 ? "es" : ""}
          </div>
        )}
      </div>

      {/* Action */}
      {state === "idle" && (
        <button
          style={{ ...styles.btn, opacity: totalAnnotations === 0 ? 0.4 : 1 }}
          onClick={handleExport}
          disabled={totalAnnotations === 0}
        >
          Export Dataset
        </button>
      )}

      {state === "loading" && (
        <div style={styles.status}>Building zip…</div>
      )}

      {state === "done" && (
        <div style={styles.downloadGroup}>
          {isStale ? (
            <div style={styles.staleMsg}>
              ⚠ Data changed since this export — re-export for the latest.
            </div>
          ) : (
            <div style={styles.successMsg}>✓ Export ready</div>
          )}
          <a
            href={downloadUrl}
            download
            style={{ ...styles.downloadBtn, opacity: isStale ? 0.55 : 1 }}
          >
            Download .zip{isStale ? " (stale)" : ""}
          </a>
          <button
            style={isStale ? styles.btn : styles.resetBtn}
            onClick={isStale ? handleExport : () => setState("idle")}
          >
            {isStale ? "Re-export" : "Export Again"}
          </button>
        </div>
      )}

      {state === "error" && (
        <div>
          <div style={styles.errorMsg}>{error}</div>
          <button style={styles.resetBtn} onClick={() => setState("idle")}>
            Retry
          </button>
        </div>
      )}

      <div style={styles.hint}>
        Images + labels + classes.txt + notes.json (Label Studio YOLO format).
        Shape = YOLO class (marks with same shape are merged).
      </div>

      {adminMode && (
        <div style={styles.adminBlock}>
          <div style={styles.adminHeader}>ADMIN · ALL SESSIONS</div>
          <div style={styles.adminHint}>
            Aggregates every session marked <b>Done</b> into one zip with
            unified class IDs. Rebuilt fresh on each click.
          </div>
          {aggState === "idle" && (
            <button style={styles.adminBtn} onClick={handleExportAll}>
              Download All Done Sessions
            </button>
          )}
          {aggState === "loading" && (
            <div style={styles.status}>Building aggregate zip…</div>
          )}
          {aggState === "done" && (
            <div style={styles.downloadGroup}>
              <div style={styles.successMsg}>
                ✓ {aggStats?.sessions ?? "?"} sessions · {aggStats?.pages ?? "?"} pages · {aggStats?.annotations ?? "?"} labels · {aggStats?.classes ?? "?"} classes
              </div>
              <a href={aggUrl} download style={styles.downloadBtn}>
                Download aggregate.zip
              </a>
              <button style={styles.resetBtn} onClick={handleExportAll}>
                Rebuild & download
              </button>
            </div>
          )}
          {aggState === "error" && (
            <div>
              <div style={styles.errorMsg}>{aggError}</div>
              <button style={styles.resetBtn} onClick={() => setAggState("idle")}>Retry</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  panel: {
    background: "#1a1a2e",
    borderTop: "1px solid #2a2a4a",
    padding: "14px 14px 16px",
    fontFamily: "system-ui, sans-serif",
    color: "#ccc",
    fontSize: 13,
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  header: {
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: 11,
    color: "#555",
  },
  refreshBtn: {
    background: "none",
    border: "1px solid #2a2a4a",
    borderRadius: 3,
    color: "#888",
    cursor: "pointer",
    fontSize: 10,
    padding: "2px 6px",
    fontFamily: "inherit",
  },
  summary: {
    marginBottom: 12,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    fontWeight: 600,
    color: "#e8e8e8",
    paddingBottom: 6,
    borderBottom: "1px solid #2a2a4a",
    marginBottom: 4,
  },
  totalLabel: { color: "#aaa" },
  totalCount: { color: "#fff", fontWeight: 700 },
  shapeRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
    color: "#888",
    textTransform: "capitalize",
  },
  shapeName: {},
  shapeCount: { color: "#aaa" },
  classNote: {
    fontSize: 11,
    color: "#444",
    marginTop: 4,
  },
  btn: {
    width: "100%",
    background: "#3b82f6",
    border: "none",
    borderRadius: 4,
    color: "#fff",
    fontWeight: 600,
    padding: "8px 0",
    cursor: "pointer",
    fontSize: 13,
    marginBottom: 8,
  },
  status: {
    textAlign: "center",
    color: "#888",
    fontSize: 12,
    padding: "6px 0",
  },
  downloadGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  successMsg: {
    color: "#4ade80",
    fontSize: 12,
    fontWeight: 600,
  },
  staleMsg: {
    color: "#fbbf24",
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.4,
  },
  downloadBtn: {
    display: "block",
    background: "#22c55e",
    borderRadius: 4,
    color: "#fff",
    fontWeight: 600,
    padding: "7px 0",
    textAlign: "center",
    textDecoration: "none",
    fontSize: 13,
  },
  resetBtn: {
    background: "none",
    border: "1px solid #333",
    borderRadius: 4,
    color: "#888",
    cursor: "pointer",
    padding: "5px 0",
    fontSize: 12,
    width: "100%",
  },
  errorMsg: {
    color: "#f87171",
    fontSize: 12,
    marginBottom: 6,
  },
  hint: {
    marginTop: 10,
    fontSize: 11,
    color: "#3a3a5a",
    lineHeight: 1.5,
  },
  adminBlock: {
    marginTop: 16,
    paddingTop: 12,
    borderTop: "1px solid #2a2a4a",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  adminHeader: {
    fontSize: 10,
    fontWeight: 700,
    color: "#a78bfa",
    letterSpacing: "0.08em",
  },
  adminHint: {
    fontSize: 11,
    color: "#666",
    lineHeight: 1.4,
  },
  adminBtn: {
    background: "#7c3aed",
    border: "none",
    borderRadius: 4,
    color: "#fff",
    fontWeight: 600,
    padding: "7px 0",
    cursor: "pointer",
    fontSize: 12,
    width: "100%",
  },
};
