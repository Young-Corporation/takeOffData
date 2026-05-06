// labelApi.js — Supabase-backed API. All workers share the same project/session
// data in real time. PDFs live in Supabase Storage; annotations in Postgres.

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker   from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip         from 'jszip';
import { supabase }  from './supabase.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Cached PDFDocumentProxy per session — avoids re-downloading on every page turn.
const _pdfCache = new Map();

async function _getPdf(sessionId) {
  if (_pdfCache.has(sessionId)) return _pdfCache.get(sessionId);
  const { data: sess, error: e1 } = await supabase
    .from('sessions').select('storage_key').eq('id', sessionId).single();
  if (e1) throw e1;
  const { data: blob, error: e2 } = await supabase.storage
    .from('pdfs').download(sess.storage_key);
  if (e2) throw e2;
  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  _pdfCache.set(sessionId, pdf);
  return pdf;
}

function _throw(error) { if (error) throw error; }

// ── Projects ──────────────────────────────────────────────────────────────────

export async function createProject(name) {
  const { data, error } = await supabase.from('projects').insert({ name }).select().single();
  _throw(error); return data;
}

export async function listProjects() {
  const { data, error } = await supabase.from('projects').select().order('created_at', { ascending: false });
  _throw(error); return data;
}

export async function deleteProject(id) {
  const { data: sessions } = await supabase.from('sessions').select('storage_key').eq('project_id', id);
  if (sessions?.length) {
    await supabase.storage.from('pdfs').remove(sessions.map(s => s.storage_key));
  }
  const { error } = await supabase.from('projects').delete().eq('id', id);
  _throw(error); return null;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function createSession(projectId, file) {
  const sessionId  = crypto.randomUUID();
  const storageKey = `sessions/${sessionId}/source.pdf`;

  const { error: upErr } = await supabase.storage
    .from('pdfs').upload(storageKey, file, { contentType: 'application/pdf' });
  _throw(upErr);

  // Count pages in the browser so the DB record is complete immediately.
  const bytes    = await file.arrayBuffer();
  const pdf      = await pdfjsLib.getDocument({ data: bytes }).promise;
  _pdfCache.set(sessionId, pdf);

  const { data, error } = await supabase.from('sessions')
    .insert({ id: sessionId, project_id: projectId, filename: file.name,
              page_count: pdf.numPages, storage_key: storageKey })
    .select().single();
  _throw(error); return data;
}

export async function listSessions(projectId) {
  const { data, error } = await supabase.from('sessions')
    .select().eq('project_id', projectId).order('created_at', { ascending: false });
  _throw(error); return data;
}

export async function getSession(id) {
  const { data, error } = await supabase.from('sessions').select().eq('id', id).single();
  _throw(error); return data;
}

export async function updateSession(id, body) {
  const patch = {};
  if (body.done !== undefined) {
    patch.done    = body.done;
    patch.done_at = body.done ? new Date().toISOString() : null;
  }
  const { data, error } = await supabase.from('sessions').update(patch).eq('id', id).select().single();
  _throw(error); return data;
}

export async function deleteSession(id) {
  _pdfCache.delete(id);
  const { data: sess } = await supabase.from('sessions').select('storage_key').eq('id', id).single();
  if (sess?.storage_key) await supabase.storage.from('pdfs').remove([sess.storage_key]);
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  _throw(error); return null;
}

// ── Page rendering ────────────────────────────────────────────────────────────

export function getPageSvgUrl(sessionId, pageNumber) {
  return `idb://${sessionId}/${pageNumber}`;
}

// Canvas rendering at 6× scale (432 DPI). PNG avoids JPEG compression blur.
export async function renderPage(sessionId, pageNumber) {
  const pdf      = await _getPdf(sessionId);
  const page     = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 6 });
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.round(viewport.width);
  canvas.height  = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const dataUrl  = canvas.toDataURL('image/png');
  return {
    html: `<img src="${dataUrl}" width="${canvas.width}" height="${canvas.height}" style="display:block">`,
    w: canvas.width,
    h: canvas.height,
  };
}

// ── Marks ─────────────────────────────────────────────────────────────────────

