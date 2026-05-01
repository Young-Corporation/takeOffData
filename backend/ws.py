"""
ws.py — WebSocket room manager for real-time collaborative annotation.
One room per session. Broadcasts annotation/mark mutations to all connected clients.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter()


class RoomManager:
    def __init__(self):
        self._rooms: dict[str, set[tuple[WebSocket, str]]] = defaultdict(set)

    async def join(self, session_id: str, ws: WebSocket, user: str):
        self._rooms[session_id].add((ws, user))
        await self._broadcast(session_id, {
            "type": "presence:join",
            "payload": {"user": user},
        }, exclude=ws)

    async def leave(self, session_id: str, ws: WebSocket, user: str):
        self._rooms[session_id].discard((ws, user))
        if not self._rooms[session_id]:
            del self._rooms[session_id]
        await self._broadcast(session_id, {
            "type": "presence:leave",
            "payload": {"user": user},
        })

    async def broadcast(self, session_id: str, event: dict[str, Any],
                        exclude: WebSocket | None = None):
        await self._broadcast(session_id, event, exclude)

    def active_users(self, session_id: str) -> list[str]:
        return [u for _, u in self._rooms.get(session_id, set())]

    async def _broadcast(self, session_id: str, event: dict[str, Any],
                         exclude: WebSocket | None = None):
        dead = set()
        for ws, user in list(self._rooms.get(session_id, set())):
            if ws is exclude:
                continue
            try:
                await ws.send_text(json.dumps(event))
            except Exception:
                dead.add((ws, user))
        for pair in dead:
            self._rooms[session_id].discard(pair)


manager = RoomManager()


@router.websocket("/ws/label/{session_id}")
async def label_ws(ws: WebSocket, session_id: str):
    await ws.accept()
    user = "unknown"
    try:
        raw  = await ws.receive_text()
        msg  = json.loads(raw)
        if msg.get("type") == "identify":
            user = msg["payload"].get("user", "unknown")

        await manager.join(session_id, ws, user)

        # Send current presence list to the new joiner
        await ws.send_text(json.dumps({
            "type": "presence:list",
            "payload": {"users": manager.active_users(session_id)},
        }))

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("type") in (
                "annotation:created",       "annotation:deleted",
                "mark:created",             "mark:deleted",
                "session:updated",
                "page-exclusion:created",   "page-exclusion:deleted",
                "region-exclusion:created", "region-exclusion:deleted",
            ):
                await manager.broadcast(session_id, msg, exclude=ws)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("ws error session=%s user=%s: %s", session_id, user, e)
    finally:
        await manager.leave(session_id, ws, user)
