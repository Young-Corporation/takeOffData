// LabelMode.jsx — Canvas overlay for drawing bounding boxes and rendering annotations
//
// Sits on top of your existing CanvasViewer PDF canvas as an absolute-positioned layer.
// Handles:
//   - Mouse-drag bbox drawing (when a mark is selected, OR in excludeMode)
//   - Rendering existing annotations with mark colors + labels
//   - Rendering region exclusions with red dashed style (always visible)
//   - Click-to-delete existing annotations (mark/view modes)
//   - Click-to-delete existing exclusions (excludeMode)
//
// Props:
//   width, height          — canvas dimensions in px (match rendered PDF page)
//   annotations            — Annotation[] for the current page
//   marks                  — Mark[] for the session (for color/name lookup)
//   activeMark             — mark id currently selected (null = view only)
//   regionExclusions       — RegionExclusion[] for the current page
//   excludeMode            — when true, drag draws an exclusion zone instead of
//                            an annotation, and clicks delete exclusions
//   onAnnotationCreate     — (bbox: {x_center,y_center,width,height}) => void
//   onAnnotationDelete     — (annotationId: string) => void
//   onExclusionCreate      — (rect: {x,y,width,height}) => void
//   onExclusionDelete      — (exclusionId: string) => void

import { useRef, useEffect, useCallback, useState } from "react";

