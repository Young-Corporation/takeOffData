"""
routes.py — All REST endpoints for TakeOff Label.
Projects → Sessions → Marks / Annotations / Pages
"""
from __future__ import annotations

import logging

import fitz
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import SessionLocal, get_db
from models import Project, LabelSession, Mark, Annotation, PageExclusion, RegionExclusion
from storage import upload_pdf, download_pdf, upload_page_svg, download_text, delete_session_files
from ws import manager
from yolo_export import build_export, build_aggregate_export
from datetime import datetime

logger = logging.getLogger(__name__)
router = APIRouter()


def warm_session_svg_cache(session_id: str, pdf_bytes: bytes, page_count: int) -> None:
    """Render all pages to SVG after upload so navigation does not block on it."""
    db = SessionLocal()
    try:
        session = db.get(LabelSession, session_id)
        if not session:
            return

        page_keys = session.page_s3_keys or []
        if len(page_keys) < page_count:
            page_keys = [*page_keys, *([None] * (page_count - len(page_keys)))]

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            for idx in range(page_count):
                if page_keys[idx]:
                    continue
                svg = doc[idx].get_svg_image()
                page_keys[idx] = upload_page_svg(session_id, idx + 1, svg)
                session.page_s3_keys = [*page_keys]
                db.commit()
        finally:
            doc.close()
    except Exception:
        logger.warning("failed to warm SVG cache for session %s", session_id, exc_info=True)
    finally:
        db.close()


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str

class ProjectOut(BaseModel):
    id: str; name: str
    model_config = {"from_attributes": True}

class MarkCreate(BaseModel):
    name:  str
    shape: str
    color: str = "#3b82f6"
    user:  str | None = None

class MarkUpdate(BaseModel):
    name:  str | None = None
    shape: str | None = None
    color: str | None = None

class MarkOut(BaseModel):
    id: str; name: str; shape: str; color: str
    model_config = {"from_attributes": True}

class AnnotationCreate(BaseModel):
    mark_id:     str
    page_number: int
    x_center:    float
    y_center:    float
    width:       float
    height:      float
    user:        str | None = None

class AnnotationOut(BaseModel):
    id: str; mark_id: str; page_number: int
    x_center: float; y_center: float; width: float; height: float
    created_by: str | None
    model_config = {"from_attributes": True}

class SessionOut(BaseModel):
    id: str; filename: str; page_count: int; project_id: str
    done: bool = False
    done_at: datetime | None = None
    model_config = {"from_attributes": True}

class SessionUpdate(BaseModel):
    done: bool | None = None


class PageExclusionCreate(BaseModel):
    page_number: int
    user:        str | None = None

class PageExclusionOut(BaseModel):
    id: str; page_number: int; created_by: str | None
    model_config = {"from_attributes": True}

class RegionExclusionCreate(BaseModel):
    page_number: int
    x:      float
    y:      float
    width:  float
    height: float
    user:   str | None = None

class RegionExclusionOut(BaseModel):
    id: str; page_number: int
    x: float; y: float; width: float; height: float
    created_by: str | None
    model_config = {"from_attributes": True}


# ── Projects ──────────────────────────────────────────────────────────────────

@router.post("/projects", response_model=ProjectOut)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    p = Project(name=body.name)
    db.add(p); db.commit(); db.refresh(p)
    return p

@router.get("/projects", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)):
    return db.query(Project).order_by(Project.created_at.desc()).all()

@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    return p

@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    for s in p.sessions:
        delete_session_files(s.id)
    db.delete(p); db.commit()


# ── Sessions (scoped under project) ──────────────────────────────────────────

@router.post("/projects/{project_id}/sessions", response_model=SessionOut)
async def create_session(
    project_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db:   Session    = Depends(get_db),
):
    if not db.get(Project, project_id):
        raise HTTPException(404, "Project not found")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")

    doc        = fitz.open(stream=data, filetype="pdf")
    page_count = len(doc)
    doc.close()

    session = LabelSession(
        project_id=project_id,
        filename=file.filename,
        s3_key="",
        page_count=page_count,
        page_s3_keys=[None] * page_count,
    )
    db.add(session); db.flush()

    session.s3_key = upload_pdf(session.id, data, file.filename)
    db.commit(); db.refresh(session)
    background_tasks.add_task(warm_session_svg_cache, session.id, data, page_count)
    return session


