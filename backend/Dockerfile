FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000
# On SIGTERM, wait at most 5s for open connections (SSE streams never finish on
# their own) before cancelling them, well inside Docker's 10s stop timeout.
# Cut-off browsers reconnect and land on another replica.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "5"]
