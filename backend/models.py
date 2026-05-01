"""
models.py — All SQLAlchemy models for TakeOff Label.
Tables: Project, LabelSession, Mark, Annotation, PageExclusion, RegionExclusion.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from sqlalchemy import String, Integer, Float, DateTime, ForeignKey, JSON, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class Project(Base):
    """Top-level container — one project holds many PDF sessions."""
    __tablename__ = "projects"

    id:         Mapped[str]      = mapped_column(String, primary_key=True,
                                       default=lambda: str(uuid.uuid4()))
    name:       Mapped[str]      = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    sessions: Mapped[list["LabelSession"]] = relationship(back_populates="project",
                                                cascade="all, delete")


class LabelSession(Base):
    """One session = one uploaded PDF stored in S3."""
    __tablename__ = "label_sessions"

    id:           Mapped[str]       = mapped_column(String, primary_key=True,
                                          default=lambda: str(uuid.uuid4()))
    project_id:   Mapped[str]       = mapped_column(ForeignKey("projects.id",
                                          ondelete="CASCADE"))
    filename:     Mapped[str]       = mapped_column(String, nullable=False)
    s3_key:       Mapped[str]       = mapped_column(String, nullable=False)
    page_count:   Mapped[int]       = mapped_column(Integer, nullable=False)
    page_s3_keys: Mapped[list|None] = mapped_column(JSON, default=list)
    created_at:   Mapped[datetime]  = mapped_column(DateTime, default=datetime.utcnow)
    # Worker marks a session "done" when their labeling is finished. Admin
    # aggregate export only includes done sessions, so workers control what
    # ships to the training set.
    done:         Mapped[bool]            = mapped_column(default=False, nullable=False)
    done_at:      Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="sessions")

    marks:       Mapped[list["Mark"]]       = relationship(back_populates="session",
                                                 cascade="all, delete")
    annotations: Mapped[list["Annotation"]] = relationship(back_populates="session",
                                                 cascade="all, delete")


class Mark(Base):
    """
    A named symbol type within a session.
    shape is the YOLO class key — multiple marks can share one shape,
    collapsing to one YOLO class on export.
    """
    __tablename__ = "label_marks"

    id:         Mapped[str]      = mapped_column(String, primary_key=True,
                                       default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str]      = mapped_column(ForeignKey("label_sessions.id",
                                       ondelete="CASCADE"))
    name:       Mapped[str]      = mapped_column(String, nullable=False)
    shape:      Mapped[str]      = mapped_column(String, nullable=False)
    color:      Mapped[str]      = mapped_column(String, default="#3b82f6")
    created_by: Mapped[str|None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session:     Mapped["LabelSession"]     = relationship(back_populates="marks")
    annotations: Mapped[list["Annotation"]] = relationship(back_populates="mark",
                                                 cascade="all, delete")


class Annotation(Base):
    """
    One bounding box around one symbol instance on one page.
    Coordinates normalized 0–1, YOLO center format.
    """
    __tablename__ = "label_annotations"

    id:          Mapped[str]   = mapped_column(String, primary_key=True,
                                      default=lambda: str(uuid.uuid4()))
    session_id:  Mapped[str]   = mapped_column(ForeignKey("label_sessions.id",
                                      ondelete="CASCADE"))
    mark_id:     Mapped[str]   = mapped_column(ForeignKey("label_marks.id",
                                      ondelete="CASCADE"))
    page_number: Mapped[int]   = mapped_column(Integer, nullable=False, index=True)
    x_center:    Mapped[float] = mapped_column(Float, nullable=False)
    y_center:    Mapped[float] = mapped_column(Float, nullable=False)
    width:       Mapped[float] = mapped_column(Float, nullable=False)
    height:      Mapped[float] = mapped_column(Float, nullable=False)
    created_by:  Mapped[str|None] = mapped_column(String, nullable=True)
    created_at:  Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped["LabelSession"] = relationship(back_populates="annotations")
    mark:    Mapped["Mark"]         = relationship(back_populates="annotations")


class PageExclusion(Base):
    """A whole page flagged to be skipped at YOLO export time.

    Annotations on excluded pages are still kept in the DB — the worker is
    explicitly told to keep marking everything so we retain shape/location
    data. Only the export pipeline filters these out.
    """
    __tablename__ = "label_page_exclusions"

    id:          Mapped[str]      = mapped_column(String, primary_key=True,
                                       default=lambda: str(uuid.uuid4()))
    session_id:  Mapped[str]      = mapped_column(ForeignKey("label_sessions.id",
                                       ondelete="CASCADE"), index=True)
    page_number: Mapped[int]      = mapped_column(Integer, nullable=False, index=True)
    created_by:  Mapped[str|None] = mapped_column(String, nullable=True)
    created_at:  Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class RegionExclusion(Base):
    """A rectangular region on one page that should be cropped out of the
    YOLO export. Coordinates normalized 0–1 (top-left + width/height), same
    convention used elsewhere except annotations use center-format.

    At export time the region is masked white on the rendered PNG, and any
    annotation whose center falls inside is dropped from the label file.
    The DB row for the annotation is untouched.
    """
    __tablename__ = "label_region_exclusions"

    id:          Mapped[str]      = mapped_column(String, primary_key=True,
                                       default=lambda: str(uuid.uuid4()))
    session_id:  Mapped[str]      = mapped_column(ForeignKey("label_sessions.id",
                                       ondelete="CASCADE"), index=True)
    page_number: Mapped[int]      = mapped_column(Integer, nullable=False, index=True)
    x:           Mapped[float]    = mapped_column(Float, nullable=False)
    y:           Mapped[float]    = mapped_column(Float, nullable=False)
    width:       Mapped[float]    = mapped_column(Float, nullable=False)
    height:      Mapped[float]    = mapped_column(Float, nullable=False)
    created_by:  Mapped[str|None] = mapped_column(String, nullable=True)
    created_at:  Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
