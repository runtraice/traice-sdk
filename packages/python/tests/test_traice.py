import asyncio
import json
import time
import unittest

import traice
from traice._client import TraiceClient
from traice._usage import extract_usage


class CaptureTransport:
    def __init__(self, failures=0):
        self.failures = failures
        self.calls = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append((url, json.loads(body), dict(headers), timeout))
        if len(self.calls) <= self.failures:
            raise OSError("offline")


class ClientTests(unittest.TestCase):
    def tearDown(self):
        traice.shutdown()

    def test_batches_events_and_tags_python_sdk(self):
        transport = CaptureTransport()
        client = TraiceClient(
            "lm_live_test",
            "https://example.test",
            batch_size=2,
            flush_interval=60,
            _transport=transport,
        )
        client.record(
            extract_usage(
                {
                    "model": "gpt-4o-mini",
                    "usage": {
                        "prompt_tokens": 100,
                        "completion_tokens": 20,
                        "prompt_tokens_details": {"cached_tokens": 40},
                    },
                }
            ),
            latency_ms=12,
            feature="support",
            tenant_id="acme",
            workflow_id="ticket",
        )
        client.record(
            extract_usage(
                {
                    "type": "message",
                    "model": "claude-sonnet-4-20250514",
                    "usage": {
                        "input_tokens": 80,
                        "output_tokens": 10,
                        "cache_read_input_tokens": 20,
                        "cache_creation_input_tokens": 5,
                    },
                }
            ),
            latency_ms=8,
            feature="support",
        )

        self.assertTrue(client.flush(1))
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0][0], "https://example.test/api/v1/events")
        events = transport.calls[0][1]["events"]
        self.assertEqual(events[0]["tenantId"], "acme")
        self.assertEqual(events[0]["metadata"]["sdk"], "python")
        self.assertEqual(events[0]["cacheReadTokens"], 40)
        self.assertEqual(events[1]["promptTokens"], 105)
        self.assertEqual(events[1]["cacheWriteTokens"], 5)
        self.assertGreater(events[0]["costUsd"], 0)
        self.assertEqual(client.stats().sent, 2)
        client.close()

    def test_retries_once_then_drops_without_raising(self):
        transport = CaptureTransport(failures=10)
        client = TraiceClient(
            "lm_live_test",
            batch_size=1,
            flush_interval=60,
            _transport=transport,
        )
        client.record(extract_usage({}), latency_ms=0)
        self.assertTrue(client.flush(1))
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(client.stats().dropped, 1)
        self.assertEqual(client.stats().failed_batches, 1)
        client.close()

    def test_enqueue_does_not_wait_for_slow_network(self):
        def slow_transport(url, body, headers, timeout):
            time.sleep(0.15)

        client = TraiceClient(
            "lm_live_test",
            batch_size=1,
            flush_interval=60,
            _transport=slow_transport,
        )
        started = time.perf_counter()
        client.record(extract_usage({}), latency_ms=0)
        self.assertLess(time.perf_counter() - started, 0.05)
        self.assertTrue(client.flush(1))
        client.close()

    def test_invalid_metadata_is_dropped_without_stopping_worker(self):
        transport = CaptureTransport()
        client = TraiceClient(
            "lm_live_test",
            batch_size=1,
            flush_interval=60,
            _transport=transport,
        )
        client.record(extract_usage({}), latency_ms=0, metadata={"invalid": object()})
        self.assertTrue(client.flush(1))
        self.assertEqual(client.stats().dropped, 1)

        client.record(extract_usage({}), latency_ms=0)
        self.assertTrue(client.flush(1))
        self.assertEqual(client.stats().sent, 1)
        client.close()


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.transport = CaptureTransport()
        traice.configure(
            "lm_live_test",
            batch_size=10,
            flush_interval=60,
            _transport=self.transport,
        )

    def tearDown(self):
        traice.shutdown()

    def test_sync_decorator_preserves_response_and_dimensions(self):
        @traice.track(feature="answer", tenant_id="acme", user_id="user_1")
        def call():
            return {
                "model": "gpt-4o-mini",
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            }

        response = call()
        self.assertEqual(response["model"], "gpt-4o-mini")
        traice.flush(1)
        event = self.transport.calls[0][1]["events"][0]
        self.assertEqual(event["feature"], "answer")
        self.assertEqual(event["tenantId"], "acme")
        self.assertEqual(event["userId"], "user_1")

    def test_async_decorator(self):
        @traice.track(feature="async-answer")
        async def call():
            await asyncio.sleep(0)
            return {
                "type": "message",
                "model": "claude-sonnet-4-20250514",
                "usage": {"input_tokens": 10, "output_tokens": 2},
            }

        asyncio.run(call())
        traice.flush(1)
        event = self.transport.calls[0][1]["events"][0]
        self.assertEqual(event["provider"], "anthropic")

    def test_context_manager_records_attached_response(self):
        with traice.track(feature="context") as span:
            span.record(
                {
                    "model": "gpt-4o-mini",
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2},
                }
            )
        traice.flush(1)
        self.assertEqual(self.transport.calls[0][1]["events"][0]["feature"], "context")

    def test_errors_are_recorded_and_re_raised(self):
        @traice.track(feature="failure")
        def call():
            raise RuntimeError("provider unavailable")

        with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
            call()
        traice.flush(1)
        event = self.transport.calls[0][1]["events"][0]
        self.assertEqual(event["status"], "error")
        self.assertEqual(event["metadata"]["errorMessage"], "provider unavailable")

    def test_langchain_handler_records_cache_tokens_and_run(self):
        handler = traice.TraiceCallbackHandler(feature="research", tenant_id="acme")
        handler.on_llm_start({}, ["question"], run_id="run_123")
        handler.on_llm_end(
            {
                "llm_output": {
                    "model": "claude-sonnet-4-20250514",
                    "token_usage": {
                        "input_tokens": 80,
                        "output_tokens": 10,
                        "cache_read_input_tokens": 20,
                        "cache_creation_input_tokens": 5,
                    },
                }
            },
            run_id="run_123",
        )
        traice.flush(1)
        event = self.transport.calls[0][1]["events"][0]
        self.assertEqual(event["provider"], "anthropic")
        self.assertEqual(event["promptTokens"], 105)
        self.assertEqual(event["cacheReadTokens"], 20)
        self.assertEqual(event["cacheWriteTokens"], 5)
        self.assertEqual(event["runId"], "run_123")


if __name__ == "__main__":
    unittest.main()
