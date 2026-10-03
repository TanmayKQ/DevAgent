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
    """The provider's own hint ('Please retry in 16.6s' or '15h58m59s'), plus a second of slack,
    or a default if it gave none. Not capped here — a multi-hour hint means a hard daily quota."""
    match = re.search(r"retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s", str(exc))
    if not match:
        return DEFAULT_WAIT_S
    hours, minutes, seconds = int(match.group(1) or 0), int(match.group(2) or 0), float(match.group(3))
    return hours * 3600 + minutes * 60 + seconds + 1.0


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
            if wait > MAX_WAIT_S:
                # Not a per-minute rate limit — a hard quota (e.g. a free tier's daily cap). Waiting
                # won't help within a task's lifetime; fail fast with a clear message instead.
                raise RuntimeError(
                    f"API quota exhausted (provider says retry in ~{wait / 3600:.1f}h). "
                    f"Use a key/plan with more quota, or try again later."
                ) from exc
            notify("rate_limited", {"attempt": attempt, "retry_in_s": round(wait, 1)})
            sleep(wait)
    raise AssertionError("unreachable")
