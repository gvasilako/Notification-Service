import { useEffect, useState } from "react";

const TERMINAL = new Set(["completed", "failed"]);
const WATCHDOG_MS = 35_000; // server sends a ping every 15s; allow two misses
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Subscribe to an order's status stream.
 *
 * EventSource reconnects by itself only after *network* errors. If the server
 * answers with an HTTP error (e.g. nginx 502/504 while the backend is down) it
 * gives up for good (readyState CLOSED), so we reconnect ourselves with
 * exponential backoff + jitter. A watchdog on the server's ping events catches
 * connections that died silently.
 *
 * Returns {
 *   history: [{ status, at, source, publishedBy }],
 *   connection: string,
 *   streamedBy: replica serving the current stream,
 * }.
 */
export function useOrderEvents(orderId) {
  const [history, setHistory] = useState([]);
  const [connection, setConnection] = useState("connecting");
  const [streamedBy, setStreamedBy] = useState(null);

  useEffect(() => {
    let es = null;
    let watchdog = null;
    let retryTimer = null;
    let attempt = 0;
    let finished = false;

    const closeStream = () => {
      clearTimeout(watchdog);
      es?.close();
      es = null;
    };

    const finish = (state) => {
      finished = true;
      closeStream();
      setConnection(state);
    };

    const scheduleReconnect = async () => {
      closeStream();
      // A 404 also ends up here (EventSource can't tell us the status code),
      // so check once that the order still exists before retrying forever.
      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (res.status === 404) return finish("order not found");
      } catch {
        // backend unreachable: fall through and retry
      }
      if (finished) return;
      const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      const delay = cap / 2 + Math.random() * (cap / 2); // jitter spreads out reconnect storms
      attempt += 1;
      setConnection(`reconnecting in ${(delay / 1000).toFixed(1)}s`);
      retryTimer = setTimeout(connect, delay);
    };

    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        setConnection("no heartbeat, reconnecting");
        scheduleReconnect();
      }, WATCHDOG_MS);
    };

    const connect = () => {
      if (finished) return;
      setConnection("connecting");
      es = new EventSource(`/api/orders/${orderId}/events`);

      es.onopen = () => {
        attempt = 0;
        setConnection("live");
        resetWatchdog();
      };

      es.addEventListener("ping", resetWatchdog);

      es.addEventListener("status", (e) => {
        resetWatchdog();
        const { status, source, published_by, streamed_by } = JSON.parse(e.data);
        setStreamedBy(streamed_by);
        // The snapshot sent on (re)connect may repeat the last status: that's
        // expected, since the server sends state, not deltas.
        setHistory((h) =>
          h.at(-1)?.status === status
            ? h
            : [...h, { status, at: new Date(), source, publishedBy: published_by }]
        );
        // Close before the server does, or EventSource would reconnect.
        if (TERMINAL.has(status)) finish("done");
      });

      es.onerror = () => {
        if (finished || !es) return;
        if (es.readyState === EventSource.CLOSED) {
          scheduleReconnect(); // browser gave up: HTTP error or bad content type
        } else {
          setConnection("reconnecting (browser)"); // browser retries after `retry:`
        }
      };
    };

    connect();
    return () => {
      finished = true;
      clearTimeout(retryTimer);
      closeStream();
    };
  }, [orderId]);

  return { history, connection, streamedBy };
}