export async function createMark(sessionId, body) {
  const { data, error } = await supabase.from('marks')
    .insert({ session_id: sessionId, name: body.name, shape: body.shape,
              color: body.color ?? '#3b82f6', created_by: body.user ?? null })
    .select().single();
  _throw(error); return data;
}

export async function listMarks(sessionId) {
  const { data, error } = await supabase.from('marks').select().eq('session_id', sessionId);
  _throw(error); return data;
}

export async function updateMark(sessionId, markId, body) {
  const patch = {};
  if (body.name  !== undefined) patch.name  = body.name;
  if (body.shape !== undefined) patch.shape = body.shape;
  if (body.color !== undefined) patch.color = body.color;
  const { data, error } = await supabase.from('marks')
    .update(patch).eq('id', markId).eq('session_id', sessionId).select().single();
  _throw(error); return data;
}

export async function deleteMark(sessionId, markId) {
  const { error } = await supabase.from('marks')
    .delete().eq('id', markId).eq('session_id', sessionId);
  _throw(error); return null;
}

// ── Annotations ───────────────────────────────────────────────────────────────

export async function createAnnotation(sessionId, body) {
  const { data, error } = await supabase.from('annotations')
    .insert({ session_id: sessionId, mark_id: body.mark_id,
              page_number: body.page_number, x_center: body.x_center,
              y_center: body.y_center, width: body.width, height: body.height,
              created_by: body.user ?? null })
    .select().single();
  _throw(error); return data;
}

export async function listAnnotations(sessionId, page = null) {
  let q = supabase.from('annotations').select().eq('session_id', sessionId);
  if (page !== null) q = q.eq('page_number', page);
  const { data, error } = await q;
  _throw(error); return data;
}

export async function deleteAnnotation(sessionId, annId) {
  const { error } = await supabase.from('annotations')
    .delete().eq('id', annId).eq('session_id', sessionId);
  _throw(error); return null;
}

// ── Counts ────────────────────────────────────────────────────────────────────

