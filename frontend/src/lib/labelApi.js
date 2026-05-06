// labelApi.js — Client-side storage via IndexedDB + PDF.js rendering + JSZip export.
// Same function signatures as the original server-backed version so all components
// work without changes.

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker  from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip        from 'jszip';
import {
  txGet, txGetAll, txGetAllByIndex,
  txPut, txDelete, txDeleteAllByIndex,
} from './db.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Cached PDFDocumentProxy objects — avoids re-parsing the binary on every page turn.
const _pdfCache = new Map();

async function _getPdf(sessionId) {
  if (_pdfCache.has(sessionId)) return _pdfCache.get(sessionId);
  const session = await txGet('sessions', sessionId);
  if (!session) throw new Error('Session not found');
  const pdf = await pdfjsLib.getDocument({ data: session.pdf_bytes.slice() }).promise;
  _pdfCache.set(sessionId, pdf);
  return pdf;
}

function _sessionOut({ pdf_bytes: _ignored, ...rest }) {
  return rest;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function createProject(name) {
  const p = { id: crypto.randomUUID(), name, created_at: new Date().toISOString() };
  await txPut('projects', p);
  return p;
}

export async function listProjects() {
  const all = await txGetAll('projects');
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function deleteProject(id) {
  const sessions = await txGetAllByIndex('sessions', 'project_id', id);
  for (const s of sessions) await _deleteSessionCascade(s.id);
  await txDelete('projects', id);
  return null;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function createSession(projectId, file) {
  const bytes    = await file.arrayBuffer();
  const pdf      = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const session  = {
    id:         crypto.randomUUID(),
    project_id: projectId,
    filename:   file.name,
    page_count: pdf.numPages,
    done:       false,
    done_at:    null,
    pdf_bytes:  bytes,
    created_at: new Date().toISOString(),
  };
  await txPut('sessions', session);
  _pdfCache.set(session.id, pdf);
  return _sessionOut(session);
}

export async function listSessions(projectId) {
  const all = await txGetAllByIndex('sessions', 'project_id', projectId);
  return all
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(_sessionOut);
}

export async function getSession(id) {
  const s = await txGet('sessions', id);
  if (!s) throw new Error('Session not found');
  return _sessionOut(s);
}

export async function updateSession(id, body) {
  const s = await txGet('sessions', id);
  if (!s) throw new Error('Session not found');
  if (body.done !== undefined) {
    s.done    = body.done;
    s.done_at = body.done ? new Date().toISOString() : null;
  }
  await txPut('sessions', s);
  return _sessionOut(s);
}

export async function deleteSession(id) {
  await _deleteSessionCascade(id);
  return null;
}

async function _deleteSessionCascade(id) {
  _pdfCache.delete(id);
  await Promise.all([
    txDeleteAllByIndex('annotations',       'session_id', id),
    txDeleteAllByIndex('marks',             'session_id', id),
    txDeleteAllByIndex('page_exclusions',   'session_id', id),
    txDeleteAllByIndex('region_exclusions', 'session_id', id),
  ]);
  await txDelete('sessions', id);
}

// ── Page rendering ────────────────────────────────────────────────────────────

// Returns a virtual URL — LabelApp.jsx detects idb:// and calls renderPage().
export function getPageSvgUrl(sessionId, pageNumber) {
  return `idb://${sessionId}/${pageNumber}`;
}

// Renders a PDF page at 6× scale (≈ 432 DPI). The high pixel density means the
// canvas stays sharp across the full zoom range of ZoomPanViewer (up to 20× from
// fit), which is visually equivalent to SVG rendering for labeling purposes.
export async function renderPage(sessionId, pageNumber) {
  const pdf      = await _getPdf(sessionId);
  const page     = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 6 });
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.round(viewport.width);
  canvas.height  = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const dataUrl  = canvas.toDataURL('image/jpeg', 0.93);
  return {
    html: `<img src="${dataUrl}" width="${canvas.width}" height="${canvas.height}" style="display:block">`,
    w: canvas.width,
    h: canvas.height,
  };
}

// ── Marks ─────────────────────────────────────────────────────────────────────

function _markOut({ session_id: _s, created_by: _c, ...rest }) {
  return rest;
}

export async function createMark(sessionId, body) {
  const mark = {
    id:         crypto.randomUUID(),
    session_id: sessionId,
    name:       body.name,
    shape:      body.shape,
    color:      body.color ?? '#3b82f6',
    created_by: body.user ?? null,
  };
  await txPut('marks', mark);
  return _markOut(mark);
}

export async function listMarks(sessionId) {
  return (await txGetAllByIndex('marks', 'session_id', sessionId)).map(_markOut);
}

export async function updateMark(sessionId, markId, body) {
  const mark = await txGet('marks', markId);
  if (!mark || mark.session_id !== sessionId) throw new Error('Mark not found');
  if (body.name  !== undefined) mark.name  = body.name;
  if (body.shape !== undefined) mark.shape = body.shape;
  if (body.color !== undefined) mark.color = body.color;
  await txPut('marks', mark);
  return _markOut(mark);
}

export async function deleteMark(sessionId, markId) {
  const mark = await txGet('marks', markId);
  if (!mark || mark.session_id !== sessionId) throw new Error('Mark not found');
  await txDeleteAllByIndex('annotations', 'mark_id', markId);
  await txDelete('marks', markId);
  return null;
}

// ── Annotations ───────────────────────────────────────────────────────────────

function _annOut({ session_id: _s, ...rest }) {
  return rest;
}

export async function createAnnotation(sessionId, body) {
  const ann = {
    id:           crypto.randomUUID(),
    session_id:   sessionId,
    mark_id:      body.mark_id,
    page_number:  body.page_number,
    x_center:     body.x_center,
    y_center:     body.y_center,
    width:        body.width,
    height:       body.height,
    created_by:   body.user ?? null,
  };
  await txPut('annotations', ann);
  return _annOut(ann);
}

export async function listAnnotations(sessionId, page = null) {
  let all;
  if (page !== null) {
    all = await txGetAllByIndex('annotations', 'session_page', [sessionId, page]);
  } else {
    all = await txGetAllByIndex('annotations', 'session_id', sessionId);
  }
  return all.map(_annOut);
}

export async function deleteAnnotation(sessionId, annId) {
  const ann = await txGet('annotations', annId);
  if (!ann || ann.session_id !== sessionId) throw new Error('Annotation not found');
  await txDelete('annotations', annId);
  return null;
}

// ── Counts ────────────────────────────────────────────────────────────────────

export async function getCounts(sessionId) {
  const [marks, annotations, pageExcls, regionExcls] = await Promise.all([
    txGetAllByIndex('marks',             'session_id', sessionId),
    txGetAllByIndex('annotations',       'session_id', sessionId),
    txGetAllByIndex('page_exclusions',   'session_id', sessionId),
    txGetAllByIndex('region_exclusions', 'session_id', sessionId),
  ]);

  const excludedPages = new Set(pageExcls.map(e => e.page_number));
  const regionsByPage = {};
  for (const r of regionExcls) {
    (regionsByPage[r.page_number] = regionsByPage[r.page_number] || []).push(r);
  }

  function isExcluded(ann) {
    if (excludedPages.has(ann.page_number)) return true;
    for (const r of regionsByPage[ann.page_number] ?? []) {
      if (ann.x_center >= r.x && ann.x_center <= r.x + r.width &&
          ann.y_center >= r.y && ann.y_center <= r.y + r.height) return true;
    }
    return false;
  }

  const countsByMark = {};
  for (const ann of annotations) {
    if (!isExcluded(ann)) {
      countsByMark[ann.mark_id] = (countsByMark[ann.mark_id] ?? 0) + 1;
    }
  }

  return marks.map(m => ({
    mark_id:   m.id,
    mark_name: m.name,
    shape:     m.shape,
    color:     m.color,
    count:     countsByMark[m.id] ?? 0,
  }));
}

// ── Page exclusions ───────────────────────────────────────────────────────────

function _pexclOut({ session_id: _s, ...rest }) {
  return rest;
}

export async function listPageExclusions(sessionId) {
  return (await txGetAllByIndex('page_exclusions', 'session_id', sessionId)).map(_pexclOut);
}

export async function createPageExclusion(sessionId, body) {
  const existing = (await txGetAllByIndex('page_exclusions', 'session_id', sessionId))
    .find(e => e.page_number === body.page_number);
  if (existing) return _pexclOut(existing);
  const excl = {
    id:          crypto.randomUUID(),
    session_id:  sessionId,
    page_number: body.page_number,
    created_by:  body.user ?? null,
  };
  await txPut('page_exclusions', excl);
  return _pexclOut(excl);
}

export async function deletePageExclusion(sessionId, exclId) {
  const excl = await txGet('page_exclusions', exclId);
  if (!excl || excl.session_id !== sessionId) throw new Error('Exclusion not found');
  await txDelete('page_exclusions', exclId);
  return null;
}

// ── Region exclusions ─────────────────────────────────────────────────────────

function _rexclOut({ session_id: _s, ...rest }) {
  return rest;
}

export async function listRegionExclusions(sessionId, page = null) {
  const all = await txGetAllByIndex('region_exclusions', 'session_id', sessionId);
  const out = all.map(_rexclOut);
  return page !== null ? out.filter(r => r.page_number === page) : out;
}

export async function createRegionExclusion(sessionId, body) {
  const excl = {
    id:          crypto.randomUUID(),
    session_id:  sessionId,
    page_number: body.page_number,
    x:           body.x,
    y:           body.y,
    width:       body.width,
    height:      body.height,
    created_by:  body.user ?? null,
  };
  await txPut('region_exclusions', excl);
  return _rexclOut(excl);
}

export async function deleteRegionExclusion(sessionId, exclId) {
  const excl = await txGet('region_exclusions', exclId);
  if (!excl || excl.session_id !== sessionId) throw new Error('Exclusion not found');
  await txDelete('region_exclusions', exclId);
  return null;
}

// ── Export ────────────────────────────────────────────────────────────────────

function _sanitizeStem(filename) {
  return (filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '')) || 'session';
}

