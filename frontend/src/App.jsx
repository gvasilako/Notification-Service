import { useState } from "react";
import { useOrderEvents } from "./useOrderEvents.js";

const STATUS_COLORS = {
  pending: "#9e9e9e",
  processing: "#1e88e5",
  completed: "#43a047",
  failed: "#e53935",
};

function OrderCard({ orderId, placedAt }) {
  const { history, connection } = useOrderEvents(orderId);
  const current = history.at(-1)?.status ?? "…";

  return (
    <li style={{ border: "1px solid #ddd", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Order {orderId}</strong>
        <span
          style={{
            background: STATUS_COLORS[current] ?? "#bbb",
            color: "white",
            borderRadius: 12,
            padding: "0.1rem 0.6rem",
            fontSize: "0.85rem",
          }}
        >
          {current}
        </span>
      </div>
      <div style={{ fontSize: "0.8rem", color: "#666", margin: "0.25rem 0 0.5rem" }}>
        stream: {connection}
      </div>
      <ol style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.9rem" }}>
        {history.map(({ status, at }) => (
          <li key={status + at.getTime()}>
            {status}{" "}
            <span style={{ color: "#888" }}>+{((at - placedAt) / 1000).toFixed(1)}s</span>
          </li>
        ))}
      </ol>
    </li>
  );
}

export default function App() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState(null);

  const placeOrder = async () => {
    setError(null);
    try {
      const res = await fetch("/api/orders", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { order_id } = await res.json();
      setOrders((o) => [{ orderId: order_id, placedAt: new Date() }, ...o]);
    } catch (e) {
      setError(`Could not place order: ${e.message}`);
    }
  };

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 600, margin: "2rem auto" }}>
      <h1>Orders</h1>
      <p style={{ color: "#555" }}>
        Each order gets its own SSE stream. No polling: status changes are pushed from Redis Pub/Sub.
      </p>
      <button onClick={placeOrder}>Place order</button>
      {error && <p style={{ color: "#e53935" }}>{error}</p>}
      <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
        {orders.map(({ orderId, placedAt }) => (
          <OrderCard key={orderId} orderId={orderId} placedAt={placedAt} />
        ))}
      </ul>
    </main>
  );
}
