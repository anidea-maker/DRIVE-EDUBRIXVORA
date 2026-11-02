"""Optional Python/FastAPI helper for Edvanta's 9Drive integration.

The live Edvanta API answers ``{"detail": "Not Found"}`` / ``{"detail":
"Sign in required"}``, which is FastAPI-shaped. If Edvanta's backend is Python,
drop this file next to its app and use either:

    from fastapi_9drive import install_9drive_routes, merge_storage_status
    install_9drive_routes(app, require_admin)   # adds two admin status routes

    # or inside an existing /api/admin/overview handler:
    return merge_storage_status(overview, await get_storage_status())

It reads the SAME environment variables already configured on Render:
``NINE_DRIVE_API_URL`` / ``NINE_DRIVE_API_KEY`` (or the ``STORAGE_*`` aliases).
Only the standard library is used; the API key never leaves the server and is
never placed in a URL, log, or browser response.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

DEFAULT_TIMEOUT_SECONDS = 3.0

ENDPOINT_ENV_KEYS = (
    "STORAGE_ENDPOINT",
    "NINE_DRIVE_API_URL",
    "NINE_DRIVE_URL",
    "NINE_DRIVE_BASE_URL",
)
API_KEY_ENV_KEYS = ("STORAGE_API_KEY", "NINE_DRIVE_API_KEY")
TIMEOUT_ENV_KEYS = ("STORAGE_TIMEOUT_MS", "NINE_DRIVE_TIMEOUT_MS")

_EMPTY_RESOURCES = {"available": 0, "missing": 0, "inaccessible": 0, "unknown": 0}


def _first_env(keys: tuple[str, ...]) -> str:
    for key in keys:
        value = os.environ.get(key, "")
        if value and value.strip():
            return value.strip()
    return ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_endpoint(value: Optional[str]) -> str:
    """Turn a bare origin, ``/api`` or ``/v1`` into the real ``/api/v1`` base.

    Credentials, query strings and fragments are dropped, so a secret pasted
    into the URL is never echoed back by a status response.
    """
    raw = (value or "").strip().rstrip("/")
    if not raw:
        return ""
    if "://" not in raw:
        raw = "https://" + raw
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https"):
        raise ValueError("9Drive URL must be HTTP(S)")
    host = parts.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{parts.port}" if parts.port else host
    path = parts.path.rstrip("/")
    if not path or path == "/":
        path = "/api/v1"
    elif path == "/api" or path.endswith("/api"):
        path = path + "/v1"
    elif path.endswith("/v1") and "/api/v1" not in path:
        path = path[: -len("/v1")] + "/api/v1"
    elif "/api/v1" not in path:
        path = path + "/api/v1"
    return urlunsplit((parts.scheme, netloc, path, "", ""))


def config() -> Dict[str, Any]:
    try:
        endpoint = normalize_endpoint(_first_env(ENDPOINT_ENV_KEYS))
    except ValueError:
        endpoint = ""
    api_key = _first_env(API_KEY_ENV_KEYS)
    raw_timeout = _first_env(TIMEOUT_ENV_KEYS)
    try:
        # STORAGE_TIMEOUT_MS / NINE_DRIVE_TIMEOUT_MS are milliseconds.
        timeout = float(raw_timeout) / 1000.0 if raw_timeout else DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        timeout = DEFAULT_TIMEOUT_SECONDS
    if timeout <= 0:
        timeout = DEFAULT_TIMEOUT_SECONDS
    return {"endpoint": endpoint, "api_key": api_key, "timeout": timeout}


def _unavailable(endpoint: str, code: str, checked_at: str) -> Dict[str, Any]:
    storage = {
        "status": "unavailable",
        "provider": "9Drive",
        "endpoint": endpoint,
        "database": {"ok": False},
        "accounts": [],
        "resources": dict(_EMPTY_RESOURCES),
        "checkedAt": checked_at,
        "reported": True,
        "error": code,
    }
    return {
        "storage": storage,
        "storageStatus": "unavailable",
        "reported": True,
        "note": "9Drive did not answer. The API has reported an unavailable storage status instead of leaving it unreported.",
    }


def _request_json(url: str, api_key: str, timeout: float) -> Dict[str, Any]:
    request = Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except HTTPError as error:
        # A degraded provider can still return a valid `storage` report with a
        # non-2xx status. Keep that report instead of failing.
        raw = error.read().decode("utf-8", "replace")
        body: Dict[str, Any] = {}
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            pass
        if isinstance(body, dict) and body.get("storage"):
            return body
        raise RuntimeError(f"9Drive returned HTTP {error.code}") from error
    return json.loads(raw) if raw else {}


def _error_code(error: BaseException) -> str:
    if isinstance(error, HTTPError):
        return "STORAGE_HTTP_ERROR"
    if isinstance(error, (URLError, TimeoutError, OSError)):
        return "STORAGE_UPSTREAM_UNAVAILABLE"
    return "STORAGE_UPSTREAM_UNAVAILABLE"


async def get_storage_status(
    fetch: Optional[Callable[[str, str], Awaitable[Dict[str, Any]] | Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Always return a `storage` object, even when 9Drive is cold or offline."""
    settings = config()
    checked_at = _now()
    if not settings["endpoint"] or not settings["api_key"]:
        return _unavailable(settings["endpoint"], "NINE_DRIVE_NOT_CONFIGURED", checked_at)

    url = settings["endpoint"] + "/storage-status"
    try:
        if fetch is None:
            body = await asyncio.to_thread(_request_json, url, settings["api_key"], settings["timeout"])
        else:
            result = fetch(url, settings["api_key"])
            body = await result if inspect.isawaitable(result) else result
        if not isinstance(body, dict):
            raise RuntimeError("9Drive returned a non-object response")
        reported = body.get("storage") or {
            "status": "degraded" if body.get("status") == "degraded" else "connected",
            "provider": "9Drive",
            "database": body.get("database", {"ok": False}),
            "accounts": body.get("accounts", []),
            "resources": body.get("resources", dict(_EMPTY_RESOURCES)),
            "checkedAt": body.get("checkedAt", checked_at),
        }
        storage = dict(reported)
        storage["endpoint"] = settings["endpoint"]
        storage["reported"] = True
        return {
            "storage": storage,
            "storageStatus": body.get("storageStatus") or storage.get("status"),
            "reported": True,
        }
    except BaseException as error:  # noqa: BLE001 - converted to a safe status code
        return _unavailable(settings["endpoint"], _error_code(error), checked_at)


def merge_storage_status(overview: Optional[Dict[str, Any]], status: Dict[str, Any]) -> Dict[str, Any]:
    """Add the 9Drive status to Edvanta's existing admin overview response."""
    result = dict(overview or {})
    result.update(
        {
            "storage": status["storage"],
            "storageStatus": status["storageStatus"],
            "storageReported": status["reported"],
            "reported": True,
        }
    )
    return result


def install_9drive_routes(app: Any, admin_dependency: Callable[..., Any]) -> None:
    """Register admin-only status routes on a FastAPI app.

    `admin_dependency` MUST be Edvanta's real admin/session dependency. This
    helper deliberately refuses to install unprotected admin endpoints.
    """
    if admin_dependency is None:
        raise ValueError("install_9drive_routes needs Edvanta's admin dependency")
    from fastapi import Depends

    @app.get("/api/admin/storage-status")
    async def _storage_status(_admin: Any = Depends(admin_dependency)) -> Dict[str, Any]:
        return await get_storage_status()

    @app.get("/api/admin/9drive/status")
    async def _nine_drive_status(_admin: Any = Depends(admin_dependency)) -> Dict[str, Any]:
        return await get_storage_status()