function _formatClassName(shape) {
  return shape.toLowerCase().replace(/_/g, ' ');
}

async function _renderPagePng(pdf, pageNumber) {
  const page     = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 150 / 72 });
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.round(viewport.width);
  canvas.height  = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function exportYolo(sessionId) {
  const [session, marks, annotations] = await Promise.all([
    txGet('sessions', sessionId),
    txGetAllByIndex('marks',       'session_id', sessionId),
    txGetAllByIndex('annotations', 'session_id', sessionId),
  ]);
  if (!session)       throw new Error('Session not found');
  if (!annotations.length) throw new Error('No annotations to export');

  const uniqueShapes  = [...new Set(marks.map(m => m.shape))].sort();
  const classNames    = uniqueShapes.map(_formatClassName);
  const shapeToClass  = Object.fromEntries(uniqueShapes.map((s, i) => [s, i]));
  const markToShape   = Object.fromEntries(marks.map(m => [m.id, m.shape]));

  const byPage = {};
  for (const ann of annotations) {
    (byPage[ann.page_number] = byPage[ann.page_number] || []).push(ann);
  }

  const pdf  = await _getPdf(sessionId);
  const zip  = new JSZip();
  const stem = _sanitizeStem(session.filename);

  for (const [pageStr, anns] of Object.entries(byPage)) {
    const pageNum  = parseInt(pageStr, 10);
    const fileStem = `${stem}_p${String(pageNum).padStart(3, '0')}`;
    const pngBlob  = await _renderPagePng(pdf, pageNum);
    zip.file(`images/${fileStem}.png`, pngBlob);

    const lines = anns.flatMap(ann => {
      const shape   = markToShape[ann.mark_id];
      if (shape === undefined) return [];
      return [`${shapeToClass[shape]} ${ann.x_center.toFixed(6)} ${ann.y_center.toFixed(6)} ${ann.width.toFixed(6)} ${ann.height.toFixed(6)}`];
    });
    zip.file(`labels/${fileStem}.txt`, lines.join('\n'));
  }

  zip.file('classes.txt', classNames.join('\n') + '\n');
  zip.file('notes.json', JSON.stringify({
    categories: classNames.map((n, i) => ({ id: i, name: n })),
    info: { year: new Date().getFullYear(), version: '1.0', contributor: 'TakeOff Label' },
  }, null, 2));

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { download_url: URL.createObjectURL(blob) };
}

