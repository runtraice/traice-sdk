from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class Usage:
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int


def extract_usage(response: Any, provider: Optional[str] = None, model: Optional[str] = None) -> Usage:
    usage = _get(response, "usage")
    detected_provider = provider or _detect_provider(response, usage)
    detected_model = model or str(_get(response, "model") or "unknown")

    if detected_provider == "anthropic":
        cache_read = _number(_get(usage, "cache_read_input_tokens"))
        cache_write = _number(_get(usage, "cache_creation_input_tokens"))
        input_tokens = _number(_get(usage, "input_tokens")) + cache_read + cache_write
        output_tokens = _number(_get(usage, "output_tokens"))
    else:
        input_tokens = _number(_get(usage, "input_tokens", _get(usage, "prompt_tokens")))
        output_tokens = _number(_get(usage, "output_tokens", _get(usage, "completion_tokens")))
        details = _get(usage, "input_tokens_details", _get(usage, "prompt_tokens_details"))
        cache_read = _number(_get(details, "cached_tokens"))
        cache_write = 0

    return Usage(
        provider=detected_provider,
        model=detected_model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
    )


def _detect_provider(response: Any, usage: Any) -> str:
    if _get(response, "type") == "message" and _get(usage, "input_tokens") is not None:
        return "anthropic"
    if _get(usage, "prompt_tokens") is not None or _get(usage, "input_tokens") is not None:
        return "openai"
    return "custom"


def _get(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, Mapping):
        return value.get(key, default)
    return getattr(value, key, default)


def _number(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))
    return 0
