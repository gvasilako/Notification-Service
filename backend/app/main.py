import os

import redis.asyncio as redis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
NOTIFICATIONS_KEY = "notifications"

app = FastAPI(title="Notification Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

r = redis.from_url(REDIS_URL, decode_responses=True)


class Notification(BaseModel):
    message: str


@app.get("/api/health")
async def health():
    return {"status": "ok", "redis": await r.ping()}


@app.get("/api/notifications")
async def list_notifications():
    return {"notifications": await r.lrange(NOTIFICATIONS_KEY, 0, -1)}


@app.post("/api/notifications", status_code=201)
async def create_notification(n: Notification):
    await r.lpush(NOTIFICATIONS_KEY, n.message)
    return {"message": n.message}
