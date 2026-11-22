import { useCallback, useEffect, useState } from "react";
import { addOrder, loadOrders, removeOrders } from "./orders.js";
import { Link, navigate } from "./router.jsx";
import StatusBadge from "./StatusBadge.jsx";

/** Current status of each order, fetched once: null if it no longer exists. */
async function fetchStatuses(orders) {
  const entries = await Promise.all(
    orders.map(async ({ orderId }) => {
      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (res.status === 404) return [orderId, null];
        if (!res.ok) return [orderId, "unknown"];
        return [orderId, (await res.json()).status];
      } catch {
        return [orderId, "unknown"]; // backend unreachable
      }
    })
  );
  return Object.fromEntries(entries);
}

/**
 * The user's orders with their status at the time the page loaded. No SSE
 * here: live updates only stream on an order's detail page, so a browser holds
 * at most one stream per tab however many orders it has.
 */
export default function OrderList() {
  const [orders, setOrders] = useState(loadOrders);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await fetchStatuses(loadOrders());
    // Orders expire on the backend after 1h; forget those.
    removeOrders(Object.keys(result).filter((id) => result[id] === null));
    setOrders(loadOrders());
    setStatuses(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const placeOrder = async () => {
    setError(null);
    try {
      const res = await fetch("/api/orders", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { order_id, handled_by } = await res.json();
      addOrder({ orderId: order_id, placedAt: Date.now(), handledBy: handled_by });
      navigate(`/orders/${order_id}`);
    } catch (e) {
      setError(`Could not place order: ${e.message}`);
    }
  };

  return (
    <>
      <h1>Orders</h1>
      <p style={{ color: "#555" }}>
        Statuses here are loaded once. Open an order to follow it live: only the detail page opens
        an SSE stream.
      </p>
      <button onClick={placeOrder}>Place order</button>{" "}
      <button onClick={refresh} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh"}
      </button>
      {error && <p style={{ color: "#e53935" }}>{error}</p>}
      {orders.length === 0 ? (
        <p style={{ color: "#888" }}>No orders yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
          {orders.map(({ orderId, placedAt, handledBy }) => (
            <li
              key={orderId}
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: "0.6rem 1rem",
                marginBottom: "0.5rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>
                <Link to={`/orders/${orderId}`}>Order {orderId}</Link>
                <span style={{ fontSize: "0.8rem", color: "#666" }}>
                  {" "}
                  · {new Date(placedAt).toLocaleTimeString()} via {handledBy}
                </span>
              </span>
              <StatusBadge status={statuses[orderId] ?? "…"} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