// Build a closed canvas path for the mark's chosen shape, inscribed in the
// (x, y, w, h) bbox. Caller invokes fill()/stroke() on the resulting path.
// Unknown shapes fall back to a rectangle.
function buildShapePath(ctx, shape, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.beginPath();
  switch (shape) {
    case "circle":
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    case "diamond":
    case "long_diamond":
      ctx.moveTo(cx, y);
      ctx.lineTo(x + w, cy);
      ctx.lineTo(cx, y + h);
      ctx.lineTo(x, cy);
      ctx.closePath();
      return;
    case "hexagon":
    case "long_hexagon":
      // long_hexagon uses the same path — the bbox aspect dictates how
      // elongated the hex appears.
      ctx.moveTo(cx, y);
      ctx.lineTo(x + w, y + h * 0.25);
      ctx.lineTo(x + w, y + h * 0.75);
      ctx.lineTo(cx, y + h);
      ctx.lineTo(x, y + h * 0.75);
      ctx.lineTo(x, y + h * 0.25);
      ctx.closePath();
      return;
    case "triangle":
      ctx.moveTo(cx, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      return;
    case "cross": {
      // A "+" polygon — arm thickness = 1/3 of the smaller bbox side.
      const t  = Math.min(w, h) / 3;
      const lx = cx - t / 2, rx = cx + t / 2;
      const ty = cy - t / 2, by = cy + t / 2;
      ctx.moveTo(lx, y);
      ctx.lineTo(rx, y);
      ctx.lineTo(rx, ty);
      ctx.lineTo(x + w, ty);
      ctx.lineTo(x + w, by);
      ctx.lineTo(rx, by);
      ctx.lineTo(rx, y + h);
      ctx.lineTo(lx, y + h);
      ctx.lineTo(lx, by);
      ctx.lineTo(x, by);
      ctx.lineTo(x, ty);
      ctx.lineTo(lx, ty);
      ctx.closePath();
      return;
    }
    case "square":
    case "rectangle":
    case "other":
    default:
      ctx.rect(x, y, w, h);
  }
}

export default function LabelMode({
  width,
  height,
  annotations,
  marks,
  activeMark,
  regionExclusions = [],
  excludeMode = false,
  isPanning = false,    // when true the parent is panning — ignore canvas clicks
  onAnnotationCreate,
  onAnnotationDelete,
  onExclusionCreate,
  onExclusionDelete,
}) {
  const canvasRef = useRef(null);
  const drawing   = useRef(null); // { startX, startY } while dragging
  const [hoverId, setHoverId] = useState(null); // id of annotation under cursor

  const markMap = Object.fromEntries((marks ?? []).map((m) => [m.id, m]));

  // ── Drawing helpers ─────────────────────────────────────────────────────────

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);

    // Render exclusion zones first so annotations sit on top of them. They're
    // always visible regardless of mode so workers see what's been excluded.
    for (const ex of regionExclusions ?? []) {
      const rx = ex.x * width;
      const ry = ex.y * height;
      const rw = ex.width  * width;
      const rh = ex.height * height;
      const hovered = excludeMode && ex.id === hoverId;

      ctx.fillStyle   = hovered ? "rgba(239,68,68,0.22)" : "rgba(239,68,68,0.12)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth   = hovered ? 2.5 : 1.5;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);

      const label   = "EXCLUDED";
      ctx.font      = "10px system-ui, sans-serif";
      const tw      = ctx.measureText(label).width;
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(rx, ry, tw + 8, 14);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, rx + 4, ry + 11);
    }

    // Render all saved annotations
    for (const ann of annotations ?? []) {
      const mark = markMap[ann.mark_id];
      if (!mark) continue;
      const x = (ann.x_center - ann.width  / 2) * width;
      const y = (ann.y_center - ann.height / 2) * height;
      const w = ann.width  * width;
      const ah = ann.height * height;

      const hovered = ann.id === hoverId;

      // Render the mark's chosen shape (circle / diamond / hexagon / etc.)
      // inscribed in the saved bbox.
      buildShapePath(ctx, mark.shape, x, y, w, ah);
      if (hovered) {
        ctx.fillStyle = mark.color + "33"; // ~20% alpha
        ctx.fill();
      }
      ctx.strokeStyle = mark.color;
      ctx.lineWidth   = hovered ? 3 : 1.5;
      ctx.stroke();

      // Label background
      const label   = mark.name;
      ctx.font       = "11px system-ui, sans-serif";
      const tw       = ctx.measureText(label).width;
      ctx.fillStyle  = mark.color;
      ctx.fillRect(x, y - 16, tw + 8, 16);
      ctx.fillStyle  = "#fff";
      ctx.fillText(label, x + 4, y - 4);
    }
  }, [annotations, marks, width, height, markMap, hoverId, regionExclusions, excludeMode]);

  useEffect(redraw, [redraw]);

  // Drop any stale hover highlight while the parent is panning so the
  // previously-hovered box doesn't stay highlighted through the drag.
  useEffect(() => {
    if (isPanning) setHoverId(null);
  }, [isPanning]);

  // ── Mouse events ─────────────────────────────────────────────────────────────

  // Map mouse coords to canvas bitmap coords — works regardless of CSS scaling
  // (which the parent zoom/pan stage applies).
  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = width  / rect.width;
    const sy = height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  // Returns id of topmost annotation under (x,y), or null.
  // Thin/sliver annotations get padded to a minimum click area (~8 CSS px per
  // axis) so they remain selectable. Padding is computed in bitmap units by
  // sampling the current CSS-to-bitmap ratio from getBoundingClientRect, which
  // keeps the click target consistent at any zoom level.
  const hitTest = (x, y) => {
    const MIN_HIT_CSS = 8;
    const rect = canvasRef.current?.getBoundingClientRect();
    const sx = rect && rect.width  ? width  / rect.width  : 1;
    const sy = rect && rect.height ? height / rect.height : 1;
    const minHitX = MIN_HIT_CSS * sx;
    const minHitY = MIN_HIT_CSS * sy;
    for (const ann of [...(annotations ?? [])].reverse()) {
      const aw = ann.width  * width;
      const ah = ann.height * height;
      const padX = Math.max(0, (minHitX - aw) / 2);
      const padY = Math.max(0, (minHitY - ah) / 2);
      const ax = (ann.x_center - ann.width  / 2) * width  - padX;
      const ay = (ann.y_center - ann.height / 2) * height - padY;
      const bw = aw + padX * 2;
      const bh = ah + padY * 2;
      if (x >= ax && x <= ax + bw && y >= ay && y <= ay + bh) return ann.id;
    }
    return null;
  };

  // Same idea as hitTest, but for exclusion zones — used in excludeMode so
  // workers can click an existing zone to remove it.
  const hitTestExclusion = (x, y) => {
    for (const ex of [...(regionExclusions ?? [])].reverse()) {
      const rx = ex.x * width;
      const ry = ex.y * height;
      const rw = ex.width  * width;
      const rh = ex.height * height;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return ex.id;
    }
    return null;
  };

  const DRAG_THRESHOLD = 6; // bitmap pixels — distinguishes click from drag

  const onMouseDown = (e) => {
    if (e.button !== 0) return;        // let middle/right pass through (parent pans on middle)
    e.preventDefault();
    const { x, y } = getPos(e);
    drawing.current = { startX: x, startY: y, didDrag: false };
    setHoverId(null); // hide highlight while drag/draw is in progress
  };

  const onMouseMove = (e) => {
    if (!drawing.current) {
      const { x, y } = getPos(e);
      const over = excludeMode ? hitTestExclusion(x, y) : hitTest(x, y);
      if (over !== hoverId) setHoverId(over);
      return;
    }
    const { x, y } = getPos(e);
    const dx = x - drawing.current.startX;
    const dy = y - drawing.current.startY;
    if (!drawing.current.didDrag &&
        (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD)) {
      drawing.current.didDrag = true;
    }
    // While drawing: preview a dashed rect in red (exclude) or mark color.
    if (!drawing.current.didDrag) return;
    if (!excludeMode && !activeMark) return;

    redraw();
    const ctx = canvasRef.current.getContext("2d");
    if (excludeMode) {
      ctx.strokeStyle = "#ef4444";
    } else {
      const mark = markMap[activeMark];
      if (!mark) return;
      ctx.strokeStyle = mark.color;
    }
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(drawing.current.startX, drawing.current.startY, dx, dy);
    ctx.setLineDash([]);
  };

  const onMouseUp = (e) => {
    if (!drawing.current) return;
    const { x, y } = getPos(e);
    const wasDrag = drawing.current.didDrag;
    const startX  = drawing.current.startX;
    const startY  = drawing.current.startY;
    drawing.current = null;

    if (!wasDrag) {
      // Click (no drag): delete the topmost item of whichever kind this mode
      // targets. Modes don't cross-delete so workers can't trash an annotation
      // while in exclude mode (or vice versa).
      if (excludeMode) {
        const id = hitTestExclusion(x, y);
        if (id) onExclusionDelete?.(id);
        else redraw();
      } else {
        const id = hitTest(x, y);
        if (id) onAnnotationDelete?.(id);
        else redraw();
      }
      return;
    }

    if (excludeMode) {
      // Drag in exclude mode — create a new exclusion region (top-left + size).
      const x0 = Math.min(startX, x);
      const y0 = Math.min(startY, y);
      const w  = Math.abs(x - startX);
      const h  = Math.abs(y - startY);
      if (w > 1 && h > 1) {
        onExclusionCreate?.({
          x:      x0 / width,
          y:      y0 / height,
          width:  w  / width,
          height: h  / height,
        });
      }
      redraw();
      return;
    }

    if (!activeMark) { redraw(); return; }

    // Drag with active mark — create new annotation
    const dx = x - startX;
    const dy = y - startY;
    const x0 = Math.min(startX, x);
    const y0 = Math.min(startY, y);
    const w  = Math.abs(dx);
    const h  = Math.abs(dy);
    onAnnotationCreate?.({
      x_center: (x0 + w / 2) / width,
      y_center: (y0 + h / 2) / height,
      width:    w / width,
      height:   h / height,
    });
    redraw();
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position:  "absolute",
        top:       0,
        left:      0,
        // Cursor is derived from state so it stays in sync — no imperative
        // canvas.style mutation needed during mousemove.
        cursor:
          isPanning   ? "grabbing"  :
          hoverId     ? "pointer"   :
          excludeMode ? "crosshair" :
          activeMark  ? "crosshair" :
                        "grab",
        touchAction: "none",
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { if (!drawing.current) setHoverId(null); }}
    />
  );
}
