// LabelApp.jsx — Worker view: Projects → Sessions → Labeling flow.
// The admin dashboard lives in AdminApp.jsx and is selected by App.jsx based
// on the ?admin=1 URL flag, so no admin/export UI exists in this file.

import { useState, useEffect, useCallback, useRef } from "react";
import MarkManager  from "./MarkManager";
import LabelMode    from "./LabelMode";
import PresenceBar  from "./PresenceBar";
import { useCollabWS } from "../lib/useCollabWS";
import {
  createProject, listProjects, deleteProject,
  createSession, listSessions, updateSession,
  getPageSvgUrl, renderPage,
  listMarks,
  listAnnotations, createAnnotation, deleteAnnotation,
  getCounts,
  listPageExclusions,   createPageExclusion,   deletePageExclusion,
  listRegionExclusions, createRegionExclusion, deleteRegionExclusion,
} from "../lib/labelApi";

const SVG_RENDER_SCALE = 4; // roughly matches the prior 300-DPI canvas overlay
const SVG_PAGE_CACHE_LIMIT = 16;
const svgPageCache = new Map();
const svgPageRequests = new Map();

function rememberSvgPage(src, page) {
  if (svgPageCache.has(src)) svgPageCache.delete(src);
  svgPageCache.set(src, page);
  while (svgPageCache.size > SVG_PAGE_CACHE_LIMIT) {
    svgPageCache.delete(svgPageCache.keys().next().value);
  }
}

function parseSvgPage(text) {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const svgEl = parsed.documentElement;
  let vw = 0, vh = 0;
  const vb = svgEl.getAttribute("viewBox");
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4) { vw = parts[2]; vh = parts[3]; }
  }
  if (!vw || !vh) {
    vw = parseFloat(svgEl.getAttribute("width"))  || 612;
    vh = parseFloat(svgEl.getAttribute("height")) || 792;
  }
  const w = Math.round(vw * SVG_RENDER_SCALE);
  const h = Math.round(vh * SVG_RENDER_SCALE);
  svgEl.setAttribute("width",  String(w));
  svgEl.setAttribute("height", String(h));
  svgEl.style.backgroundColor = "#fff";
  return { html: new XMLSerializer().serializeToString(svgEl), w, h };
}

async function loadSvgPage(src) {
  const cached = svgPageCache.get(src);
  if (cached) return cached;
  if (!svgPageRequests.has(src)) {
    let request;
    if (src.startsWith("idb://")) {
      const rest      = src.slice(6);
      const sep       = rest.indexOf("/");
      const sessionId = rest.slice(0, sep);
      const pageNum   = parseInt(rest.slice(sep + 1), 10);
      request = renderPage(sessionId, pageNum)
        .then((page) => { rememberSvgPage(src, page); svgPageRequests.delete(src); return page; })
        .catch((e)   => { svgPageRequests.delete(src); throw e; });
    } else {
      request = fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`SVG ${r.status}`);
          return r.text();
        })
        .then(parseSvgPage)
        .then((page) => {
          rememberSvgPage(src, page);
          return page;
        })
        .finally(() => svgPageRequests.delete(src));
    }
    svgPageRequests.set(src, request);
  }
  return svgPageRequests.get(src);
}

