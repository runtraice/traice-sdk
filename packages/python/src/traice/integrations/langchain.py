import threading
import time
from typing import Any, Optional

from .._client import get_client
from .._usage import Usage


class TraiceCallbackHandler:
    """Dependency-free LangChain/LangGraph callback handler.

    Pass the instance through ``callbacks=[handler]``. The class intentionally
    does not import LangChain, so installing ``traice-sdk`` does not add provider or
    framework dependencies.
    """

    def __init__(self, *, feature: Optional[str] = None, **dimensions: Any) -> None:
        self.dimensions = {"feature": feature, **dimensions}
        self._runs: dict[str, float] = {}
        self._lock = threading.Lock()

    def on_llm_start(self, serialized: Any, prompts: Any, *, run_id: Any, **kwargs: Any) -> None:
        self._start(run_id)

    def on_chat_model_start(self, serialized: Any, messages: Any, *, run_id: Any, **kwargs: Any) -> None:
        self._start(run_id)

    def on_llm_end(self, response: Any, *, run_id: Any, **kwargs: Any) -> None:
        llm_output = _get(response, "llm_output") or {}
        usage = _get(llm_output, "token_usage") or _get(llm_output, "usage") or {}
        model = _get(llm_output, "model_name") or _get(llm_output, "model") or "unknown"
        provider = "anthropic" if str(model).startswith("claude") else "openai"
        input_tokens = _number(_get(usage, "input_tokens", _get(usage, "prompt_tokens")))
        output_tokens = _number(_get(usage, "output_tokens", _get(usage, "completion_tokens")))
        if provider == "anthropic":
            cache_read = _number(_get(usage, "cache_read_input_tokens"))
            cache_write = _number(_get(usage, "cache_creation_input_tokens"))
            input_tokens += cache_read + cache_write
        else:
            details = _get(usage, "input_tokens_details", _get(usage, "prompt_tokens_details"))
            cache_read = _number(_get(details, "cached_tokens"))
            cache_write = 0
        self._record(
            run_id,
            Usage(provider, str(model), input_tokens, output_tokens, cache_read, cache_write),
            status="success",
        )

    def on_llm_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
        self._record(
            run_id,
            Usage("custom", "unknown", 0, 0, 0, 0),
            status="error",
            error_message=str(error),
        )

    def _start(self, run_id: Any) -> None:
        with self._lock:
            self._runs[str(run_id)] = time.perf_counter()

    def _record(self, run_id: Any, usage: Usage, **extra: Any) -> None:
        with self._lock:
            started_at = self._runs.pop(str(run_id), time.perf_counter())
        client = get_client()
        if client is not None:
            dimensions = {**self.dimensions, "run_id": str(run_id), **extra}
            try:
                client.record(
                    usage,
                    latency_ms=max(0, int((time.perf_counter() - started_at) * 1000)),
                    **dimensions,
                )
            except Exception:
                return


def _get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _number(value: Any) -> int:
    return max(0, int(value)) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0