export async function exportAll() {
  const allSessions = await txGetAll('sessions');
  const done        = allSessions.filter(s => s.done);
  if (!done.length) throw new Error('No sessions marked done yet.');

  const doneIds    = done.map(s => s.id);
  const [allMarks, allAnnotations] = await Promise.all([
    Promise.all(doneIds.map(id => txGetAllByIndex('marks',       'session_id', id))).then(a => a.flat()),
    Promise.all(doneIds.map(id => txGetAllByIndex('annotations', 'session_id', id))).then(a => a.flat()),
  ]);

  if (!allAnnotations.length) throw new Error('Done sessions exist but contain no annotations.');

  const uniqueShapes  = [...new Set(allMarks.map(m => m.shape))].sort();
  const classNames    = uniqueShapes.map(_formatClassName);
  const shapeToClass  = Object.fromEntries(uniqueShapes.map((s, i) => [s, i]));
  const markToShape   = Object.fromEntries(allMarks.map(m => [m.id, m.shape]));

  const bySessionPage = {};
  for (const ann of allAnnotations) {
    const key = `${ann.session_id}|${ann.page_number}`;
    (bySessionPage[key] = bySessionPage[key] || []).push(ann);
  }

  const sessionMap = Object.fromEntries(done.map(s => [s.id, s]));
  const zip        = new JSZip();
  let pagesWritten = 0;

  for (const [key, anns] of Object.entries(bySessionPage)) {
    const [sid, pageStr] = key.split('|');
    const session        = sessionMap[sid];
    if (!session) continue;
    const pageNum  = parseInt(pageStr, 10);
    const fileStem = `${_sanitizeStem(session.filename)}_${sid.slice(0, 8)}_p${String(pageNum).padStart(3, '0')}`;
    const pdf      = await _getPdf(sid);
    const pngBlob  = await _renderPagePng(pdf, pageNum);
    zip.file(`images/${fileStem}.png`, pngBlob);

    const lines = anns.flatMap(ann => {
      const shape = markToShape[ann.mark_id];
      if (shape === undefined) return [];
      return [`${shapeToClass[shape]} ${ann.x_center.toFixed(6)} ${ann.y_center.toFixed(6)} ${ann.width.toFixed(6)} ${ann.height.toFixed(6)}`];
    });
    zip.file(`labels/${fileStem}.txt`, lines.join('\n'));
    pagesWritten++;
  }

  zip.file('classes.txt', classNames.join('\n') + '\n');
  zip.file('notes.json', JSON.stringify({
    categories: classNames.map((n, i) => ({ id: i, name: n })),
    info: { year: new Date().getFullYear(), version: '1.0', contributor: 'TakeOff Label' },
  }, null, 2));

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return {
    download_url: URL.createObjectURL(blob),
    sessions:    done.length,
    pages:       pagesWritten,
    annotations: allAnnotations.length,
    classes:     uniqueShapes.length,
  };
}

