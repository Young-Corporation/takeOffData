// MarkManager.jsx — Left sidebar for creating/managing mark types and viewing counts
// The estimator's "what am I counting" panel — also the YOLO class definition panel

import { useState } from "react";
import { createMark, updateMark, deleteMark } from "../lib/labelApi";

const SHAPES = [
  { id: "hexagon",      label: "Hexagon" },
  { id: "circle",       label: "Circle" },
  { id: "long_diamond", label: "Long Diamond" },
  { id: "diamond",      label: "Diamond" },
  { id: "long_hexagon", label: "Long Hexagon" },
  { id: "square",       label: "Square" },
  { id: "rectangle",    label: "Rectangle" },
];

const PALETTE = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6",
];

export default function MarkManager({
  sessionId,
  marks,          // [{ id, name, shape, color }]
  counts,         // [{ mark_id, count }]
  activeMark,     // id of currently selected mark
  onMarkSelect,
  onMarkCreated,
  onMarkUpdated,
  onMarkDeleted,
  user,
}) {
  const [name,    setName]    = useState("");
  const [shape,   setShape]   = useState(SHAPES[0].id);
  const [color,   setColor]   = useState(PALETTE[0]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  // Inline-edit state — null when nothing is being edited.
  const [editingId,    setEditingId]    = useState(null);
  const [editName,     setEditName]     = useState("");
  const [editShape,    setEditShape]    = useState("");

  const startEdit = (mark) => {
    setEditingId(mark.id);
    setEditName(mark.name);
    setEditShape(mark.shape);
    setError(null);
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (markId) => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    try {
      const updated = await updateMark(sessionId, markId, {
        name: trimmed,
        shape: editShape,
      });
      onMarkUpdated?.(updated);
      setEditingId(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const countFor = (markId) =>
    counts?.find((c) => c.mark_id === markId)?.count ?? 0;

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true); setError(null);
    try {
      const mark = await createMark(sessionId, { name: name.trim(), shape, color, user });
      onMarkCreated(mark);
      setName("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (markId) => {
    try {
      await deleteMark(sessionId, markId);
      onMarkDeleted(markId);
    } catch (e) {
      console.error("Delete mark failed:", e);
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>Marks</div>

      {/* Mark list */}
      <div style={styles.list}>
        {marks.length === 0 && (
          <div style={styles.empty}>No marks yet — create one below</div>
        )}
        {marks.map((mark) => {
          const isEditing = editingId === mark.id;
          return (
            <div
              key={mark.id}
              style={{
                ...styles.markRow,
                background: activeMark === mark.id ? "rgba(255,255,255,0.08)" : "transparent",
                borderLeft: `3px solid ${mark.color}`,
                cursor: isEditing ? "default" : "pointer",
              }}
              onClick={() => { if (!isEditing) onMarkSelect(mark.id); }}
            >
              {isEditing ? (
                <div style={styles.editForm} onClick={(e) => e.stopPropagation()}>
                  <input
                    style={styles.input}
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")  saveEdit(mark.id);
                      if (e.key === "Escape") cancelEdit();
                    }}
                  />
                  <select
                    style={styles.select}
                    value={editShape}
                    onChange={(e) => setEditShape(e.target.value)}
                  >
                    {SHAPES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  <div style={styles.editActions}>
                    <button
                      style={{ ...styles.iconBtn, color: "#22c55e" }}
                      onClick={() => saveEdit(mark.id)}
                      title="Save (Enter)"
                    >✓</button>
                    <button
                      style={styles.iconBtn}
                      onClick={cancelEdit}
                      title="Cancel (Esc)"
                    >✗</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={styles.markInfo}>
                    <span style={styles.markName}>{mark.name}</span>
                    <span style={styles.markShape}>{mark.shape}</span>
                  </div>
                  <div style={styles.markRight}>
                    <span style={{ ...styles.count, background: mark.color }}>
                      {countFor(mark.id)}
                    </span>
                    <button
                      style={styles.iconBtn}
                      onClick={(e) => { e.stopPropagation(); startEdit(mark); }}
                      title="Edit mark"
                    >✎</button>
                    <button
                      style={styles.iconBtn}
                      onClick={(e) => { e.stopPropagation(); handleDelete(mark.id); }}
                      title="Delete mark"
                    >×</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Create new mark */}
      <div style={styles.createSection}>
        <div style={styles.sectionLabel}>New Mark</div>

        <input
          style={styles.input}
          placeholder="Name (e.g. S1)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />

        <select
          style={styles.select}
          value={shape}
          onChange={(e) => setShape(e.target.value)}
        >
          {SHAPES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

        <div style={styles.palette}>
          {PALETTE.map((c) => (
            <div
              key={c}
              style={{
                ...styles.swatch,
                background: c,
                outline: color === c ? "2px solid #fff" : "none",
              }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <button
          style={{ ...styles.addBtn, opacity: loading || !name.trim() ? 0.5 : 1 }}
          onClick={handleCreate}
          disabled={loading || !name.trim()}
        >
          {loading ? "Adding…" : "+ Add Mark"}
        </button>
      </div>
    </div>
  );
}

const styles = {
  panel: {
    width: 220,
    minWidth: 220,
    background: "#1a1a2e",
    borderRight: "1px solid #2a2a4a",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    color: "#ccc",
    userSelect: "none",
  },
  header: {
    padding: "12px 14px 10px",
    fontWeight: 600,
    fontSize: 14,
    borderBottom: "1px solid #2a2a4a",
    color: "#fff",
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "6px 0",
  },
  empty: {
    padding: "12px 14px",
    color: "#555",
    fontSize: 12,
  },
  markRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "7px 10px 7px 12px",
    cursor: "pointer",
    borderRadius: 4,
    margin: "1px 6px",
    transition: "background 0.1s",
  },
  markInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    overflow: "hidden",
  },
  markName: {
    fontWeight: 500,
    color: "#e8e8e8",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  markShape: {
    fontSize: 11,
    color: "#666",
    textTransform: "capitalize",
  },
  markRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  count: {
    borderRadius: 10,
    padding: "1px 7px",
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    minWidth: 22,
    textAlign: "center",
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    padding: "2px 4px",
  },
  editForm: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  editActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 4,
  },
  createSection: {
    borderTop: "1px solid #2a2a4a",
    padding: "12px 12px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  input: {
    background: "#111122",
    border: "1px solid #333",
    borderRadius: 4,
    padding: "6px 8px",
    color: "#ddd",
    fontSize: 12,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  select: {
    background: "#111122",
    border: "1px solid #333",
    borderRadius: 4,
    padding: "6px 8px",
    color: "#ddd",
    fontSize: 12,
    width: "100%",
    cursor: "pointer",
  },
  palette: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 3,
    cursor: "pointer",
    outlineOffset: 2,
  },
  error: {
    color: "#f87171",
    fontSize: 11,
  },
  addBtn: {
    background: "#3b82f6",
    border: "none",
    borderRadius: 4,
    color: "#fff",
    fontWeight: 600,
    padding: "7px 0",
    cursor: "pointer",
    fontSize: 13,
    width: "100%",
  },
};
