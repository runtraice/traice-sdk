import atexit
import json
import os
import threading
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib import request

from ._pricing import calculate_cost
from ._usage import Usage
from ._version import __version__

DEFAULT_ENDPOINT = "https://runtraice.com/api/v1/events"


@dataclass(frozen=True)
class ClientStats:
    enqueued: int
    sent: int
    dropped: int
    failed_batches: int
    queued: int


class TraiceClient:
    """Background event client used by :func:`configure` and :func:`track`."""

    def __init__(
        self,
        api_key: str,
        endpoint: str = DEFAULT_ENDPOINT,
        *,
        batch_size: int = 50,
        flush_interval: float = 5.0,
        timeout: float = 10.0,
        max_queue_size: int = 1_000,
        _transport: Optional[Callable[[str, bytes, Mapping[str, str], float], None]] = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("api_key is required")
        if batch_size < 1 or max_queue_size < 1:
            raise ValueError("batch_size and max_queue_size must be positive")
        if flush_interval <= 0 or timeout <= 0:
            raise ValueError("flush_interval and timeout must be positive")

        self.api_key = api_key.strip()
        self.endpoint = _event_endpoint(endpoint)
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self.timeout = timeout
        self.max_queue_size = max_queue_size
        self._transport = _transport or _post
        self._buffer: deque[dict[str, Any]] = deque()
        self._condition = threading.Condition()
        self._wake = threading.Event()
        self._closing = False
        self._active = False
        self._enqueued = 0
        self._sent = 0
        self._dropped = 0
        self._failed_batches = 0
        self._thread = threading.Thread(target=self._run, name="traice-flusher", daemon=True)
        self._thread.start()

    def enqueue(self, event: dict[str, Any]) -> None:
        """Queue an event without waiting for network I/O."""
        with self._condition:
            if self._closing:
                self._dropped += 1
                return
            if len(self._buffer) >= self.max_queue_size:
                self._buffer.popleft()
                self._dropped += 1
            self._buffer.append(event)
            self._enqueued += 1
            if len(self._buffer) >= self.batch_size:
                self._wake.set()
            self._condition.notify_all()

    def record(self, usage: Usage, *, latency_ms: int, status: str = "success", **dimensions: Any) -> None:
        raw_metadata = dimensions.pop("metadata", None)
        metadata = dict(raw_metadata) if isinstance(raw_metadata, Mapping) else {}
        metadata["sdk"] = "python"
        metadata["sdkVersion"] = __version__
        error_message = dimensions.pop("error_message", None)
        if error_message:
            metadata["errorMessage"] = str(error_message)[:2048]

        event: dict[str, Any] = {
            "ts": _timestamp(),
            "provider": usage.provider,
            "model": usage.model,
            "promptTokens": usage.input_tokens,
            "outputTokens": usage.output_tokens,
            "totalTokens": usage.input_tokens + usage.output_tokens,
            "cacheReadTokens": usage.cache_read_tokens,
            "cacheWriteTokens": usage.cache_write_tokens,
            "costUsd": calculate_cost(
                usage.provider,
                usage.model,
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                usage.cache_write_tokens,
            ),
            "latencyMs": max(0, int(latency_ms)),
            "status": status,
            "metadata": metadata,
        }
        event.update({_camel_case(key): value for key, value in dimensions.items() if value is not None})
        self.enqueue(event)

    def flush(self, timeout: Optional[float] = None) -> bool:
        """Wait for currently queued events. Returns False if the timeout expires."""
        deadline = None if timeout is None else time.monotonic() + timeout
        self._wake.set()
        with self._condition:
            while self._buffer or self._active:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._condition.wait(remaining)
        return True

    def close(self, timeout: float = 2.0) -> bool:
        """Flush pending events and stop the background worker."""
        with self._condition:
            self._closing = True
            self._condition.notify_all()
        self._wake.set()
        self._thread.join(max(0, timeout))
        return not self._thread.is_alive()

    def stats(self) -> ClientStats:
        with self._condition:
            return ClientStats(
                enqueued=self._enqueued,
                sent=self._sent,
                dropped=self._dropped,
                failed_batches=self._failed_batches,
                queued=len(self._buffer),
            )

    def _run(self) -> None:
        while True:
            self._wake.wait(self.flush_interval)
            self._wake.clear()
            while True:
                with self._condition:
                    if not self._buffer:
                        if self._closing:
                            self._condition.notify_all()
                            return
                        self._active = False
                        self._condition.notify_all()
                        break
                    self._active = True
                    batch = [self._buffer.popleft() for _ in range(min(self.batch_size, len(self._buffer)))]

                sent = self._send(batch)
                with self._condition:
                    if sent:
                        self._sent += len(batch)
                    else:
                        self._dropped += len(batch)
                        self._failed_batches += 1
                    self._active = False
                    self._condition.notify_all()

    def _send(self, batch: list[dict[str, Any]]) -> bool:
        try:
            body = json.dumps({"events": batch}, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError):
            return False
        headers = {
            "Authorization": "Bearer " + self.api_key,
            "Content-Type": "application/json",
            "User-Agent": "traice-python/" + __version__,
            "X-Source": "traice-python",
        }
        for attempt in range(2):
            try:
                self._transport(self.endpoint, body, headers, self.timeout)
                return True
            except Exception:
                if attempt == 0:
                    time.sleep(0.1)
        return False


_global_lock = threading.Lock()
_global_client: Optional[TraiceClient] = None


def configure(
    api_key: Optional[str] = None,
    endpoint: str = DEFAULT_ENDPOINT,
    **options: Any,
) -> TraiceClient:
    """Configure the process-wide client and return it.

    ``api_key`` falls back to ``TRAICE_API_KEY``. Reconfiguration closes the
    previous client after a best-effort flush.
    """
    resolved_key = api_key or os.getenv("TRAICE_API_KEY")
    if not resolved_key:
        raise ValueError("api_key is required. Pass it to configure() or set TRAICE_API_KEY")
    client = TraiceClient(resolved_key, endpoint, **options)
    global _global_client
    with _global_lock:
        previous = _global_client
        _global_client = client
    if previous is not None:
        previous.close()
    return client


def get_client() -> Optional[TraiceClient]:
    with _global_lock:
        return _global_client


def flush(timeout: Optional[float] = None) -> bool:
    client = get_client()
    return True if client is None else client.flush(timeout)


def shutdown(timeout: float = 2.0) -> bool:
    global _global_client
    with _global_lock:
        client = _global_client
        _global_client = None
    return True if client is None else client.close(timeout)


def _shutdown_at_exit() -> None:
    shutdown()


atexit.register(_shutdown_at_exit)


def _post(url: str, body: bytes, headers: Mapping[str, str], timeout: float) -> None:
    outgoing = request.Request(url, data=body, headers=dict(headers), method="POST")
    with request.urlopen(outgoing, timeout=timeout) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError("trAIce returned HTTP " + str(response.status))


def _event_endpoint(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    if not value:
        raise ValueError("endpoint is required")
    if value.endswith("/api/v1/events"):
        return value
    return value + "/api/v1/events"


def _camel_case(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _timestamp() -> str:
    now = time.time()
    seconds = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now))
    millis = int((now % 1) * 1000)
    return f"{seconds}.{millis:03d}Z"
