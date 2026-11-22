import asyncio
import json
import os
import random
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import redis.asyncio as redis
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .broker import CLOSED, Broker

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
INSTANCE = os.getenv("INSTANCE", "local")  # which replica this process is
HEARTBEAT_SECONDS = 15
STATUS_TTL_SECONDS = 3600
TERMINAL_STATUSES = {"completed", "failed"}

r = redis.from_url(REDIS_URL, decode_responses=True)
broker = Broker(r)  # one shared Pub/Sub connection for this process


@asynccontextmanager
async def lifespan(_app: FastAPI):
    broker.start()
    yield
    await broker.stop()
    await r.aclose()


app = FastAPI(title="Notification Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mock "database": the order status is a plain Redis key, shared by every API
# process. (Pub/Sub channel names and keys live in separate namespaces.)
def channel(order_id: str) -> str:
    return f"order:{order_id}"


def status_key(order_id: str) -> str:
    return f"order:{order_id}:status"


async def get_status(order_id: str) -> str | None:
    return await r.get(status_key(order_id))


def sse_event(event: str, data: dict) -> str:
    """Format one Server-Sent Event frame (blank line terminates the frame)."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# --------------------------------------------------------------------------- #
# Fake worker
# --------------------------------------------------------------------------- #
async def process_order(order_id: str) -> None:
    """Walk an order through its statuses, publishing every change."""
    for status, delay in (("processing", 2), ("completed", 3)):
        await asyncio.sleep(delay)
        if status == "completed" and random.random() < 0.2:
            status = "failed"
        async with r.pipeline(transaction=True) as tx:
            tx.set(status_key(order_id), status, ex=STATUS_TTL_SECONDS)  # 1. source of truth
            tx.publish(  # 2. then nudge whoever is listening
                channel(order_id),
                json.dumps(
                    {"order_id": order_id, "status": status, "published_by": INSTANCE}
                ),
            )
            await tx.execute()


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health():
    return {"status": "ok", "redis": await r.ping()}


@app.post("/api/orders", status_code=202)
async def create_order(background: BackgroundTasks):
    order_id = uuid.uuid4().hex[:8]
    await r.set(status_key(order_id), "pending", ex=STATUS_TTL_SECONDS)
    background.add_task(process_order, order_id)
    return {"order_id": order_id, "status": "pending", "handled_by": INSTANCE}


@app.get("/api/orders/{order_id}")
async def get_order(order_id: str):
    status = await get_status(order_id)
    if status is None:
        raise HTTPException(404, "order not found")
    return {"order_id": order_id, "status": status}


# --------------------------------------------------------------------------- #
# SSE
# --------------------------------------------------------------------------- #
async def order_event_stream(order_id: str) -> AsyncIterator[str]:
    try:
        # 1. Subscribe FIRST, and wait until Redis has confirmed it, so an
        #    update published while we read the snapshot can't slip through.
        async with broker.subscribe(channel(order_id)) as mailbox:
            # 2. Snapshot: covers updates that happened before we subscribed,
            #    and makes reconnects trivially correct.
            status = await get_status(order_id)
            if status is None:  # expired between the 404 check and now
                return
            yield "retry: 3000\n\n" + sse_event(
                "status",
                {
                    "order_id": order_id,
                    "status": status,
                    "source": "snapshot",
                    "streamed_by": INSTANCE,
                },
            )
            if status in TERMINAL_STATUSES:
                return

            # 3. Live updates from our mailbox, with a heartbeat when idle. It
            #    keeps proxies from dropping the connection, and it is a real
            #    event (not a ": comment", which JS never sees) so the browser
            #    can run a watchdog and detect a dead connection.
            while True:
                try:
                    raw = await asyncio.wait_for(mailbox.get(), HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield sse_event("ping", {})
                    continue
                if raw is CLOSED:  # broker lost Redis; the browser will reconnect
                    return
                data = json.loads(raw)
                # The update may have been published by another replica: Redis
                # delivers it to every subscribed process, wherever it runs.
                data |= {"source": "pubsub", "streamed_by": INSTANCE}
                yield sse_event("status", data)
                if data["status"] in TERMINAL_STATUSES:
                    return
    except (TimeoutError, ConnectionError):
        return  # subscription never confirmed; end the stream, browser retries


@app.get("/api/orders/{order_id}/events")
async def order_events(order_id: str):
    if await get_status(order_id) is None:
        raise HTTPException(404, "order not found")
    return StreamingResponse(
        order_event_stream(order_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Instance": INSTANCE,
        },
    )
