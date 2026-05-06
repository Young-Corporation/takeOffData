// useCollabWS.js — Stub: real-time collaboration requires a server.
// Returns a no-op send() so all call sites work unchanged.
export function useCollabWS(_sessionId, _user, _handlers) {
  return { send: () => {} };
}