export async function getCounts(sessionId) {
  const [{ data: marks }, { data: annotations }, { data: pageExcls }, { data: regionExcls }] =
    await Promise.all([
      supabase.from('marks').select().eq('session_id', sessionId),
      supabase.from('annotations').select().eq('session_id', sessionId),
      supabase.from('page_exclusions').select().eq('session_id', sessionId),
      supabase.from('region_exclusions').select().eq('session_id', sessionId),
    ]);

  const excludedPages = new Set((pageExcls ?? []).map(e => e.page_number));
  const regionsByPage = {};
  for (const r of regionExcls ?? []) {
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
  for (const ann of annotations ?? []) {
    if (!isExcluded(ann)) countsByMark[ann.mark_id] = (countsByMark[ann.mark_id] ?? 0) + 1;
  }

  return (marks ?? []).map(m => ({
    mark_id: m.id, mark_name: m.name, shape: m.shape, color: m.color,
    count: countsByMark[m.id] ?? 0,
  }));
}

// ── Page exclusions ───────────────────────────────────────────────────────────

export async function listPageExclusions(sessionId) {
  const { data, error } = await supabase.from('page_exclusions').select().eq('session_id', sessionId);
  _throw(error); return data;
}

export async function createPageExclusion(sessionId, body) {
  const { data, error } = await supabase.from('page_exclusions')
    .upsert({ session_id: sessionId, page_number: body.page_number, created_by: body.user ?? null },
             { onConflict: 'session_id,page_number' })
    .select().single();
  _throw(error); return data;
}

export async function deletePageExclusion(sessionId, exclId) {
  const { error } = await supabase.from('page_exclusions')
    .delete().eq('id', exclId).eq('session_id', sessionId);
  _throw(error); return null;
}

// ── Region exclusions ─────────────────────────────────────────────────────────

export async function listRegionExclusions(sessionId, page = null) {
  let q = supabase.from('region_exclusions').select().eq('session_id', sessionId);
  if (page !== null) q = q.eq('page_number', page);
  const { data, error } = await q;
  _throw(error); return data;
}

export async function createRegionExclusion(sessionId, body) {
  const { data, error } = await supabase.from('region_exclusions')
    .insert({ session_id: sessionId, page_number: body.page_number,
              x: body.x, y: body.y, width: body.width, height: body.height,
              created_by: body.user ?? null })
    .select().single();
  _throw(error); return data;
}

export async function deleteRegionExclusion(sessionId, exclId) {
  const { error } = await supabase.from('region_exclusions')
    .delete().eq('id', exclId).eq('session_id', sessionId);
  _throw(error); return null;
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
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

export async function exportYolo(sessionId) {
  const [{ data: session }, { data: marks }, { data: annotations }] = await Promise.all([
    supabase.from('sessions').select().eq('id', sessionId).single(),
    supabase.from('marks').select().eq('session_id', sessionId),
    supabase.from('annotations').select().eq('session_id', sessionId),
  ]);
  if (!session)           throw new Error('Session not found');
  if (!annotations.length) throw new Error('No annotations to export');

  const uniqueShapes = [...new Set(marks.map(m => m.shape))].sort();
  const classNames   = uniqueShapes.map(_formatClassName);
  const shapeToClass = Object.fromEntries(uniqueShapes.map((s, i) => [s, i]));
  const markToShape  = Object.fromEntries(marks.map(m => [m.id, m.shape]));

  const byPage = {};
  for (const ann of annotations) (byPage[ann.page_number] = byPage[ann.page_number] || []).push(ann);

  const pdf  = await _getPdf(sessionId);
  const zip  = new JSZip();
  const stem = _sanitizeStem(session.filename);

  for (const [pageStr, anns] of Object.entries(byPage)) {
    const pageNum  = parseInt(pageStr, 10);
    const fileStem = `${stem}_p${String(pageNum).padStart(3, '0')}`;
    zip.file(`images/${fileStem}.png`, await _renderPagePng(pdf, pageNum));
    const lines = anns.flatMap(ann => {
      const shape = markToShape[ann.mark_id];
      return shape !== undefined
        ? [`${shapeToClass[shape]} ${ann.x_center.toFixed(6)} ${ann.y_center.toFixed(6)} ${ann.width.toFixed(6)} ${ann.height.toFixed(6)}`]
        : [];
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
  const { data: done, error } = await supabase.from('sessions').select().eq('done', true);
  _throw(error);
  if (!done?.length) throw new Error('No sessions marked done yet.');

  const doneIds = done.map(s => s.id);
  const [{ data: allMarks }, { data: allAnnotations }] = await Promise.all([
    supabase.from('marks').select().in('session_id', doneIds),
    supabase.from('annotations').select().in('session_id', doneIds),
  ]);
  if (!allAnnotations?.length) throw new Error('Done sessions exist but contain no annotations.');

  const uniqueShapes = [...new Set(allMarks.map(m => m.shape))].sort();
  const classNames   = uniqueShapes.map(_formatClassName);
  const shapeToClass = Object.fromEntries(uniqueShapes.map((s, i) => [s, i]));
  const markToShape  = Object.fromEntries(allMarks.map(m => [m.id, m.shape]));
  const sessionMap   = Object.fromEntries(done.map(s => [s.id, s]));

  const bySessionPage = {};
  for (const ann of allAnnotations) {
    const key = `${ann.session_id}|${ann.page_number}`;
    (bySessionPage[key] = bySessionPage[key] || []).push(ann);
  }

  const zip = new JSZip();
  let pagesWritten = 0;

  for (const [key, anns] of Object.entries(bySessionPage)) {
    const [sid, pageStr] = key.split('|');
    const session = sessionMap[sid];
    if (!session) continue;
    const pageNum  = parseInt(pageStr, 10);
    const fileStem = `${_sanitizeStem(session.filename)}_${sid.slice(0, 8)}_p${String(pageNum).padStart(3, '0')}`;
    zip.file(`images/${fileStem}.png`, await _renderPagePng(await _getPdf(sid), pageNum));
    const lines = anns.flatMap(ann => {
      const shape = markToShape[ann.mark_id];
      return shape !== undefined
        ? [`${shapeToClass[shape]} ${ann.x_center.toFixed(6)} ${ann.y_center.toFixed(6)} ${ann.width.toFixed(6)} ${ann.height.toFixed(6)}`]
        : [];
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
