"""
yolo_export.py — Assembles a YOLO-format training zip from session annotations.

Output mirrors Label Studio's YOLO export so it's a drop-in for existing
training pipelines:

    classes.txt      — one class name per line (lowercase, spaces, no underscores)
    notes.json       — { categories: [...], info: {...} }
    images/<stem>_p<NNN>.png
    labels/<stem>_p<NNN>.txt   — "<class_id> x_center y_center width height"

Shape-class collapsing: marks with same shape → same YOLO class.
Internal shape ids ("long_diamond") become display names ("long diamond")
only at export time; stored data is unchanged.
"""
from __future__ import annotations

import io
import json
import re
import uuid
import zipfile
import logging
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import fitz
from sqlalchemy.orm import Session

from models import LabelSession, Mark, Annotation
from storage import download_pdf, upload_export_zip, presign_export

logger = logging.getLogger(__name__)


def _format_class_name(shape: str) -> str:
    """Internal shape id → export display name. e.g. 'long_diamond' → 'long diamond'."""
    return shape.lower().replace("_", " ")


def _sanitize_stem(filename: str) -> str:
    """Strip the file extension and replace anything risky with an underscore
    so the stem is safe to use inside a zip path."""
    stem = Path(filename).stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    return stem or "session"


def build_export(session_id: str, db: Session) -> str:
    """Build YOLO zip, upload to S3, return presigned download URL."""

    session: LabelSession = db.get(LabelSession, session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")

    marks: list[Mark] = (
        db.query(Mark).filter(Mark.session_id == session_id).all()
    )
    annotations: list[Annotation] = (
        db.query(Annotation).filter(Annotation.session_id == session_id).all()
    )
    if not annotations:
        raise ValueError("No annotations to export")

    # Build shape → class_id mapping (sorted for determinism)
    unique_shapes  = sorted({m.shape for m in marks})
    class_names    = [_format_class_name(s) for s in unique_shapes]
    shape_to_class = {s: i for i, s in enumerate(unique_shapes)}
    mark_to_shape  = {m.id: m.shape for m in marks}

    # Group annotations by page
    by_page: dict[int, list[Annotation]] = defaultdict(list)
    for ann in annotations:
        by_page[ann.page_number].append(ann)

    pdf_bytes  = download_pdf(session.s3_key)
    zip_buffer = io.BytesIO()
    file_stem  = _sanitize_stem(session.filename)

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for page_num in sorted(by_page.keys()):
            stem = f"{file_stem}_p{page_num:03d}"

            # Render page at 150 DPI
            doc  = fitz.open(stream=pdf_bytes, filetype="pdf")
            page = doc[page_num - 1]
            mat  = fitz.Matrix(150 / 72, 150 / 72)
            pix  = page.get_pixmap(matrix=mat)
            png  = pix.tobytes("png")
            doc.close()

            zf.writestr(f"images/{stem}.png", png)

            lines = []
            for ann in by_page[page_num]:
                shape = mark_to_shape.get(ann.mark_id)
                if shape is None:
                    continue
                lines.append(
                    f"{shape_to_class[shape]} "
                    f"{ann.x_center:.6f} {ann.y_center:.6f} "
                    f"{ann.width:.6f} {ann.height:.6f}"
                )
            zf.writestr(f"labels/{stem}.txt", "\n".join(lines))

        # classes.txt — one class name per line (Label Studio convention)
        zf.writestr("classes.txt", "\n".join(class_names) + "\n")

        # notes.json — categories block matching Label Studio's format
        zf.writestr("notes.json", json.dumps({
            "categories": [
                {"id": i, "name": n} for i, n in enumerate(class_names)
            ],
            "info": {
                "year": datetime.utcnow().year,
                "version": "1.0",
                "contributor": "TakeOff Label",
            },
        }, indent=2))

    export_id = str(uuid.uuid4())
    upload_export_zip(export_id, zip_buffer.getvalue())

    logger.info("export ready: session=%s pages=%d annotations=%d classes=%d",
                session_id, len(by_page), len(annotations), len(unique_shapes))

    return presign_export(export_id)


def build_aggregate_export(db: Session) -> tuple[str, dict]:
    """Build one zip containing labels+images from every session marked `done`.

    Class IDs are unified across all sessions (sorted unique shapes), so the
    output is directly trainable. File names embed the source PDF stem and a
    short session id so different sessions sharing a PDF name don't collide:

        images/<pdf_stem>_<sid8>_p<NNN>.png
        labels/<pdf_stem>_<sid8>_p<NNN>.txt

    Returns (download_url, stats_dict).
    """
    done_sessions: list[LabelSession] = (
        db.query(LabelSession).filter(LabelSession.done == True).all()
    )
    if not done_sessions:
        raise ValueError(
            "No sessions marked done yet. Workers need to flip a session to "
            "'Done' before it's included in the aggregate export."
        )

    done_ids = [s.id for s in done_sessions]
    marks: list[Mark] = (
        db.query(Mark).filter(Mark.session_id.in_(done_ids)).all()
    )
    annotations: list[Annotation] = (
        db.query(Annotation).filter(Annotation.session_id.in_(done_ids)).all()
    )
    if not annotations:
        raise ValueError("Done sessions exist but contain no annotations.")

    unique_shapes  = sorted({m.shape for m in marks})
    class_names    = [_format_class_name(s) for s in unique_shapes]
    shape_to_class = {s: i for i, s in enumerate(unique_shapes)}
    mark_to_shape  = {m.id: m.shape for m in marks}

    # Group annotations by (session_id, page) — each becomes one image+label pair.
    by_session_page: dict[tuple[str, int], list[Annotation]] = defaultdict(list)
    for ann in annotations:
        by_session_page[(ann.session_id, ann.page_number)].append(ann)

    session_map = {s.id: s for s in done_sessions}
    pdf_cache: dict[str, bytes] = {}

    zip_buffer = io.BytesIO()
    pages_written = 0
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for (sid, page_num), anns in sorted(by_session_page.items()):
            session = session_map.get(sid)
            if not session:
                continue
            stem = f"{_sanitize_stem(session.filename)}_{sid[:8]}_p{page_num:03d}"

            # Cache PDF bytes per session so we don't re-fetch from S3 per page.
            if sid not in pdf_cache:
                pdf_cache[sid] = download_pdf(session.s3_key)
            doc  = fitz.open(stream=pdf_cache[sid], filetype="pdf")
            page = doc[page_num - 1]
            mat  = fitz.Matrix(150 / 72, 150 / 72)
            pix  = page.get_pixmap(matrix=mat)
            png  = pix.tobytes("png")
            doc.close()

            zf.writestr(f"images/{stem}.png", png)

            lines = []
            for ann in anns:
                shape = mark_to_shape.get(ann.mark_id)
                if shape is None:
                    continue
                lines.append(
                    f"{shape_to_class[shape]} "
                    f"{ann.x_center:.6f} {ann.y_center:.6f} "
                    f"{ann.width:.6f} {ann.height:.6f}"
                )
            zf.writestr(f"labels/{stem}.txt", "\n".join(lines))
            pages_written += 1

        zf.writestr("classes.txt", "\n".join(class_names) + "\n")
        zf.writestr("notes.json", json.dumps({
            "categories": [{"id": i, "name": n} for i, n in enumerate(class_names)],
            "info": {
                "year": datetime.utcnow().year,
                "version": "1.0",
                "contributor": "TakeOff Label",
            },
        }, indent=2))

    export_id = str(uuid.uuid4())
    upload_export_zip(export_id, zip_buffer.getvalue())
    stats = {
        "sessions":    len(done_sessions),
        "pages":       pages_written,
        "annotations": len(annotations),
        "classes":     len(unique_shapes),
    }
    logger.info("aggregate export ready: %s", stats)
    return presign_export(export_id), stats