// ── Session data share (worker → admin) ───────────────────────────────────────
// Workers export a .json package when they mark a session done. The admin
// imports those files into their own browser so exportAll() can aggregate them.

export async function exportSessionData(sessionId) {
  const [session, marks, annotations, pageExcls, regionExcls] = await Promise.all([
    txGet('sessions', sessionId),
    txGetAllByIndex('marks',             'session_id', sessionId),
    txGetAllByIndex('annotations',       'session_id', sessionId),
    txGetAllByIndex('page_exclusions',   'session_id', sessionId),
    txGetAllByIndex('region_exclusions', 'session_id', sessionId),
  ]);
  if (!session) throw new Error('Session not found');

  // Encode PDF bytes as base64 so the JSON is self-contained.
  const pdfBase64 = btoa(
    new Uint8Array(session.pdf_bytes).reduce((s, b) => s + String.fromCharCode(b), '')
  );

  const pkg = JSON.stringify({
    _v:              1,
    session:         _sessionOut(session),
    marks,
    annotations,
    page_exclusions:   pageExcls,
    region_exclusions: regionExcls,
    pdf_base64:      pdfBase64,
  });

  const blob = new Blob([pkg], { type: 'application/json' });
  return URL.createObjectURL(blob);
}

export async function importSessionData(jsonText) {
  const pkg = JSON.parse(jsonText);
  if (pkg._v !== 1) throw new Error('Unknown data file version');

  const { session, marks, annotations, page_exclusions, region_exclusions, pdf_base64 } = pkg;

  // Decode base64 PDF back to ArrayBuffer.
  const raw      = atob(pdf_base64);
  const pdfBytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) pdfBytes[i] = raw.charCodeAt(i);

  // Overwrite any existing records with the same IDs (idempotent re-import).
  await txPut('sessions', { ...session, done: true, pdf_bytes: pdfBytes.buffer });
  await Promise.all([
    ...marks.map(r           => txPut('marks',             r)),
    ...annotations.map(r     => txPut('annotations',       r)),
    ...page_exclusions.map(r => txPut('page_exclusions',   r)),
    ...region_exclusions.map(r => txPut('region_exclusions', r)),
  ]);

  // Ensure the project exists (creates a placeholder if the admin never made it).
  const proj = await txGet('projects', session.project_id);
  if (!proj) {
    await txPut('projects', {
      id:         session.project_id,
      name:       `Imported — ${session.filename}`,
      created_at: session.created_at,
    });
  }

  return _sessionOut({ ...session, done: true });
}
