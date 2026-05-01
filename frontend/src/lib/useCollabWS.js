// useCollabWS.js — WebSocket hook for collaborative labeling
// Connects to /ws/label/{sessionId}, handles reconnect, dispatches events

import { useEffect, useRef, useCallback } from "react";

const RECONNECT_DELAY_MS = 2500;

/**
 * useCollabWS(sessionId, user, handlers)
 *
 * handlers: {
 *   onAnnotationCreated: (annotation) => void,
 *   onAnnotationDeleted: ({ id }) => void,
 *   onMarkCreated:       (mark) => void,
 *   onMarkDeleted:       ({ id }) => void,
 *   onPresenceJoin:      ({ user }) => void,
 *   onPresenceLeave:     ({ user }) => void,
 *   onPresenceList:      ({ users }) => void,
 * }
 *
 * Returns: { send }  — send(type, payload) for direct WS messages
 */
export function useCollabWS(sessionId, user, handlers) {
  const wsRef        = useRef(null);
  const handlersRef  = useRef(handlers);
  const reconnectRef = useRef(null);
  const mountedRef   = useRef(true);

  // Keep handlers ref fresh without re-connecting on every render
  handlersRef.current = handlers;

  const connect = useCallback(() => {
    if (!sessionId || !mountedRef.current) return;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/label/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Identify ourselves immediately after connect
      ws.send(JSON.stringify({ type: "identify", payload: { user } }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      const h = handlersRef.current;
      switch (msg.type) {
        case "annotation:created":       h.onAnnotationCreated?.(msg.payload);       break;
        case "annotation:deleted":       h.onAnnotationDeleted?.(msg.payload);       break;
        case "mark:created":             h.onMarkCreated?.(msg.payload);             break;
        case "mark:updated":             h.onMarkUpdated?.(msg.payload);             break;
        case "mark:deleted":             h.onMarkDeleted?.(msg.payload);             break;
        case "session:updated":          h.onSessionUpdated?.(msg.payload);          break;
        case "page-exclusion:created":   h.onPageExclusionCreated?.(msg.payload);    break;
        case "page-exclusion:deleted":   h.onPageExclusionDeleted?.(msg.payload);    break;
        case "region-exclusion:created": h.onRegionExclusionCreated?.(msg.payload);  break;
        case "region-exclusion:deleted": h.onRegionExclusionDeleted?.(msg.payload);  break;
        case "presence:join":            h.onPresenceJoin?.(msg.payload);            break;
        case "presence:leave":           h.onPresenceLeave?.(msg.payload);           break;
        case "presence:list":            h.onPresenceList?.(msg.payload);            break;
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => ws.close();
  }, [sessionId, user]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((type, payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  return { send };
}
