// labelApi.js — REST client for TakeOff Label API

const BASE = "/api/label";

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Projects ──────────────────────────────────────────────────────────────────

export const createProject = (name)       => req("POST", "/projects", { name });
export const listProjects  = ()           => req("GET",  "/projects");
export const deleteProject = (id)         => req("DELETE", `/projects/${id}`);

// ── Sessions ──────────────────────────────────────────────────────────────────

export const createSession = (projectId, file) => {
  const fd = new FormData();
  fd.append("file", file);
  return req("POST", `/projects/${projectId}/sessions`, fd);
};

export const listSessions  = (projectId) => req("GET", `/projects/${projectId}/sessions`);
export const getSession    = (id)        => req("GET", `/sessions/${id}`);
export const updateSession = (id, body)  => req("PATCH", `/sessions/${id}`, body);
export const deleteSession = (id)        => req("DELETE", `/sessions/${id}`);

// ── Pages — direct image URL (no presigned S3, no CORS issues) ───────────────

export const getPageImageUrl = (sessionId, pageNumber) =>
  `${BASE}/sessions/${sessionId}/pages/${pageNumber}/image`;

// ── Marks ─────────────────────────────────────────────────────────────────────

export const createMark = (sessionId, body) =>
  req("POST", `/sessions/${sessionId}/marks`, body);

export const listMarks  = (sessionId) =>
  req("GET", `/sessions/${sessionId}/marks`);

export const updateMark = (sessionId, markId, body) =>
  req("PATCH", `/sessions/${sessionId}/marks/${markId}`, body);

export const deleteMark = (sessionId, markId) =>
  req("DELETE", `/sessions/${sessionId}/marks/${markId}`);

// ── Annotations ───────────────────────────────────────────────────────────────

export const createAnnotation = (sessionId, body) =>
  req("POST", `/sessions/${sessionId}/annotations`, body);

export const listAnnotations = (sessionId, page = null) => {
  const qs = page !== null ? `?page=${page}` : "";
  return req("GET", `/sessions/${sessionId}/annotations${qs}`);
};

export const deleteAnnotation = (sessionId, annId) =>
  req("DELETE", `/sessions/${sessionId}/annotations/${annId}`);

// ── Exclusions ───────────────────────────────────────────────────────────────
// Pages and regions that workers flag as not-for-training. Annotations inside
// them are kept in the DB but filtered out of the YOLO export.

export const listPageExclusions = (sessionId) =>
  req("GET", `/sessions/${sessionId}/page-exclusions`);

export const createPageExclusion = (sessionId, body) =>
  req("POST", `/sessions/${sessionId}/page-exclusions`, body);

export const deletePageExclusion = (sessionId, exclId) =>
  req("DELETE", `/sessions/${sessionId}/page-exclusions/${exclId}`);

export const listRegionExclusions = (sessionId, page = null) => {
  const qs = page !== null ? `?page=${page}` : "";
  return req("GET", `/sessions/${sessionId}/region-exclusions${qs}`);
};

export const createRegionExclusion = (sessionId, body) =>
  req("POST", `/sessions/${sessionId}/region-exclusions`, body);

export const deleteRegionExclusion = (sessionId, exclId) =>
  req("DELETE", `/sessions/${sessionId}/region-exclusions/${exclId}`);


// ── Counts ────────────────────────────────────────────────────────────────────

export const getCounts = (sessionId) =>
  req("GET", `/sessions/${sessionId}/counts`);

// ── Export ────────────────────────────────────────────────────────────────────

export const exportYolo = (sessionId) =>
  req("POST", `/sessions/${sessionId}/export`);

export const exportAll = () => req("POST", "/export-all");
