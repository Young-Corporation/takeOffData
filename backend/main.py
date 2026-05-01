"""
main.py — TakeOff Label entry point.
"""
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text

from config import settings
from database import Base, engine
from routes import router
from ws import router as ws_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create all tables on startup (no migrations needed for fresh project)
Base.metadata.create_all(bind=engine)


def _migrate_label_sessions():
    """Idempotent column-adds on existing databases. `Base.metadata.create_all`
    only creates new tables — it doesn't add columns, so we ALTER TABLE here."""
    insp = inspect(engine)
    try:
        cols = {c["name"] for c in insp.get_columns("label_sessions")}
    except Exception:
        return
    stmts = []
    if "done" not in cols:
        stmts.append("ALTER TABLE label_sessions ADD COLUMN done INTEGER NOT NULL DEFAULT 0")
    if "done_at" not in cols:
        stmts.append("ALTER TABLE label_sessions ADD COLUMN done_at TIMESTAMP")
    if not stmts:
        return
    with engine.begin() as conn:
        for sql in stmts:
            logger.info("migration: %s", sql)
            conn.execute(text(sql))


_migrate_label_sessions()

app = FastAPI(title="TakeOff Label", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/label")
app.include_router(ws_router)


@app.get("/health")
def health():
    return {"status": "ok"}