@router.get("/projects/{project_id}/sessions", response_model=list[SessionOut])
def list_sessions(project_id: str, db: Session = Depends(get_db)):
    return (
        db.query(LabelSession)
        .filter(LabelSession.project_id == project_id)
        .order_by(LabelSession.created_at.desc())
        .all()
    )


@router.get("/sessions/{session_id}", response_model=SessionOut)
def get_session(session_id: str, db: Session = Depends(get_db)):
    s = db.get(LabelSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return s


@router.patch("/sessions/{session_id}", response_model=SessionOut)
async def update_session(session_id: str, body: SessionUpdate, db: Session = Depends(get_db)):
    s = db.get(LabelSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if body.done is not None:
        s.done    = body.done
        s.done_at = datetime.utcnow() if body.done else None
    db.commit(); db.refresh(s)
    out = SessionOut.model_validate(s)
    await manager.broadcast(session_id, {"type": "session:updated", "payload": out.model_dump(mode="json")})
    return s


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, db: Session = Depends(get_db)):
    s = db.get(LabelSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    delete_session_files(session_id)
    db.delete(s); db.commit()


# ── Page rendering — served directly, no presigned URL ───────────────────────

@router.get("/sessions/{session_id}/pages/{page_number}/svg")
def get_page_svg(session_id: str, page_number: int, db: Session = Depends(get_db)):
    """
    Streams the PDF page back as a vector SVG. The frontend injects it inline
    so the browser re-rasterizes the parametric paths at every zoom level —
    no DPI ceiling, no blur on zoom-in.
    """
    s = db.get(LabelSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if page_number < 1 or page_number > s.page_count:
        raise HTTPException(400, "Page out of range")

    page_keys = s.page_s3_keys or []
    cached_key = page_keys[page_number - 1] if page_number <= len(page_keys) else None
    if cached_key:
        try:
            svg = download_text(cached_key)
            return Response(content=svg, media_type="image/svg+xml")
        except Exception:
            logger.warning("failed to read cached svg %s; re-rendering", cached_key, exc_info=True)

    pdf  = download_pdf(s.s3_key)
    doc  = fitz.open(stream=pdf, filetype="pdf")
    page = doc[page_number - 1]
    svg  = page.get_svg_image()
    doc.close()

    key = upload_page_svg(session_id, page_number, svg)
    if len(page_keys) < s.page_count:
        page_keys = [*page_keys, *([None] * (s.page_count - len(page_keys)))]
    page_keys[page_number - 1] = key
    s.page_s3_keys = [*page_keys]
    db.commit()

    return Response(content=svg, media_type="image/svg+xml")


# ── Marks ─────────────────────────────────────────────────────────────────────

@router.post("/sessions/{session_id}/marks", response_model=MarkOut)
async def create_mark(session_id: str, body: MarkCreate, db: Session = Depends(get_db)):
    if not db.get(LabelSession, session_id):
        raise HTTPException(404, "Session not found")
    mark = Mark(session_id=session_id, name=body.name,
                shape=body.shape, color=body.color, created_by=body.user)
    db.add(mark); db.commit(); db.refresh(mark)
    out = MarkOut.model_validate(mark)
    await manager.broadcast(session_id, {"type": "mark:created", "payload": out.model_dump()})
    return mark


@router.get("/sessions/{session_id}/marks", response_model=list[MarkOut])
def list_marks(session_id: str, db: Session = Depends(get_db)):
    return db.query(Mark).filter(Mark.session_id == session_id).all()


@router.patch("/sessions/{session_id}/marks/{mark_id}", response_model=MarkOut)
async def update_mark(session_id: str, mark_id: str, body: MarkUpdate, db: Session = Depends(get_db)):
    mark = db.get(Mark, mark_id)
    if not mark or mark.session_id != session_id:
        raise HTTPException(404, "Mark not found")
    if body.name  is not None: mark.name  = body.name
    if body.shape is not None: mark.shape = body.shape
    if body.color is not None: mark.color = body.color
    db.commit(); db.refresh(mark)
    out = MarkOut.model_validate(mark)
    await manager.broadcast(session_id, {"type": "mark:updated", "payload": out.model_dump()})
    return mark


@router.delete("/sessions/{session_id}/marks/{mark_id}", status_code=204)
async def delete_mark(session_id: str, mark_id: str, db: Session = Depends(get_db)):
    mark = db.get(Mark, mark_id)
    if not mark or mark.session_id != session_id:
        raise HTTPException(404, "Mark not found")
    db.delete(mark); db.commit()
    await manager.broadcast(session_id, {"type": "mark:deleted", "payload": {"id": mark_id}})


# ── Annotations ───────────────────────────────────────────────────────────────

@router.post("/sessions/{session_id}/annotations", response_model=AnnotationOut)
async def create_annotation(session_id: str, body: AnnotationCreate,
                             db: Session = Depends(get_db)):
    if not db.get(LabelSession, session_id):
        raise HTTPException(404, "Session not found")
    if not db.get(Mark, body.mark_id):
        raise HTTPException(404, "Mark not found")
    ann = Annotation(
        session_id=session_id, mark_id=body.mark_id,
        page_number=body.page_number,
        x_center=body.x_center, y_center=body.y_center,
        width=body.width, height=body.height,
        created_by=body.user,
    )
    db.add(ann); db.commit(); db.refresh(ann)
    out = AnnotationOut.model_validate(ann)
    await manager.broadcast(session_id, {"type": "annotation:created", "payload": out.model_dump()})
    return ann


@router.get("/sessions/{session_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(session_id: str, page: int | None = None,
                     db: Session = Depends(get_db)):
    q = db.query(Annotation).filter(Annotation.session_id == session_id)
    if page is not None:
        q = q.filter(Annotation.page_number == page)
    return q.all()


@router.delete("/sessions/{session_id}/annotations/{ann_id}", status_code=204)
async def delete_annotation(session_id: str, ann_id: str, db: Session = Depends(get_db)):
    ann = db.get(Annotation, ann_id)
    if not ann or ann.session_id != session_id:
        raise HTTPException(404, "Annotation not found")
    db.delete(ann); db.commit()
    await manager.broadcast(session_id, {"type": "annotation:deleted", "payload": {"id": ann_id}})


# ── Counts ────────────────────────────────────────────────────────────────────

@router.get("/sessions/{session_id}/counts")
def get_counts(session_id: str, db: Session = Depends(get_db)):
    """Per-mark visible counts. Annotations on excluded pages or inside an
    excluded region are subtracted out of the displayed total — they remain
    in the DB and ship in the YOLO export untouched, but they don't inflate
    the worker's running tallies for legend/instruction crops."""
    marks = db.query(Mark).filter(Mark.session_id == session_id).all()

    excluded_pages: set[int] = {
        e.page_number for e in
        db.query(PageExclusion).filter(PageExclusion.session_id == session_id).all()
    }
    region_excls: list[RegionExclusion] = (
        db.query(RegionExclusion)
          .filter(RegionExclusion.session_id == session_id).all()
    )
    regions_by_page: dict[int, list[RegionExclusion]] = {}
    for r in region_excls:
        regions_by_page.setdefault(r.page_number, []).append(r)

    def _is_excluded(ann: Annotation) -> bool:
        if ann.page_number in excluded_pages:
            return True
        for r in regions_by_page.get(ann.page_number, []):
            if (r.x <= ann.x_center <= r.x + r.width and
                r.y <= ann.y_center <= r.y + r.height):
                return True
        return False

    annotations = (
        db.query(Annotation).filter(Annotation.session_id == session_id).all()
    )
    counts_by_mark: dict[str, int] = {}
    for a in annotations:
        if _is_excluded(a):
            continue
        counts_by_mark[a.mark_id] = counts_by_mark.get(a.mark_id, 0) + 1

    return [
        {
            "mark_id":   m.id,
            "mark_name": m.name,
            "shape":     m.shape,
            "color":     m.color,
            "count":     counts_by_mark.get(m.id, 0),
        }
        for m in marks
    ]


# ── Page exclusions ──────────────────────────────────────────────────────────
# Whole pages flagged to be skipped at YOLO export time. Annotations on these
# pages stay in the DB — the worker is told to keep marking everything so the
# raw shape/location data is preserved regardless of what ships to training.

@router.post("/sessions/{session_id}/page-exclusions", response_model=PageExclusionOut)
async def create_page_exclusion(session_id: str, body: PageExclusionCreate,
                                 db: Session = Depends(get_db)):
    s = db.get(LabelSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if body.page_number < 1 or body.page_number > s.page_count:
        raise HTTPException(400, "Page out of range")
    # Idempotent — one exclusion per (session, page)
    existing = (db.query(PageExclusion)
                  .filter(PageExclusion.session_id == session_id,
                          PageExclusion.page_number == body.page_number)
                  .first())
    if existing:
        return existing
    excl = PageExclusion(session_id=session_id,
                         page_number=body.page_number,
                         created_by=body.user)
    db.add(excl); db.commit(); db.refresh(excl)
    out = PageExclusionOut.model_validate(excl)
    await manager.broadcast(session_id, {"type": "page-exclusion:created",
                                         "payload": out.model_dump()})
    return excl


@router.get("/sessions/{session_id}/page-exclusions",
            response_model=list[PageExclusionOut])
def list_page_exclusions(session_id: str, db: Session = Depends(get_db)):
    return (db.query(PageExclusion)
              .filter(PageExclusion.session_id == session_id)
              .all())


@router.delete("/sessions/{session_id}/page-exclusions/{excl_id}", status_code=204)
async def delete_page_exclusion(session_id: str, excl_id: str,
                                 db: Session = Depends(get_db)):
    excl = db.get(PageExclusion, excl_id)
    if not excl or excl.session_id != session_id:
        raise HTTPException(404, "Exclusion not found")
    db.delete(excl); db.commit()
    await manager.broadcast(session_id, {"type": "page-exclusion:deleted",
                                         "payload": {"id": excl_id}})


# ── Region exclusions ────────────────────────────────────────────────────────

@router.post("/sessions/{session_id}/region-exclusions",
             response_model=RegionExclusionOut)
async def create_region_exclusion(session_id: str, body: RegionExclusionCreate,
                                   db: Session = Depends(get_db)):
    s = db.get(LabelSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if body.page_number < 1 or body.page_number > s.page_count:
        raise HTTPException(400, "Page out of range")
    excl = RegionExclusion(
        session_id=session_id, page_number=body.page_number,
        x=body.x, y=body.y, width=body.width, height=body.height,
        created_by=body.user,
    )
    db.add(excl); db.commit(); db.refresh(excl)
    out = RegionExclusionOut.model_validate(excl)
    await manager.broadcast(session_id, {"type": "region-exclusion:created",
                                         "payload": out.model_dump()})
    return excl


@router.get("/sessions/{session_id}/region-exclusions",
            response_model=list[RegionExclusionOut])
def list_region_exclusions(session_id: str, page: int | None = None,
                            db: Session = Depends(get_db)):
    q = db.query(RegionExclusion).filter(RegionExclusion.session_id == session_id)
    if page is not None:
        q = q.filter(RegionExclusion.page_number == page)
    return q.all()


@router.delete("/sessions/{session_id}/region-exclusions/{excl_id}", status_code=204)
async def delete_region_exclusion(session_id: str, excl_id: str,
                                   db: Session = Depends(get_db)):
    excl = db.get(RegionExclusion, excl_id)
    if not excl or excl.session_id != session_id:
        raise HTTPException(404, "Exclusion not found")
    db.delete(excl); db.commit()
    await manager.broadcast(session_id, {"type": "region-exclusion:deleted",
                                         "payload": {"id": excl_id}})


# ── Export ────────────────────────────────────────────────────────────────────

@router.post("/sessions/{session_id}/export")
def export_yolo(session_id: str, db: Session = Depends(get_db)):
    try:
        url = build_export(session_id, db)
        return {"download_url": url}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/export-all")
def export_all(db: Session = Depends(get_db)):
    """Aggregate every *done* session into one zip and return its download URL.
    Rebuilt on demand, so consecutive calls always reflect the latest data."""
    try:
        url, stats = build_aggregate_export(db)
        return {"download_url": url, **stats}
    except ValueError as e:
        raise HTTPException(400, str(e))
