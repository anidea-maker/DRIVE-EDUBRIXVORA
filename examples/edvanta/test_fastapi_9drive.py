"""Mocked, dependency-free tests for the optional FastAPI 9Drive helper."""

import asyncio
import os
import unittest
from unittest.mock import patch

import fastapi_9drive


class NormalizeEndpointTests(unittest.TestCase):
    def test_bare_origin_api_and_v1_all_resolve_to_api_v1(self):
        expected = "https://drive-edubrixvora-1.onrender.com/api/v1"
        self.assertEqual(fastapi_9drive.normalize_endpoint("https://drive-edubrixvora-1.onrender.com/"), expected)
        self.assertEqual(fastapi_9drive.normalize_endpoint("https://drive-edubrixvora-1.onrender.com/api"), expected)
        self.assertEqual(fastapi_9drive.normalize_endpoint("https://drive-edubrixvora-1.onrender.com/api/v1"), expected)
        self.assertEqual(fastapi_9drive.normalize_endpoint("drive-edubrixvora-1.onrender.com"), expected)
        self.assertEqual(fastapi_9drive.normalize_endpoint("https://drive.example.com/v1"), "https://drive.example.com/api/v1")
        self.assertEqual(
            fastapi_9drive.normalize_endpoint("https://user:pass@drive.example.com/api?key=secret"),
            "https://drive.example.com/api/v1",
        )
        self.assertEqual(fastapi_9drive.normalize_endpoint(""), "")


class StorageStatusTests(unittest.TestCase):
    def test_existing_nine_drive_env_vars_are_used_and_health_is_called(self):
        captured = {}

        async def fetch(url, api_key):
            captured["url"] = url
            captured["api_key"] = api_key
            return {
                "status": "ok",
                "storage": {
                    "status": "connected",
                    "provider": "9Drive",
                    "database": {"ok": True},
                    "accounts": [{"ok": True, "provider": "s3"}],
                    "resources": {"available": 4, "missing": 0, "inaccessible": 0, "unknown": 0},
                    "checkedAt": "2026-11-02T12:00:00+00:00",
                    "reported": True,
                },
                "storageStatus": "connected",
                "reported": True,
            }

        env = {"NINE_DRIVE_API_URL": "https://drive-edubrixvora-1.onrender.com/api", "NINE_DRIVE_API_KEY": "9d_live_test"}
        with patch.dict(os.environ, env, clear=True):
            status = asyncio.run(fastapi_9drive.get_storage_status(fetch=fetch))
        self.assertEqual(captured["url"], "https://drive-edubrixvora-1.onrender.com/api/v1/storage-status")
        self.assertEqual(captured["api_key"], "9d_live_test")
        self.assertEqual(status["storage"]["status"], "connected")
        self.assertEqual(status["storage"]["endpoint"], "https://drive-edubrixvora-1.onrender.com/api/v1")
        self.assertTrue(status["reported"])

    def test_offline_9drive_is_reported_as_unavailable_not_missing(self):
        async def fetch(url, api_key):
            raise OSError("offline")

        env = {"NINE_DRIVE_API_URL": "https://drive.example.com", "NINE_DRIVE_API_KEY": "k"}
        with patch.dict(os.environ, env, clear=True):
            status = asyncio.run(fastapi_9drive.get_storage_status(fetch=fetch))
        self.assertEqual(status["storage"]["status"], "unavailable")
        self.assertEqual(status["storage"]["error"], "STORAGE_UPSTREAM_UNAVAILABLE")
        self.assertTrue(status["storage"]["reported"])
        self.assertTrue(status["reported"])

    def test_unconfigured_is_reported_safely(self):
        with patch.dict(os.environ, {}, clear=True):
            status = asyncio.run(fastapi_9drive.get_storage_status(fetch=lambda url, key: {}))
        self.assertEqual(status["storage"]["status"], "unavailable")
        self.assertEqual(status["storage"]["error"], "NINE_DRIVE_NOT_CONFIGURED")
        self.assertTrue(status["reported"])

    def test_merge_storage_status_adds_storage_to_existing_overview(self):
        status = {
            "storage": {"status": "connected", "provider": "9Drive", "reported": True},
            "storageStatus": "connected",
            "reported": True,
        }
        overview = fastapi_9drive.merge_storage_status({"users": 12, "resources": 7}, status)
        self.assertEqual(overview["users"], 12)
        self.assertEqual(overview["storage"]["status"], "connected")
        self.assertEqual(overview["storageStatus"], "connected")
        self.assertTrue(overview["storageReported"])
        self.assertTrue(overview["reported"])


if __name__ == "__main__":
    unittest.main()
