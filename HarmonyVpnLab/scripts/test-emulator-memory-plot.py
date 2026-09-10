"""Check that plot labels preserve the distinction between duration and outcome.

Uses only synthetic records and the Python standard library; no emulator or
Matplotlib import is needed. Run: python scripts/test-emulator-memory-plot.py
"""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "memory_plot", Path(__file__).with_name("plot-emulator-memory.py"))
PLOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLOT)


def fixture(elapsed, outcome="completed", span=45):
    started = datetime(2026, 1, 1, tzinfo=timezone.utc)
    summary = {"activity": "idle", "outcome": outcome, "sameProcess": True,
               "artifactSHA256": "a" * 64, "target": "127.0.0.1:15558",
               "samples": 2, "version": "0.14.0-ui-preview",
               "startedAt": started.isoformat(),
               "finishedAt": (started + timedelta(seconds=elapsed)).isoformat(),
               "elapsedSeconds": elapsed, "observedSeconds": span,
               "requestedMinutes": 1, "actions": 0}
    samples = [{"pid": 42, "startTimeTicks": 100,
                "artifactSHA256": "a" * 64, "elapsedSeconds": seconds,
                "rssKiB": 200_000} for seconds in (3, 3 + span)]
    return summary, samples


class CompletionLabels(unittest.TestCase):
    def test_early_completion_keeps_original_outcome_but_never_labels_completed(self):
        for elapsed in (57.5, 59.999):
            with self.subTest(elapsed=elapsed):
                run = PLOT.validate_run("synthetic", *fixture(elapsed))
                self.assertEqual(run["outcome"], "completed")
                self.assertEqual(run["display_status"], "WINDOW SHORT")
                self.assertFalse(run["requested_duration_met"])

    def test_exact_duration_can_display_completed(self):
        run = PLOT.validate_run("synthetic", *fixture(60))
        self.assertEqual(run["display_status"], "COMPLETED")
        self.assertTrue(run["requested_duration_met"])

    def test_elapsed_time_does_not_replace_required_sample_span(self):
        with self.assertRaises(PLOT.InvalidRecord):
            PLOT.validate_run("synthetic", *fixture(60, span=30))

    def test_failure_is_preserved_even_when_window_is_short(self):
        run = PLOT.validate_run("synthetic", *fixture(57.5, "failed"))
        self.assertEqual(run["display_status"], "FAILED")
        self.assertFalse(run["requested_duration_met"])

    def test_stop_at_full_duration_is_not_completion(self):
        run = PLOT.validate_run("synthetic", *fixture(60, "stopped"))
        self.assertEqual(run["display_status"], "STOPPED")
        self.assertTrue(run["requested_duration_met"])


if __name__ == "__main__":
    unittest.main()
