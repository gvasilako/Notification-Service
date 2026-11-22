# Notification Service: order status over SSE with Redis Pub/Sub

## Why this exists

I've run into the same pattern on several professional projects. A user places
an order in the UI. The backend acknowledges it straight away and hands the real
work to background workers. The workers process it and write the new status to a
database. Meanwhile the UI **polls** the backend, "is it done yet?", every few
seconds, until the status lets the user move on, for example to review what the
order produced.

Polling works, but it's wasteful and slow. Most requests return "no change",
every client adds load even when nothing is happening, and the user still waits
up to a full polling interval after the work has actually finished.

This project tries an alternative: **let the backend push the change**. The UI
opens a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream for its order and waits. When a worker finishes a step, it publishes to a
Redis channel for that order. The API process subscribed to that channel forwards
the update to the browser at once.

It's also a hands-on way for me to learn Redis: Pub/Sub, transactions, keys with
expiry, and how all of it behaves when connections drop.

```
Browser ──POST /api/orders──────────► API ──► background task (the "worker")
   ▲                                              │ 1. SET order:{id}:status
   │                                              │ 2. PUBLISH order:{id}
   └──SSE /api/orders/{id}/events◄── API ◄── Redis Pub/Sub
```

## Scope: what is real and what is mocked

The goal is a **production-ready SSE path**. Everything around it is
deliberately minimal:

| Part | Here | In a real system |
|---|---|---|
| SSE endpoint, subscription handling, reconnects, multiple replicas | **Built to production standard** | Same |
| Order "database" | A Redis key per order, `order:{id}:status`, with a 1h TTL | Postgres or similar |
| Workers | A FastAPI `BackgroundTasks` function that sleeps and changes the status | Separate workers with a durable queue |
| UI | A small React app: order list and order detail page | Your app |

One consequence of the mocked worker: if an API process dies, the background
task running inside it dies too, and that order stays stuck. The SSE side copes
with the crash; the lost work is the known limit of the mock.

## How the SSE path is made reliable

**Subscribe, then snapshot, then stream.** Redis Pub/Sub keeps nothing: a
message published while nobody is subscribed is gone. So on every (re)connect
the endpoint:
1. subscribes to `order:{id}` and **waits until Redis confirms** the subscription,
2. reads the current status and sends it as the first event,
3. streams live updates.

Nothing published after step 1 can be missed, and anything published before it
is covered by the snapshot.

**Send state, not deltas.** Each event carries the full current status.
Duplicates are harmless and reconnects need no replay: a fresh snapshot is
always correct.

**Write, then publish, atomically.** The worker sets the status key and
publishes in one Redis transaction (`MULTI/EXEC`), so the stored status and the
notification can't disagree.

**Heartbeats the browser can see.** When idle, the server sends `event: ping`
every 15s. It stops proxies from closing the connection, and because it's a
real event (unlike a `: comment` line, which JavaScript never sees) the client
runs a watchdog: no event for 35s means reconnect.

**Reconnects that don't give up.** `EventSource` reconnects by itself after
network errors, but gives up for good on an HTTP error, such as a 504 from
nginx while a backend is down. The client (`useOrderEvents`) takes over in that
case: exponential backoff with jitter, and a check for a deleted order (404).
The stream is closed on `completed` or `failed`, so finished orders don't
reconnect forever.

**Stream only what the user is looking at.** The order list loads each order's
status once, with a plain request. Only the order detail page opens an SSE
stream, and leaving the page closes it. A tab therefore holds at most one
stream. That matters because over HTTP/1.1 a browser allows about 6
connections per host, shared by all its tabs: a stream per order in a list
would use them up after a few open orders, and every other request, even the
next page load, would wait behind them.

**Proxy and deploy settings.** nginx doesn't buffer the stream, keeps it open
for up to 1h, and gives up connecting to a dead replica after 2s instead of
60s. uvicorn waits at most 5s for open streams on shutdown, so a deploy isn't
blocked by long-lived connections; cut-off clients reconnect to another
replica.

## The Redis optimization: one subscriber per process

The simple approach gives every SSE client its own Redis Pub/Sub connection. A
connection in subscribe mode can't be shared, so 10,000 open browsers would mean
10,000 Redis connections, which is Redis's default limit, almost all of them
idle.

Instead, each API process holds **one** Pub/Sub connection and delivers
messages locally (`backend/app/broker.py`):

```
Browser A ── mailbox ┐
Browser B ── mailbox ┼── registry ── 1 reader task ── 1 Redis connection
Browser C ── mailbox ┘   { "order:42": {A, B}, "order:77": {C} }
```

- **Reference-counted subscriptions:** `SUBSCRIBE` when the first local listener
  for an order arrives, `UNSUBSCRIBE` when the last one leaves.
