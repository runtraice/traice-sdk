import functools
import inspect
import time
from typing import Any, Callable, Optional, TypeVar, cast

from ._client import get_client
from ._usage import Usage, extract_usage

F = TypeVar("F", bound=Callable[..., Any])


class Tracker:
    """Decorator plus sync/async context manager returned by :func:`track`."""

    def __init__(self, *, feature: Optional[str] = None, **options: Any) -> None:
        self._provider: Optional[str] = options.pop("provider", None)
        self._model: Optional[str] = options.pop("model", None)
        self.options: dict[str, Any] = {"feature": feature, **options}
        self._started_at = 0.0
        self._response: Any = None

    def __call__(self, function: F) -> F:
        if inspect.iscoroutinefunction(function):

            @functools.wraps(function)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                started_at = time.perf_counter()
                try:
                    response = await function(*args, **kwargs)
                except Exception as error:
                    self._record_error(started_at, error)
                    raise
                self._record_response(response, started_at)
                return response

            return cast(F, async_wrapper)

        @functools.wraps(function)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            started_at = time.perf_counter()
            try:
                response = function(*args, **kwargs)
            except Exception as error:
                self._record_error(started_at, error)
                raise
            self._record_response(response, started_at)
            return response

        return cast(F, sync_wrapper)

    def __enter__(self) -> "Tracker":
        self._response = None
        self._started_at = time.perf_counter()
        return self

    def __exit__(self, error_type: Any, error: Any, traceback: Any) -> bool:
        if error is not None:
            self._record_error(self._started_at, error)
        elif self._response is not None:
            self._record_response(self._response, self._started_at)
        return False

    async def __aenter__(self) -> "Tracker":
        return self.__enter__()

    async def __aexit__(self, error_type: Any, error: Any, traceback: Any) -> bool:
        return self.__exit__(error_type, error, traceback)

    def record(self, response: Any, *, provider: Optional[str] = None, model: Optional[str] = None) -> Any:
        """Attach a provider response to a context manager and return it unchanged."""
        self._response = response
        if provider is not None:
            self._provider = provider
        if model is not None:
            self._model = model
        return response

    def _record_response(self, response: Any, started_at: float) -> None:
        client = get_client()
        if client is None:
            return
        try:
            usage = extract_usage(response, self._provider, self._model)
            client.record(usage, latency_ms=_elapsed_ms(started_at), **self.options)
        except Exception:
            # Collection must never change the provider-call result.
            return

    def _record_error(self, started_at: float, error: BaseException) -> None:
        client = get_client()
        if client is None:
            return
        usage = Usage(self._provider or "custom", self._model or "unknown", 0, 0, 0, 0)
        try:
            client.record(
                usage,
                latency_ms=_elapsed_ms(started_at),
                status="error",
                error_message=str(error),
                **self.options,
            )
        except Exception:
            # Collection must never replace the provider exception.
            return


def track(feature: Optional[str] = None, **options: Any) -> Tracker:
    """Track an LLM call as a decorator or context manager.

    All attribution dimensions use snake_case, including ``tenant_id``,
    ``user_id``, ``agent_id``, ``workflow_id``, ``run_id``, ``step_id``,
    ``tool_name``, ``retry_count``, and ``outcome``.
    """
    return Tracker(feature=feature, **options)


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))
