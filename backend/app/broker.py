"""One shared Redis Pub/Sub connection per process, fanned out to local mailboxes.

    Browser A ── mailbox ┐
    Browser B ── mailbox ┼── registry ── reader task ── 1 Redis connection
    Browser C ── mailbox ┘

Every SSE client gets a mailbox (an asyncio.Queue). The broker SUBSCRIBEs to a
channel when its first local listener arrives and UNSUBSCRIBEs when the last
one leaves, so Redis sees one subscriber connection per process no matter how
many browsers are connected.
"""

import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import anyio
import redis.asyncio as redis

log = logging.getLogger(__name__)

# Put in a mailbox to tell the SSE handler "updates may have been lost, end the
# stream". The browser's EventSource reconnects and gets a fresh snapshot.
CLOSED = None
SUBSCRIBE_TIMEOUT_SECONDS = 5


@dataclass
class _Channel:
    mailboxes: set[asyncio.Queue] = field(default_factory=set)
    # Resolved when Redis confirms the SUBSCRIBE for this channel.
    ready: asyncio.Future = field(
        default_factory=lambda: asyncio.get_running_loop().create_future()
    )


def _deliver(mailbox: asyncio.Queue, message: str | None) -> None:
    """Never block the shared reader: a mailbox only holds the latest message.

    Safe because every message carries the full current status, so a slow
    client that skips an intermediate one still ends up correct.
    """
    if mailbox.full():
        mailbox.get_nowait()
    mailbox.put_nowait(message)


class Broker:
    def __init__(self, client: redis.Redis):
        self._client = client
        self._pubsub = client.pubsub()
        self._channels: dict[str, _Channel] = {}
        # Redis confirms SUBSCRIBEs in the order they were sent, so a FIFO of
        # futures per channel matches each confirmation to its request.
        self._pending_acks: dict[str, deque[asyncio.Future]] = {}
        # The pubsub connection is opened lazily by the first SUBSCRIBE; the
        # reader can't read until then.
        self._connected = asyncio.Event()
        self._reader: asyncio.Task | None = None

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        self._reader = asyncio.create_task(self._read_forever())

    async def stop(self) -> None:
        if self._reader:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        self._reset()
        await self._pubsub.aclose()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    @asynccontextmanager
    async def subscribe(self, channel: str) -> AsyncIterator[asyncio.Queue]:
        """Yield a mailbox for `channel`, once Redis has confirmed the subscription.

        Waiting for the confirmation matters: SUBSCRIBE only takes effect when
        Redis processes it, so a caller reading a snapshot right after a
        fire-and-forget SUBSCRIBE could still miss an update in between.
        """
        mailbox: asyncio.Queue = asyncio.Queue(maxsize=1)
        entry = self._channels.get(channel)
        if entry is None:  # first local listener: subscribe in Redis
            entry = self._channels[channel] = _Channel()
            self._pending_acks.setdefault(channel, deque()).append(entry.ready)
            await self._pubsub.subscribe(channel)
            self._connected.set()
        entry.mailboxes.add(mailbox)
        try:
            await asyncio.wait_for(
                asyncio.shield(entry.ready), SUBSCRIBE_TIMEOUT_SECONDS
            )
            yield mailbox
        finally:
            entry.mailboxes.discard(mailbox)
            # `is entry` guards against a reset having replaced the registry.
            if not entry.mailboxes and self._channels.get(channel) is entry:
                del self._channels[channel]  # last local listener: unsubscribe
                with anyio.CancelScope(shield=True):  # we may be mid-cancellation
                    await self._pubsub.unsubscribe(channel)

    # ------------------------------------------------------------------ #
    # Reader
    # ------------------------------------------------------------------ #
    async def _read_forever(self) -> None:
        while True:
            await self._connected.wait()
            try:
                msg = await self._pubsub.get_message(timeout=1.0)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("pubsub connection failed, resetting broker")
                self._reset()
                await asyncio.sleep(1)
                continue
            if msg is not None:
                await self._handle(msg)

    async def _handle(self, msg: dict) -> None:
        kind, channel = msg["type"], msg["channel"]
        if kind == "message":
            entry = self._channels.get(channel)
            if entry:
                for mailbox in entry.mailboxes:
                    _deliver(mailbox, msg["data"])
        elif kind == "subscribe":
            acks = self._pending_acks.get(channel)
            if acks:
                ack = acks.popleft()
                if not ack.done():
                    ack.set_result(None)
                if not acks:
                    del self._pending_acks[channel]
            else:
                # Nobody asked for this SUBSCRIBE: redis-py reconnected on its
                # own and re-subscribed. Anything published during the outage
                # is gone, so make these listeners reconnect and re-snapshot.
                await self._close_channel(channel)

    # ------------------------------------------------------------------ #
    # Recovery
    # ------------------------------------------------------------------ #
    async def _close_channel(self, channel: str) -> None:
        entry = self._channels.pop(channel, None)
        if entry:
            for mailbox in entry.mailboxes:
                _deliver(mailbox, CLOSED)
        # Their `finally` blocks won't unsubscribe (the entry is gone), so do it
        # now, before any new listener can send a fresh SUBSCRIBE.
        await self._pubsub.unsubscribe(channel)

    def _reset(self) -> None:
        """Drop all state; every open stream ends and its browser reconnects."""
        for entry in self._channels.values():
            for mailbox in entry.mailboxes:
                _deliver(mailbox, CLOSED)
        for acks in self._pending_acks.values():
            for ack in acks:
                if not ack.done():
                    ack.set_exception(ConnectionError("pubsub connection reset"))
        self._channels.clear()
        self._pending_acks.clear()
        old = self._pubsub
        self._pubsub = self._client.pubsub()
        self._connected.clear()
        asyncio.create_task(old.aclose())