- **One reader task** fans each message out to the matching mailboxes (one
  `asyncio.Queue` per client).
- **Latest-only mailboxes:** a slow client never blocks the others. Since every
  message is a full state, skipping an intermediate one is safe.
- **Recovery:** if the Redis connection drops, every stream on that process ends
  and the browsers reconnect for a fresh snapshot, instead of silently missing
  updates.

Redis connections now scale with the number of **API processes**, not users. In
testing, 60 open streams across 10 orders used **1** Pub/Sub connection.

Replicas need no sticky sessions: every process subscribes to Redis itself, so
an update published on `backend-1` reaches a browser connected to `backend-2`.

## Running it

Requirements: Docker with Compose v2.

```bash
docker compose up -d --build
```

| Service | URL |
|---|---|
| UI (nginx, load-balances `/api` across both replicas) | http://localhost:3000 |
| `backend-1` directly | http://localhost:8001 |
| `backend-2` directly | http://localhost:8002 |

Open http://localhost:3000 and click **Place order**. You land on the order's
detail page, which shows the live status timeline, plus which replica placed
the order, streams it and published each update. **← All orders** goes back to
the list, which shows each order's status as of when the list loaded (use
**Refresh** to reload it). The list is kept in the browser's `localStorage`.

Stop everything with `docker compose down`. Add `-v` to also delete the Redis
data.

## Try it

**Watch a raw stream:**
```bash
ID=$(curl -s -X POST localhost:3000/api/orders | python3 -c 'import sys,json;print(json.load(sys.stdin)["order_id"])')
curl -N localhost:3000/api/orders/$ID/events
```

**Cross replicas on purpose.** Place the order on one replica and stream it from
the other:
```bash
ID=$(curl -s -X POST localhost:8001/api/orders | python3 -c 'import sys,json;print(json.load(sys.stdin)["order_id"])')
curl -N localhost:8002/api/orders/$ID/events   # published_by: backend-1, streamed_by: backend-2
```

**Kill the replica serving your stream.** Place an order in the UI and, on its
detail page, note
"stream: live via backend-N", then:
```bash
docker kill notification_service-backend-N-1   # replace N
```
The page shows a reconnect, lands on the other replica, catches up from the
snapshot and finishes. Bring the replica back with
`docker start notification_service-backend-N-1`.

**Count Pub/Sub connections** while several streams are open:
```bash
docker compose exec redis redis-cli client list type pubsub   # one line per API process
```

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/orders` | Create an order. `202` with `{order_id, status, handled_by}` |
| `GET` | `/api/orders/{id}` | Current status, or `404` |
| `GET` | `/api/orders/{id}/events` | SSE stream: `status` events (`{order_id, status, source, published_by?, streamed_by}`) and `ping` heartbeats. Ends on `completed` or `failed` |
| `GET` | `/api/health` | API and Redis health |

## Project layout

```
backend/app/main.py        API, mock worker, SSE endpoint
backend/app/broker.py      Shared Pub/Sub subscriber with per-client fan-out
frontend/src/useOrderEvents.js   EventSource client: backoff, watchdog, terminal close
frontend/src/App.jsx       Routes: / (order list) and /orders/{id} (order detail)
frontend/src/OrderList.jsx       Orders placed from this browser, status fetched once
frontend/src/OrderDetail.jsx     One order, followed live over SSE
frontend/src/router.jsx    Minimal History API router
frontend/src/orders.js     The order list in localStorage
frontend/nginx.conf        Static files, /api load balancing, SSE proxy settings
docker-compose.yml         Redis, two API replicas, frontend
```

## Possible next steps

- HTTP/2 at nginx, so several tabs on detail pages don't share the browser's 6
  HTTP/1.1 connections.
- A live order list for logged-in users. One SSE stream per user
  (`GET /api/me/events`) sends only a `changed` signal; on each signal, and on
  every (re)connect, the list page refetches all the user's orders from a list
  endpoint, which stays the only source of truth. It needs:
  - auth, so every request (the stream included) maps to a user;
  - an owner on each order, a per-user order index and the list endpoint;
  - the worker publishing every change, and order creation, to `user:{uid}`;
  - on the client, at most one fetch in flight with one queued, so a burst of
    updates causes one or two refetches, and responses can't arrive out of
    order.

  Signals carry no state, so a dropped one is harmless: the next fetch returns
  everything. The cost is one list request per change per open tab, which is
  fine for tens of orders; with hundreds, page the list or return only active
  and recent ones.
- Automated tests for the subscriber: the subscribe/snapshot race, reference
  counting, slow clients, Redis reconnects.
- A load test with thousands of concurrent streams.
- Real workers with a durable queue, so a crashed process can't lose an order.
