// AdminApp.jsx — Read-only admin dashboard.
//
// Shown when the URL has ?admin=1. Lists every project and its uploaded PDFs
// with their done status. The admin can:
//   • Download a per-session zip (any session, even not-done — useful for QA)
//   • Download an aggregate zip of every "Done" session (the training set)
//
// No labeling UI here on purpose — workers do the labeling, the admin pulls.

import { useState, useEffect } from "react";
import {
  listProjects,
  listSessions,
  exportYolo,
  exportAll,
} from "../lib/labelApi";

export default function AdminApp() {
  const [projects,            setProjects]            = useState([]);
  const [sessionsByProject,   setSessionsByProject]   = useState({});
  const [loading,             setLoading]             = useState(true);
  const [refreshTick,         setRefreshTick]         = useState(0);
  const [busySession,         setBusySession]         = useState(null);

  // Aggregate export state
  const [aggState, setAggState] = useState("idle"); // idle|loading|done|error
  const [aggUrl,   setAggUrl]   = useState(null);
  const [aggStats, setAggStats] = useState(null);
  const [aggError, setAggError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const projs = await listProjects();
        const sessionsArrays = await Promise.all(
          projs.map((p) => listSessions(p.id).catch(() => []))
        );
        if (cancelled) return;
        const byProject = {};
        projs.forEach((p, i) => { byProject[p.id] = sessionsArrays[i]; });
        setProjects(projs);
        setSessionsByProject(byProject);
      } catch (e) {
        console.error("admin load failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshTick]);

  const totalSessions = Object.values(sessionsByProject).reduce(
    (n, arr) => n + arr.length, 0
  );
  const doneSessions = Object.values(sessionsByProject).reduce(
    (n, arr) => n + arr.filter((s) => s.done).length, 0
  );

  const downloadSession = async (sessionId) => {
    setBusySession(sessionId);
    try {
      const { download_url } = await exportYolo(sessionId);
      const a = Object.assign(document.createElement("a"), { href: download_url, download: "export.zip" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(download_url), 60_000);
    } catch (e) {
      alert("Download failed: " + e.message);
    } finally {
      setBusySession(null);
    }
  };

  const buildAggregate = async () => {
    setAggState("loading"); setAggError(null);
    try {
      const { download_url, ...stats } = await exportAll();
      setAggUrl(download_url);
      setAggStats(stats);
      setAggState("done");
    } catch (e) {
      setAggError(e.message);
      setAggState("error");
    }
  };

  return (
    <div style={s.root}>
      <div style={s.topBar}>
        <span style={s.brand}>TakeOff Label · Admin</span>
        <span style={s.summary}>
          {totalSessions} {totalSessions === 1 ? "session" : "sessions"} · {doneSessions} done
        </span>
        <button style={s.refreshBtn} onClick={() => setRefreshTick((n) => n + 1)}>
          ↻ Refresh
        </button>
      </div>

      <div style={s.content}>
        {/* Aggregate export block — pinned at top of content */}
        <div style={s.aggCard}>
          <div style={s.aggTitle}>Training dataset (aggregate)</div>
          <div style={s.aggSub}>
            One zip with every <b>Done</b> session merged. Class IDs are unified
            across sessions; rebuilt fresh on every click.
          </div>

          {aggState === "idle" && (
            <button
              style={{ ...s.aggBtn, opacity: doneSessions === 0 ? 0.4 : 1 }}
              onClick={buildAggregate}
              disabled={doneSessions === 0}
              title={doneSessions === 0
                ? "No sessions are marked Done yet"
                : "Build and download the aggregate zip"}
            >
              Download all done sessions ({doneSessions})
            </button>
          )}
          {aggState === "loading" && (
            <div style={s.aggStatus}>Building aggregate zip…</div>
          )}
          {aggState === "done" && (
            <div style={s.aggDoneRow}>
              <span style={s.aggSuccess}>
                ✓ {aggStats?.sessions ?? "?"} sessions · {aggStats?.pages ?? "?"} pages · {aggStats?.annotations ?? "?"} labels · {aggStats?.classes ?? "?"} classes
              </span>
              <a href={aggUrl} download style={s.dlBtn}>Download .zip</a>
              <button style={s.aggSecondaryBtn} onClick={buildAggregate}>
                Rebuild
              </button>
              <button style={s.linkBtn} onClick={() => setAggState("idle")}>dismiss</button>
            </div>
          )}
          {aggState === "error" && (
            <div>
              <div style={s.errorMsg}>{aggError}</div>
              <button style={s.aggSecondaryBtn} onClick={() => setAggState("idle")}>Retry</button>
            </div>
          )}
        </div>

        {/* Project list */}
        {loading && <div style={s.loading}>Loading…</div>}
        {!loading && projects.length === 0 && (
          <div style={s.empty}>No projects yet</div>
        )}
        {!loading && projects.map((p) => {
          const sessions = sessionsByProject[p.id] ?? [];
          const proj_done = sessions.filter((x) => x.done).length;
          return (
            <div key={p.id} style={s.projCard}>
              <div style={s.projHeader}>
                <span style={s.projName}>{p.name}</span>
                <span style={s.projMeta}>
                  {sessions.length} sessions · {proj_done} done
                </span>
              </div>
              {sessions.length === 0 ? (
                <div style={s.empty}>No sessions in this project</div>
              ) : (
                <div style={s.sessList}>
                  {sessions.map((sess) => (
                    <div key={sess.id} style={s.sessRow}>
                      <div style={s.sessLeft}>
                        <span style={s.sessName}>{sess.filename}</span>
                        <span style={s.sessMeta}>{sess.page_count} pages</span>
                      </div>
                      {sess.done
                        ? <span style={s.badgeDone}>DONE</span>
                        : <span style={s.badgePending}>in progress</span>}
                      <button
                        style={{ ...s.sessDl, opacity: busySession === sess.id ? 0.5 : 1 }}
                        onClick={() => downloadSession(sess.id)}
                        disabled={busySession === sess.id}
                        title="Download this session as a YOLO zip"
                      >
                        {busySession === sess.id ? "…" : "Download"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  root: {
    display: "flex", flexDirection: "column", height: "100vh",
    background: "#0d0d1a", color: "#ccc",
    fontFamily: "system-ui, sans-serif",
  },
  topBar: {
    display: "flex", alignItems: "center", gap: 14,
    padding: "10px 18px",
    background: "#12122a", borderBottom: "1px solid #2a2a4a",
    flexShrink: 0,
  },
  brand:    { fontWeight: 700, fontSize: 14, color: "#fff" },
  summary:  { fontSize: 12, color: "#777", marginLeft: 4 },
  refreshBtn: {
    marginLeft: "auto",
    background: "none", border: "1px solid #333", borderRadius: 3,
    color: "#888", cursor: "pointer", padding: "4px 12px", fontSize: 12,
  },
  content: {
    flex: 1, overflow: "auto",
    display: "flex", flexDirection: "column", gap: 14,
    padding: "18px 22px",
    maxWidth: 1100, width: "100%", boxSizing: "border-box",
    margin: "0 auto",
  },

  aggCard: {
    background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 8,
    padding: "14px 18px",
    display: "flex", flexDirection: "column", gap: 8,
  },
  aggTitle:    { fontWeight: 700, color: "#fff", fontSize: 13 },
  aggSub:      { fontSize: 12, color: "#777", lineHeight: 1.4 },
  aggBtn: {
    alignSelf: "flex-start",
    background: "#7c3aed", border: "none", borderRadius: 4,
    color: "#fff", fontWeight: 600, padding: "8px 16px",
    cursor: "pointer", fontSize: 13,
  },
  aggSecondaryBtn: {
    background: "none", border: "1px solid #333", borderRadius: 4,
    color: "#aaa", cursor: "pointer", padding: "4px 12px", fontSize: 12,
  },
  aggStatus:   { color: "#888", fontSize: 12, padding: "6px 0" },
  aggSuccess:  { color: "#4ade80", fontSize: 12, fontWeight: 600 },
  aggDoneRow:  { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  dlBtn: {
    background: "#22c55e", borderRadius: 4, color: "#fff",
    fontWeight: 600, padding: "6px 14px", textDecoration: "none",
    fontSize: 12,
  },
  linkBtn: {
    background: "none", border: "none", color: "#666",
    cursor: "pointer", fontSize: 11, textDecoration: "underline",
  },
  errorMsg: { color: "#f87171", fontSize: 12, marginBottom: 6 },

  loading: { color: "#666", fontSize: 13, padding: "8px 0" },
  empty:   { color: "#444", fontSize: 12, padding: "8px 0" },

  projCard: {
    background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 8,
    padding: "14px 18px",
    display: "flex", flexDirection: "column", gap: 10,
  },
  projHeader: {
    display: "flex", alignItems: "baseline", justifyContent: "space-between",
    gap: 8, paddingBottom: 6, borderBottom: "1px solid #22223a",
  },
  projName: { fontWeight: 700, color: "#fff", fontSize: 14 },
  projMeta: { fontSize: 11, color: "#666" },

  sessList: {
    display: "flex", flexDirection: "column", gap: 4,
  },
  sessRow: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 10px",
    background: "#111122", border: "1px solid #1e1e3a", borderRadius: 4,
  },
  sessLeft: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  sessName: { color: "#e8e8e8", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  sessMeta: { color: "#555", fontSize: 11 },

  badgeDone: {
    background: "#22c55e", color: "#fff", fontSize: 10, fontWeight: 700,
    padding: "2px 8px", borderRadius: 10, letterSpacing: "0.04em",
  },
  badgePending: {
    background: "transparent", color: "#666", fontSize: 11,
    border: "1px solid #2a2a4a",
    padding: "2px 8px", borderRadius: 10,
  },
  sessDl: {
    background: "#3b82f6", border: "none", borderRadius: 4,
    color: "#fff", fontWeight: 600, padding: "6px 14px",
    cursor: "pointer", fontSize: 12,
  },
};
