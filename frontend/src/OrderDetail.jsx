import { loadOrders } from "./orders.js";
import { Link } from "./router.jsx";
import StatusBadge from "./StatusBadge.jsx";
import { useOrderEvents } from "./useOrderEvents.js";

/**
 * One order, followed live over SSE. The stream opens when this page mounts
 * and closes when the user leaves it, or when the order finishes.
 */
export default function OrderDetail({ orderId }) {
  const { history, connection, streamedBy } = useOrderEvents(orderId);
  // Known if the order was placed from this browser; not for a pasted link.
  const placed = loadOrders().find((o) => o.orderId === orderId);
  const current = history.at(-1)?.status ?? "…";
  const since = placed?.placedAt ?? history[0]?.at;

  return (
    <>
      <p>
        <Link to="/">← All orders</Link>
      </p>
      <h1 style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        Order {orderId} <StatusBadge status={current} />
      </h1>
      <p style={{ fontSize: "0.85rem", color: "#666" }}>
        {placed && <>placed via {placed.handledBy} · </>}
        stream: {connection}
        {streamedBy && <> via {streamedBy}</>}
      </p>
      <ol style={{ paddingLeft: "1.25rem" }}>
        {history.map(({ status, at, source, publishedBy }) => (
          <li key={status + at.getTime()}>
            {status}{" "}
            <span style={{ color: "#888" }}>
              +{((at - since) / 1000).toFixed(1)}s ·{" "}
              {source === "pubsub" ? `published by ${publishedBy}` : "snapshot"}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
