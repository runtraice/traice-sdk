Pricing = tuple[float, float]

_PRICING: dict[str, dict[str, Pricing]] = {
    "openai": {
        "gpt-4o": (2.5, 10.0),
        "gpt-4o-2024-11-20": (2.5, 10.0),
        "gpt-4o-2024-08-06": (2.5, 10.0),
        "gpt-4o-mini": (0.15, 0.6),
        "gpt-4o-mini-2024-07-18": (0.15, 0.6),
        "gpt-4-turbo": (10.0, 30.0),
        "gpt-4": (30.0, 60.0),
        "gpt-3.5-turbo": (0.5, 1.5),
        "o1": (15.0, 60.0),
        "o1-mini": (3.0, 12.0),
        "o3": (10.0, 40.0),
        "o3-mini": (1.1, 4.4),
    },
    "anthropic": {
        "claude-opus-4-20250514": (15.0, 75.0),
        "claude-sonnet-4-20250514": (3.0, 15.0),
        "claude-haiku-4-5-20251001": (0.8, 4.0),
        "claude-3-5-sonnet-20241022": (3.0, 15.0),
        "claude-3-5-sonnet-20240620": (3.0, 15.0),
        "claude-3-5-haiku-20241022": (0.8, 4.0),
        "claude-3-opus-20240229": (15.0, 75.0),
        "claude-3-sonnet-20240229": (3.0, 15.0),
        "claude-3-haiku-20240307": (0.25, 1.25),
    },
}

_CACHE_MULTIPLIERS = {
    "openai": (0.5, 1.0),
    "anthropic": (0.1, 1.25),
}


def configure_pricing(
    provider: str,
    model: str,
    *,
    input_per_million: float,
    output_per_million: float,
) -> None:
    """Add or replace local per-million-token pricing for a model."""
    if input_per_million < 0 or output_per_million < 0:
        raise ValueError("Pricing must be non-negative")
    _PRICING.setdefault(provider, {})[model] = (input_per_million, output_per_million)


def calculate_cost(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    pricing = _PRICING.get(provider, {}).get(model)
    if pricing is None:
        return 0.0

    input_tokens = max(0, int(input_tokens))
    cache_read_tokens = max(0, int(cache_read_tokens))
    cache_write_tokens = max(0, int(cache_write_tokens))
    cache_total = cache_read_tokens + cache_write_tokens
    if cache_total > input_tokens and cache_total > 0:
        scale = input_tokens / cache_total
        cache_read_tokens = int(cache_read_tokens * scale)
        cache_write_tokens = min(input_tokens - cache_read_tokens, int(cache_write_tokens * scale))

    regular_tokens = max(0, input_tokens - cache_read_tokens - cache_write_tokens)
    input_price, output_price = pricing
    read_multiplier, write_multiplier = _CACHE_MULTIPLIERS.get(provider, (1.0, 1.0))
    input_cost = (
        regular_tokens * input_price
        + cache_read_tokens * input_price * read_multiplier
        + cache_write_tokens * input_price * write_multiplier
    ) / 1_000_000
    output_cost = max(0, int(output_tokens)) * output_price / 1_000_000
    return input_cost + output_cost