export default function LabelApp() {
  const [view,        setView]        = useState("projects"); // projects | sessions | label
  const [projects,    setProjects]    = useState([]);
  const [project,     setProject]     = useState(null);
  const [sessions,    setSessions]    = useState([]);
  const [session,     setSession]     = useState(null);
  const [marks,       setMarks]       = useState([]);
  const [annotations, setAnnotations] = useState([]);
  const [counts,      setCounts]      = useState([]);
  const [activeMark,  setActiveMark]  = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [users,       setUsers]       = useState([]);
  // Exclusions: workers can flag instructions / legend regions and whole pages
  // to skip at YOLO export. Annotations on those pages/regions stay in the DB.
  const [pageExclusions,   setPageExclusions]   = useState([]); // [{id,page_number,...}]
  const [regionExclusions, setRegionExclusions] = useState([]); // session-wide list
  const [excludeMode,      setExcludeMode]      = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [uploading,   setUploading]   = useState(false);
  const [user,        setUser]        = useState(
    () => localStorage.getItem("takeoff_label_user") || ""
  );
  const [userPrompt, setUserPrompt] = useState(
    !localStorage.getItem("takeoff_label_user")
  );

  const fileInputRef = useRef(null);

  // ── Load projects on boot ──────────────────────────────────────────────────
  useEffect(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []);

  // ── Load sessions when project selected ───────────────────────────────────
  useEffect(() => {
    if (!project) return;
    listSessions(project.id).then(setSessions).catch(console.error);
  }, [project?.id]);

  // ── Load marks + counts when session opens ─────────────────────────────────
  useEffect(() => {
    if (!session) return;
    listMarks(session.id).then(setMarks).catch(console.error);
    listPageExclusions(session.id).then(setPageExclusions).catch(console.error);
    listRegionExclusions(session.id).then(setRegionExclusions).catch(console.error);
    refreshCounts();
    setCurrentPage(1);
    setExcludeMode(false);
  }, [session?.id]);

  // ── Load annotations on page change ───────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    setAnnotations([]);
    listAnnotations(session.id, currentPage).then(setAnnotations).catch(console.error);
  }, [session?.id, currentPage]);

  // Keep the current and nearby SVG pages warm in browser memory. The backend
  // also caches rendered SVGs, but this removes another network/parse roundtrip.
  useEffect(() => {
    if (!session) return;
    const pages = [currentPage, currentPage + 1, currentPage - 1, currentPage + 2]
      .filter((page) => page >= 1 && page <= session.page_count);
    pages.forEach((page) => {
      loadSvgPage(getPageSvgUrl(session.id, page)).catch(console.error);
    });
  }, [session?.id, session?.page_count, currentPage]);

  const refreshCounts = useCallback(() => {
    if (!session) return;
    getCounts(session.id).then(setCounts).catch(console.error);
  }, [session?.id]);

  // ── WebSocket collab ───────────────────────────────────────────────────────
  // Backend broadcasts create events to all clients including the originator,
  // so we must dedupe by id — otherwise the originator's optimistic add plus
  // the broadcast both append and the row appears twice.
  useCollabWS(session?.id, user, {
    onAnnotationCreated: (ann) => {
      if (ann.page_number === currentPage)
        setAnnotations((prev) => prev.some((a) => a.id === ann.id) ? prev : [...prev, ann]);
      refreshCounts();
    },
    onAnnotationDeleted: ({ id }) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      refreshCounts();
    },
    onMarkCreated:   (mark) =>
      setMarks((prev) => prev.some((m) => m.id === mark.id) ? prev : [...prev, mark]),
    onMarkUpdated:   (mark) => {
      setMarks((prev) => prev.map((m) => (m.id === mark.id ? mark : m)));
      // counts rows carry the shape too, so they go stale on a shape edit
      refreshCounts();
    },
    onMarkDeleted:   ({ id }) => {
      setMarks((prev) => prev.filter((m) => m.id !== id));
      setAnnotations((prev) => prev.filter((a) => a.mark_id !== id));
      refreshCounts();
    },
    onSessionUpdated: (s) => {
      // Mirror the live done-state on whichever sessions list / current session
      // we're holding so the topbar pill flips for everyone in the room.
      setSession((prev) => (prev && prev.id === s.id ? { ...prev, ...s } : prev));
      setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, ...s } : x)));
    },
    onPageExclusionCreated:   (excl) => {
      setPageExclusions((prev) => prev.some((e) => e.id === excl.id) ? prev : [...prev, excl]);
      refreshCounts();
    },
    onPageExclusionDeleted:   ({ id }) => {
      setPageExclusions((prev) => prev.filter((e) => e.id !== id));
      refreshCounts();
    },
    onRegionExclusionCreated: (excl) => {
      setRegionExclusions((prev) => prev.some((e) => e.id === excl.id) ? prev : [...prev, excl]);
      refreshCounts();
    },
    onRegionExclusionDeleted: ({ id }) => {
      setRegionExclusions((prev) => prev.filter((e) => e.id !== id));
      refreshCounts();
    },
    onPresenceJoin:  ({ user: u }) => setUsers((prev) => [...new Set([...prev, u])]),
    onPresenceLeave: ({ user: u }) => setUsers((prev) => prev.filter((x) => x !== u)),
    onPresenceList:  ({ users: us }) => setUsers(us),
  });

  const toggleSessionDone = async () => {
    if (!session) return;
    try {
      const updated = await updateSession(session.id, { done: !session.done });
      setSession((prev) => prev && prev.id === updated.id ? { ...prev, ...updated } : prev);
      setSessions((prev) => prev.map((x) => x.id === updated.id ? { ...x, ...updated } : x));
    } catch (e) { console.error("toggle done failed:", e); }
  };

  // ── Annotation mutations ───────────────────────────────────────────────────
  const handleAnnotationCreate = async (bbox) => {
    if (!activeMark || !session) return;
    try {
      const ann = await createAnnotation(session.id, {
        mark_id: activeMark, page_number: currentPage, user, ...bbox,
      });
      // Dedupe — the WS broadcast for this same annotation arrives shortly,
      // and we don't want the row to appear twice.
      setAnnotations((prev) => prev.some((a) => a.id === ann.id) ? prev : [...prev, ann]);
      refreshCounts();
    } catch (e) { console.error(e); }
  };

  const handleAnnotationDelete = async (annId) => {
    if (!session) return;
    try {
      await deleteAnnotation(session.id, annId);
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
      refreshCounts();
    } catch (e) { console.error(e); }
  };

  // ── Exclusion mutations ───────────────────────────────────────────────────
  // Region exclusions follow the same optimistic-add + WS-dedupe pattern as
  // annotations. They never touch the underlying annotation rows — they only
  // tell the YOLO export to skip those crops.
  const handleExclusionCreate = async (rect) => {
    if (!session) return;
    try {
      const ex = await createRegionExclusion(session.id, {
        page_number: currentPage, user, ...rect,
      });
      setRegionExclusions((prev) => prev.some((e) => e.id === ex.id) ? prev : [...prev, ex]);
      refreshCounts();
    } catch (e) { console.error(e); }
  };

  const handleExclusionDelete = async (exclId) => {
    if (!session) return;
    try {
      await deleteRegionExclusion(session.id, exclId);
      setRegionExclusions((prev) => prev.filter((e) => e.id !== exclId));
      refreshCounts();
    } catch (e) { console.error(e); }
  };

  const isPageExcluded = pageExclusions.some((e) => e.page_number === currentPage);

  const toggleSkipCurrentPage = async () => {
    if (!session) return;
    try {
      if (isPageExcluded) {
        const existing = pageExclusions.find((e) => e.page_number === currentPage);
        if (!existing) return;
        await deletePageExclusion(session.id, existing.id);
        setPageExclusions((prev) => prev.filter((e) => e.id !== existing.id));
      } else {
        const ex = await createPageExclusion(session.id, { page_number: currentPage, user });
        setPageExclusions((prev) => prev.some((e) => e.id === ex.id) ? prev : [...prev, ex]);
      }
      refreshCounts();
    } catch (e) { console.error(e); }
  };

  // ── Project create ─────────────────────────────────────────────────────────
  const handleCreateProject = async () => {
    if (!newProjName.trim()) return;
    try {
      const p = await createProject(newProjName.trim());
      setProjects((prev) => [p, ...prev]);
      setNewProjName("");
    } catch (e) { alert("Failed: " + e.message); }
  };

  // ── PDF upload ─────────────────────────────────────────────────────────────
  const handleFileUpload = async (file) => {
    if (!file || !file.name.endsWith(".pdf")) return;
    setUploading(true);
    try {
      const s = await createSession(project.id, file);
      setSessions((prev) => [s, ...prev]);
    } catch (e) { alert("Upload failed: " + e.message); }
    finally { setUploading(false); }
  };

  // ── Username gate ──────────────────────────────────────────────────────────
  if (userPrompt) {
    return (
      <div style={s.gate}>
        <div style={s.gateBox}>
          <div style={s.gateTitle}>TakeOff Label</div>
          <div style={s.gateSub}>Enter your name to get started</div>
          <NameForm onSubmit={(name) => {
            localStorage.setItem("takeoff_label_user", name);
            setUser(name); setUserPrompt(false);
          }} />
        </div>
      </div>
    );
  }

  // ── Projects screen ────────────────────────────────────────────────────────
  if (view === "projects") {
    return (
      <div style={s.screen}>
        <TopBar title="TakeOff Label" right={<span style={s.userChip}>{user}</span>} />
        <div style={s.content}>
          <div style={s.card}>
            <div style={s.cardTitle}>Projects</div>
            <div style={s.row}>
              <input
                style={s.input}
                placeholder="New project name…"
                value={newProjName}
                onChange={(e) => setNewProjName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
              />
              <button style={s.btn} onClick={handleCreateProject}>Create</button>
            </div>
            <div style={s.list}>
              {projects.length === 0 && (
                <div style={s.empty}>No projects yet — create one above</div>
              )}
              {projects.map((p) => (
                <div key={p.id} style={s.listRow}
                  onClick={() => { setProject(p); setView("sessions"); }}>
                  <span style={s.listName}>{p.name}</span>
                  <button style={s.deleteBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete project "${p.name}"?`)) {
                        deleteProject(p.id);
                        setProjects((prev) => prev.filter((x) => x.id !== p.id));
                      }
                    }}>×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Sessions screen ────────────────────────────────────────────────────────
  if (view === "sessions") {
    return (
      <div style={s.screen}>
        <TopBar
          title={project.name}
          left={<button style={s.backBtn} onClick={() => { setProject(null); setView("projects"); }}>← Projects</button>}
          right={<span style={s.userChip}>{user}</span>}
        />
        <div style={s.content}>
          <div style={s.card}>
            <div style={s.cardTitle}>PDFs</div>
            <div
              style={s.uploadZone}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFileUpload(e.dataTransfer.files[0]); }}
            >
              {uploading ? "Uploading…" : "Drop a PDF here or click to upload"}
              <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: "none" }}
                onChange={(e) => handleFileUpload(e.target.files[0])} />
            </div>
            <div style={s.list}>
              {sessions.length === 0 && (
                <div style={s.empty}>No PDFs uploaded yet</div>
              )}
              {sessions.map((sess) => (
                <div key={sess.id} style={s.listRow}
                  onClick={() => { setSession(sess); setView("label"); }}>
                  <div style={s.listInfo}>
                    <span style={s.listName}>
                      {sess.filename}
                      {sess.done && <span style={s.doneBadge}>DONE</span>}
                    </span>
                    <span style={s.listMeta}>{sess.page_count} pages</span>
                  </div>
                  <button style={s.deleteBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete "${sess.filename}"?`)) {
                        deleteSession(sess.id);
                        setSessions((prev) => prev.filter((x) => x.id !== sess.id));
                      }
                    }}>×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Label screen ───────────────────────────────────────────────────────────
  const pageUrl = session ? getPageSvgUrl(session.id, currentPage) : null;

  return (
    <div style={s.root}>
      <div style={s.topBar}>
        <button style={s.backBtn}
          onClick={() => { setSession(null); setActiveMark(null); setView("sessions"); }}>
          ← {project?.name}
        </button>
        <span style={s.filename}>{session?.filename}</span>
        <PresenceBar users={users} currentUser={user} />
        <div style={s.pageNav}>
          <button style={s.navBtn}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}>←</button>
          <span style={s.pageInfo}>{currentPage} / {session?.page_count}</span>
          <button style={s.navBtn}
            onClick={() => setCurrentPage((p) => Math.min(session.page_count, p + 1))}
            disabled={currentPage >= session?.page_count}>→</button>
        </div>
        <button
          style={excludeMode ? s.excludeBtnActive : s.excludeBtn}
          onClick={() => {
            setExcludeMode((on) => {
              const next = !on;
              if (next) setActiveMark(null); // can't draw a mark and a zone at once
              return next;
            });
          }}
          title="Toggle exclude-zone mode — drag to flag instruction crops so their marks don't inflate the visible counts (YOLO export still includes them)"
        >
          {excludeMode ? "✕ Exit exclude" : "Exclude zone"}
        </button>
        <button
          style={isPageExcluded ? s.skipPageBtnActive : s.skipPageBtn}
          onClick={toggleSkipCurrentPage}
          title={isPageExcluded
            ? "This page's marks don't count toward visible totals — click to include them"
            : "Skip this whole page from visible counts (YOLO export still includes its annotations)"}
        >
          {isPageExcluded ? "✓ Page excluded" : "Skip page"}
        </button>
        <button
          style={session?.done ? s.doneBtnActive : s.doneBtn}
          onClick={toggleSessionDone}
          title={session?.done
            ? "This session is marked done — click to reopen"
            : "Mark this session as done so admin can include it in the dataset"}
        >
          {session?.done ? "✓ Done" : "Mark as done"}
        </button>
        <span style={s.modeHint}>
          {excludeMode
            ? "Exclude mode · Drag to add a zone · Click a zone to remove"
            : activeMark
              ? `Drawing: ${marks.find((m) => m.id === activeMark)?.name} · Click a box to delete`
              : "Drag to pan · Click a box to delete · Pick a mark to draw"}
        </span>
      </div>

      <div style={s.body}>
        <MarkManager
          sessionId={session?.id}
          marks={marks}
          counts={counts}
          activeMark={activeMark}
          onMarkSelect={(id) => {
            setActiveMark((prev) => prev === id ? null : id);
            // Picking a mark switches us back to drawing mode, so make sure
            // exclude-zone mode doesn't stay on in the background.
            setExcludeMode(false);
          }}
          onMarkCreated={(m) =>
            setMarks((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m])}
          onMarkUpdated={(m) => {
            setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
            refreshCounts();
          }}
          onMarkDeleted={(id) => {
            setMarks((prev) => prev.filter((m) => m.id !== id));
            setAnnotations((prev) => prev.filter((a) => a.mark_id !== id));
            if (activeMark === id) setActiveMark(null);
            refreshCounts();
          }}
          user={user}
        />

        <div style={s.canvasArea}>
          {pageUrl && (
            <ZoomPanViewer
              key={pageUrl}
              svgSrc={pageUrl}
              annotations={annotations}
              marks={marks}
              activeMark={activeMark}
              regionExclusions={regionExclusions.filter((r) => r.page_number === currentPage)}
              excludeMode={excludeMode}
              onAnnotationCreate={handleAnnotationCreate}
              onAnnotationDelete={handleAnnotationDelete}
              onExclusionCreate={handleExclusionCreate}
              onExclusionDelete={handleExclusionDelete}
            />
          )}
          {pageUrl && isPageExcluded && (
            <div style={s.pageExcludedBanner}>
              This page is excluded from the visible counts — annotations still ship in the YOLO export.
            </div>
          )}
          {!pageUrl && (
            <div style={s.placeholder}>Select a session to start</div>
          )}
        </div>

      </div>
    </div>
  );
}

// ── ZoomPanViewer — renders SVG page + label canvas inside a zoom/pan stage ──
//
// Page is fetched as SVG markup and injected as live SVG nodes (not <img>),
// so the browser re-rasterizes the parametric paths at the effective scale
// every paint — no DPI ceiling, no resampling, no zoom blur. The label canvas
// matches the SVG's nominal pixel dimensions so the two stay aligned, and the
// wrapper applies a CSS transform for zoom + pan:
//   • scroll wheel → zoom around cursor
//   • middle-click drag → pan
//   • auto-fits to container on first load and on page change
function ZoomPanViewer({ svgSrc, annotations, marks, activeMark,
  regionExclusions, excludeMode,
  onAnnotationCreate, onAnnotationDelete,
  onExclusionCreate,  onExclusionDelete }) {
  const [dims,    setDims]    = useState({ w: 0, h: 0 });
  const [svgHtml, setSvgHtml] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const containerRef    = useRef(null);
  const stateRef        = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  const [isPanning, setIsPanning] = useState(false);
  stateRef.current = { zoom, pan };

  // Fetch the page SVG, parse its viewBox to learn the page's parametric size,
  // and force concrete unitless width/height attributes so it lays out at
  // pixel dims we control. We pick 4× the viewBox so the canvas overlay keeps
  // ~the same bitmap resolution as the prior 300-DPI PNG (the SVG itself is
  // resolution-independent — its nominal size only affects layout, not
  // sharpness).
  useEffect(() => {
    if (!svgSrc) return;
    let cancelled = false;
    loadSvgPage(svgSrc)
      .then((page) => {
        if (cancelled) return;
        setDims({ w: page.w, h: page.h });
        setSvgHtml(page.html);
      })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [svgSrc]);

  // Fit-to-container once image dims are known
  useEffect(() => {
    if (!dims.w || !containerRef.current) return;
    const el = containerRef.current;
    const cw = el.clientWidth, ch = el.clientHeight;
    if (!cw || !ch) return;
    const fit = Math.min(cw / dims.w, ch / dims.h, 1);
    setZoom(fit);
    setPan({ x: (cw - dims.w * fit) / 2, y: (ch - dims.h * fit) / 2 });
  }, [dims.w, dims.h]);

  // Wheel zoom — attached non-passively so we can preventDefault.
  // Proportional to deltaY for smooth feel on both mouse wheel and trackpad.
  // stateRef is updated synchronously here so rapid back-to-back wheel events
  // compound correctly instead of reading stale render state.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const { zoom: z, pan: p } = stateRef.current;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Normalize deltaY across browsers: lines (Firefox) → ~16px/line; pages → 100px
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 100;
      const factor = Math.exp(-dy * 0.0015);
      const nz = Math.max(0.05, Math.min(20, z * factor));
      // Keep the image point under the cursor stationary
      const np = {
        x: mx - ((mx - p.x) / z) * nz,
        y: my - ((my - p.y) / z) * nz,
      };
      stateRef.current = { zoom: nz, pan: np };
      setZoom(nz);
      setPan(np);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [dims.w]); // re-run once container actually mounts (first render returns null)

  // Drag-to-pan — middle-click is the universal pan; left-click also pans
  // whenever no mark is selected (no-mark = "review" mode, mark = "draw" mode).
  // Listeners are on window so the drag survives the cursor leaving the area.
  const onMouseDown = (e) => {
    const isMiddle  = e.button === 1;
    // Left-click pans only when nothing else wants the drag — i.e. no mark is
    // active and we're not in exclude-draw mode. Otherwise the canvas child
    // gets to capture the drag for drawing.
    const isLeftPan = e.button === 0 && !activeMark && !excludeMode;
    if (!isMiddle && !isLeftPan) return;
    e.preventDefault();
    const triggerBtn = e.button;
    const start = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
    setIsPanning(true);
    const onMove = (ev) => {
      setPan({ x: start.px + (ev.clientX - start.mx), y: start.py + (ev.clientY - start.my) });
    };
    const onUp = (ev) => {
      if (ev.button !== triggerBtn) return;
      setIsPanning(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!dims.w) return null;
  return (
    <div
      ref={containerRef}
      onMouseDown={onMouseDown}
      onAuxClick={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "absolute", inset: 0, overflow: "hidden",
        cursor: isPanning ? "grabbing"
              : (excludeMode || activeMark) ? "default"
              : "grab",
      }}
    >
      <div style={{
        position: "absolute", left: 0, top: 0,
        width: dims.w, height: dims.h,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "0 0",
        background: "#fff",
      }}>
        <div
          dangerouslySetInnerHTML={{ __html: svgHtml }}
          style={{
            width: dims.w,
            height: dims.h,
            display: "block",
            userSelect: "none",
            pointerEvents: "none",
          }}
        />
        <LabelMode
          width={dims.w}
          height={dims.h}
          annotations={annotations}
          marks={marks}
          activeMark={activeMark}
          regionExclusions={regionExclusions}
          excludeMode={excludeMode}
          isPanning={isPanning}
          onAnnotationCreate={onAnnotationCreate}
          onAnnotationDelete={onAnnotationDelete}
          onExclusionCreate={onExclusionCreate}
          onExclusionDelete={onExclusionDelete}
        />
      </div>
      <div style={{
        position: "absolute", right: 12, bottom: 12,
        background: "rgba(18,18,42,0.85)", color: "#888",
        padding: "4px 10px", borderRadius: 4, fontSize: 11,
        pointerEvents: "none", border: "1px solid #2a2a4a",
      }}>
        {Math.round(zoom * 100)}% · scroll = zoom · middle-drag = pan
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function TopBar({ title, left, right }) {
  return (
    <div style={s.topBar}>
      {left}
      <span style={s.filename}>{title}</span>
      <div style={{ marginLeft: "auto" }}>{right}</div>
    </div>
  );
}

function NameForm({ onSubmit }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input style={s.input} placeholder="Your name" value={val} autoFocus
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && val.trim() && onSubmit(val.trim())} />
      <button style={{ ...s.btn, opacity: val.trim() ? 1 : 0.5 }}
        onClick={() => val.trim() && onSubmit(val.trim())}
        disabled={!val.trim()}>Enter</button>
    </div>
  );
}

const s = {
  root:       { display: "flex", flexDirection: "column", height: "100vh", background: "#0d0d1a", fontFamily: "system-ui, sans-serif", color: "#ccc" },
  screen:     { display: "flex", flexDirection: "column", height: "100vh", background: "#0d0d1a", fontFamily: "system-ui, sans-serif", color: "#ccc" },
  topBar:     { display: "flex", alignItems: "center", gap: 12, padding: "6px 14px", background: "#12122a", borderBottom: "1px solid #2a2a4a", flexShrink: 0, flexWrap: "wrap" },
  body:       { display: "flex", flex: 1, overflow: "hidden" },
  content:    { flex: 1, padding: 24, display: "flex", justifyContent: "center" },
  card:       { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 8, padding: 24, width: "100%", maxWidth: 1000, display: "flex", flexDirection: "column", gap: 16 },
  cardTitle:  { fontSize: 16, fontWeight: 700, color: "#fff" },
  row:        { display: "flex", gap: 8 },
  input:      { flex: 1, background: "#111122", border: "1px solid #333", borderRadius: 4, padding: "7px 10px", color: "#ddd", fontSize: 13, outline: "none" },
  btn:        { background: "#3b82f6", border: "none", borderRadius: 4, color: "#fff", fontWeight: 600, padding: "7px 16px", cursor: "pointer", fontSize: 13 },
  list:       { display: "flex", flexDirection: "column", gap: 4 },
  listRow:    { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "#111122", border: "1px solid #1e1e3a", borderRadius: 4, cursor: "pointer" },
  listName:   { color: "#ccc", fontSize: 13 },
  listMeta:   { color: "#444", fontSize: 12 },
  listInfo:   { display: "flex", flexDirection: "column", gap: 2 },
  deleteBtn:  { background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 18, lineHeight: 1 },
  empty:      { color: "#333", fontSize: 13, padding: "8px 0" },
  uploadZone: { border: "2px dashed #2a2a4a", borderRadius: 6, padding: "28px 16px", textAlign: "center", color: "#444", cursor: "pointer", fontSize: 13 },
  gate:       { height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0d1a" },
  gateBox:    { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 8, padding: "32px 28px", width: 300, display: "flex", flexDirection: "column", gap: 12 },
  gateTitle:  { fontSize: 20, fontWeight: 700, color: "#fff" },
  gateSub:    { fontSize: 13, color: "#555", marginBottom: 4 },
  backBtn:    { background: "none", border: "1px solid #333", borderRadius: 4, color: "#888", cursor: "pointer", padding: "4px 10px", fontSize: 12 },
  filename:   { fontWeight: 600, color: "#e8e8e8", fontSize: 13 },
  userChip:   { fontSize: 12, color: "#555" },
  pageNav:    { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" },
  navBtn:     { background: "none", border: "1px solid #333", borderRadius: 3, color: "#888", cursor: "pointer", padding: "3px 8px", fontSize: 13 },
  doneBtn:        { background: "none", border: "1px solid #333", borderRadius: 3, color: "#888", cursor: "pointer", padding: "3px 10px", fontSize: 12 },
  doneBtnActive:  { background: "#22c55e", border: "1px solid #22c55e", borderRadius: 3, color: "#fff", cursor: "pointer", padding: "3px 10px", fontSize: 12, fontWeight: 600 },
  excludeBtn:        { background: "none", border: "1px solid #333", borderRadius: 3, color: "#888", cursor: "pointer", padding: "3px 10px", fontSize: 12 },
  excludeBtnActive:  { background: "#ef4444", border: "1px solid #ef4444", borderRadius: 3, color: "#fff", cursor: "pointer", padding: "3px 10px", fontSize: 12, fontWeight: 600 },
  skipPageBtn:       { background: "none", border: "1px solid #333", borderRadius: 3, color: "#888", cursor: "pointer", padding: "3px 10px", fontSize: 12 },
  skipPageBtnActive: { background: "#ef4444", border: "1px solid #ef4444", borderRadius: 3, color: "#fff", cursor: "pointer", padding: "3px 10px", fontSize: 12, fontWeight: 600 },
  pageExcludedBanner: { position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", background: "rgba(239,68,68,0.92)", color: "#fff", padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, pointerEvents: "none", zIndex: 5, boxShadow: "0 1px 4px rgba(0,0,0,0.3)" },
  doneBadge:      { background: "#22c55e", color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 10, marginLeft: 6, letterSpacing: "0.04em" },
  pageInfo:   { fontSize: 12, color: "#888", minWidth: 60, textAlign: "center" },
  modeHint:   { fontSize: 11, color: "#555" },
  canvasArea: { flex: 1, position: "relative", overflow: "hidden", background: "#0d0d1a" },
  placeholder:{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 14 },
};
