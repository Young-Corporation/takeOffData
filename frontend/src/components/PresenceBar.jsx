// PresenceBar.jsx — Shows who's currently active in this label session

export default function PresenceBar({ users = [], currentUser }) {
  if (users.length === 0) return null;

  return (
    <div style={styles.bar}>
      <span style={styles.label}>Active:</span>
      {users.map((u) => (
        <div key={u} style={styles.chip} title={u}>
          <div
            style={{
              ...styles.avatar,
              background: stringToColor(u),
            }}
          >
            {u.charAt(0).toUpperCase()}
          </div>
          <span style={styles.name}>
            {u === currentUser ? "You" : u}
          </span>
        </div>
      ))}
    </div>
  );
}

// Deterministic color from a username string
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

const styles = {
  bar: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    padding:    "4px 12px",
    background: "#12122a",
    borderBottom: "1px solid #2a2a4a",
    flexWrap:   "wrap",
  },
  label: {
    fontSize:  11,
    color:     "#555",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  chip: {
    display:    "flex",
    alignItems: "center",
    gap:        5,
  },
  avatar: {
    width:        22,
    height:       22,
    borderRadius: "50%",
    display:      "flex",
    alignItems:   "center",
    justifyContent: "center",
    fontSize:     11,
    fontWeight:   700,
    color:        "#fff",
    flexShrink:   0,
  },
  name: {
    fontSize: 12,
    color:    "#aaa",
  },
};
