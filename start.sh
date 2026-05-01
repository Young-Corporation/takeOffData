#!/bin/bash

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── .env check ────────────────────────────────────────────────────────────────
if [ ! -f "$ROOT/backend/.env" ]; then
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  echo ""
  echo "  .env created from .env.example"
  echo "  Fill in your AWS credentials in backend/.env before continuing."
  echo ""
  exit 1
fi

# Tracked PIDs — populated as we launch each server. Cleanup tolerates them
# being empty if a launch fails before this line.
BACKEND_PID=
FRONTEND_PID=

# Cleanup blocks until all children are actually gone. Without this, the
# script's `exit 0` returns to the shell prompt while uvicorn/vite are still
# in graceful-shutdown — their output keeps streaming into your terminal and
# it *looks* like the script is still running, so you press Ctrl+C again.
cleanup() {
  # Disarm so a hurried second Ctrl+C can't re-enter mid-cleanup.
  trap - SIGINT SIGTERM EXIT

  echo ""
  echo "Shutting down..."

  [ -n "$BACKEND_PID"  ] && kill -TERM "$BACKEND_PID"  2>/dev/null
  [ -n "$FRONTEND_PID" ] && kill -TERM "$FRONTEND_PID" 2>/dev/null

  # Poll up to 5s for graceful shutdown (uvicorn + vite usually need 1–3s).
  for _ in $(seq 1 20); do
    alive=0
    [ -n "$BACKEND_PID"  ] && kill -0 "$BACKEND_PID"  2>/dev/null && alive=1
    [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null && alive=1
    [ "$alive" = 0 ] && break
    sleep 0.25
  done

  # Anything still alive — escalate. Catches detached workers/grandchildren.
  kill -KILL "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Backend ───────────────────────────────────────────────────────────────────
echo "→ Installing backend dependencies..."
cd "$ROOT/backend"
pip install -r requirements.txt -q

echo "→ Starting backend on http://0.0.0.0:8000"
uvicorn main:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# ── Frontend ──────────────────────────────────────────────────────────────────
echo "→ Installing frontend dependencies..."
cd "$ROOT/frontend"
npm install --silent

echo "→ Starting frontend on http://0.0.0.0:5173"
npm run dev -- --host 0.0.0.0 &
FRONTEND_PID=$!

# Pick the first non-loopback IPv4 — gives a copy-pasteable LAN URL for teammates.
# `ip route get` is the most portable on Arch (which doesn't ship `hostname` by default).
LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
[ -z "$LAN_IP" ] && LAN_IP=$(ip -o -4 addr show scope global 2>/dev/null | awk 'NR==1 {split($4,a,"/"); print a[1]}')

echo ""
echo "  Both servers running. Press Ctrl+C to stop."
echo "    local:  http://localhost:5173"
[ -n "$LAN_IP" ] && echo "    LAN:    http://$LAN_IP:5173"
echo ""

wait
