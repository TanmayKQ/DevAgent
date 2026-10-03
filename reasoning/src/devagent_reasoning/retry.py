"""Retry-on-rate-limit for LLM calls. Free/low-tier API quotas (e.g. Gemini's 5 requests/minute)
are routinely hit by a multi-step agent loop; a 429 is a "wait and try again", not a task failure.
"""
from __future__ import annotations

import re
import time
from typing import Any, Callable, Optional

NotifyFn = Callable[[str, Optional[dict[str, Any]]], None]

DEFAULT_WAIT_S = 20.0
MAX_WAIT_S = 90.0


def is_rate_limit_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}"
    return "RateLimit" in text or "RESOURCE_EXHAUSTED" in text or "429" in text


def suggested_wait_s(exc: BaseException) -> float:
    """Honor the provider's own hint ('Please retry in 16.6s' / retryDelay '16s') when present."""
    match = re.search(r"retry in ([\d.]+)s", str(exc)) or re.search(r"retryDelay'?\"?: ?'?\"?(\d+)s", str(exc))
    wait = float(match.group(1)) + 1.0 if match else DEFAULT_WAIT_S
    return min(wait, MAX_WAIT_S)


def invoke_with_retry(
    fn: Callable[[], Any],
    notify: NotifyFn,
    max_attempts: int = 8,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            if not is_rate_limit_error(exc) or attempt == max_attempts:
                raise
            wait = suggested_wait_s(exc)
            notify("rate_limited", {"attempt": attempt, "retry_in_s": round(wait, 1)})
            sleep(wait)
    raise AssertionError("unreachable")
