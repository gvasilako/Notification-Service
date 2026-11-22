const STATUS_COLORS = {
  pending: "#9e9e9e",
  processing: "#1e88e5",
  completed: "#43a047",
  failed: "#e53935",
};

export default function StatusBadge({ status }) {
  return (
    <span
      style={{
        background: STATUS_COLORS[status] ?? "#bbb",
        color: "white",
        borderRadius: 12,
        padding: "0.1rem 0.6rem",
        fontSize: "0.85rem",
      }}
    >
      {status}
    </span>
  );
}
