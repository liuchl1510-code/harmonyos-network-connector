#!/usr/bin/env python3
"""Summarize completed, sanitized process observations; never contact a device.

Usage: python scripts/summarize-device-stability.py build/stability/<runId>
       python scripts/summarize-device-stability.py --self-test

Input files remain unchanged. Output is analysis.json plus analysis.png when an
already installed matplotlib is available. Incomplete runs produce no analysis.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone
import uuid

ROLES = ("service", "ui")
ASSUMED_HZ = 100
TREND_WINDOW_MINUTES = 20


class AnalysisError(Exception):
    """Fixed error codes avoid echoing unexpected input contents."""


def number(value, code="INVALID_NUMERIC_SAMPLE", *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise AnalysisError(code)
    if integer and int(value) != value:
        raise AnalysisError(code)
    return value


def utc_stamp(text):
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError
        return value.astimezone(timezone.utc)
    except (TypeError, AttributeError, ValueError):
        raise AnalysisError("INVALID_WALL_TIMESTAMP") from None


def observed_range(values):
    valid = [value for value in values if value is not None]
    return {"first": values[0] if values else None, "last": values[-1] if values else None,
            "min": min(valid) if valid else None, "max": max(valid) if valid else None,
            "availableSamples": len(valid), "unavailableSamples": len(values) - len(valid)}


def rss_trend(rows, identity_consistent):
    if not identity_consistent:
        return {"available": False, "reason": "process_identity_changed", "requestedWindowMinutes": TREND_WINDOW_MINUTES}
    last = rows[-1]["observedAtMs"]
    threshold = last - TREND_WINDOW_MINUTES * 60000
    tail = [row for row in rows if row["observedAtMs"] >= threshold]
    if len(tail) < 2 or tail[-1]["observedAtMs"] <= tail[0]["observedAtMs"]:
        return {"available": False, "reason": "insufficient_samples", "requestedWindowMinutes": TREND_WINDOW_MINUTES}
    xs = [(row["observedAtMs"] - tail[0]["observedAtMs"]) / 60000 for row in tail]
    ys = [row["rssKiB"] for row in tail]
    x_mean, y_mean = sum(xs) / len(xs), sum(ys) / len(ys)
    denominator = sum((x - x_mean) ** 2 for x in xs)
    slope = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys)) / denominator
    return {"available": True, "method": "ordinary_least_squares_rss_against_actual_observation_minutes",
            "requestedWindowMinutes": TREND_WINDOW_MINUTES, "samples": len(tail),
            "firstObservedAtMs": tail[0]["observedAtMs"], "lastObservedAtMs": tail[-1]["observedAtMs"],
            "actualCoverageMinutes": xs[-1], "fullRequestedWindowCovered": xs[-1] >= TREND_WINDOW_MINUTES - 1e-9,
            "firstRssKiB": ys[0], "lastRssKiB": ys[-1], "netChangeKiB": ys[-1] - ys[0],
            "slopeKiBPerMinute": slope, "slopeMiBPerMinute": slope / 1024,
            "interpretation": "descriptive_trend_only_not_a_memory_leak_test_or_conclusion"}


def analyze(summary, samples):
    if not isinstance(summary, dict) or summary.get("status") != "completed":
        raise AnalysisError("RUN_NOT_COMPLETED")
    if summary.get("failure") is not None:
        raise AnalysisError("COMPLETED_SUMMARY_HAS_FAILURE")
    if summary.get("cpuClock", {}).get("ticksPerSecond") != ASSUMED_HZ:
        raise AnalysisError("CPU_CLOCK_ASSUMPTION_MISMATCH")
    if not samples or summary.get("samples") != len(samples):
        raise AnalysisError("SAMPLE_COUNT_MISMATCH")
    if any(not isinstance(item, dict) or item.get("kind") != "sample" for item in samples):
        raise AnalysisError("NON_SAMPLE_ENTRY")
    if [row.get("index") for row in samples] != list(range(len(samples))):
        raise AnalysisError("SAMPLE_INDEX_MISMATCH")
    number(summary.get("actualElapsedSeconds"))
    number(summary.get("scheduledDurationSeconds"))
    first_wall, last_wall = utc_stamp(samples[0]["recordedAt"]), utc_stamp(samples[-1]["recordedAt"])
    sample_elapsed = [number(row.get("elapsedMs")) for row in samples]
    if any(right <= left for left, right in zip(sample_elapsed, sample_elapsed[1:])):
        raise AnalysisError("SAMPLE_CLOCK_NOT_INCREASING")
    processes = {}
    for role in ROLES:
        try:
            rows = [row["processes"][role] for row in samples]
        except (KeyError, TypeError):
            raise AnalysisError("PROCESS_ROLE_MISSING") from None
        for row in rows:
            for key in ("pid", "startTimeTicks", "userTicks", "systemTicks", "totalTicks", "rssKiB", "threads"):
                number(row.get(key), integer=True)
            number(row.get("observedAtMs"))
            if row["fdCount"] is not None:
                number(row["fdCount"], integer=True)
            if row["userTicks"] + row["systemTicks"] != row["totalTicks"]:
                raise AnalysisError("CPU_TICK_TOTAL_MISMATCH")
        times = [row["observedAtMs"] for row in rows]
        if any(right <= left for left, right in zip(times, times[1:])):
            raise AnalysisError("PROCESS_CLOCK_NOT_INCREASING")
        identities = {(row["pid"], row["startTimeTicks"]) for row in rows}
        consistent = len(identities) == 1
        intervals = []
        for before, after in zip(rows, rows[1:]):
            if (before["pid"], before["startTimeTicks"]) != (after["pid"], after["startTimeTicks"]):
                intervals.append(None)
                continue
            delta = after["totalTicks"] - before["totalTicks"]
            if delta < 0:
                raise AnalysisError("CPU_TICKS_DECREASED_WITH_SAME_PROCESS")
            seconds = (after["observedAtMs"] - before["observedAtMs"]) / 1000
            intervals.append(100 * delta / ASSUMED_HZ / seconds)
        observation_seconds = (times[-1] - times[0]) / 1000
        total_delta = rows[-1]["totalTicks"] - rows[0]["totalTicks"] if consistent else None
        cpu_mean = 100 * total_delta / ASSUMED_HZ / observation_seconds if consistent and observation_seconds > 0 else None
        processes[role] = {
            "samples": len(rows), "firstPid": rows[0]["pid"], "lastPid": rows[-1]["pid"],
            "firstStartTimeTicks": rows[0]["startTimeTicks"], "lastStartTimeTicks": rows[-1]["startTimeTicks"],
            "processIdentityConsistent": consistent, "observedIdentityCount": len(identities),
            "firstObservedAtMs": times[0], "lastObservedAtMs": times[-1], "observationSeconds": observation_seconds,
            "totalTicks": {"first": rows[0]["totalTicks"], "last": rows[-1]["totalTicks"], "deltaSameProcess": total_delta},
            "cpuPercentSingleCoreAssumingHz100": {"weightedWholeWindowMean": cpu_mean,
                "intervalRange": observed_range(intervals), "source": "recomputed_from_total_ticks_and_actual_observation_intervals"},
            "rssKiB": observed_range([row["rssKiB"] for row in rows]),
            "rssNetChangeKiB": rows[-1]["rssKiB"] - rows[0]["rssKiB"],
            "threads": observed_range([row["threads"] for row in rows]),
            "fdCount": observed_range([row["fdCount"] for row in rows]),
            "fdCategories": sorted({row["fdCategory"] for row in rows}),
            "last20MinutesRssTrend": rss_trend(rows, consistent)}
    return {"schemaVersion": 1, "runId": summary.get("runId"), "inputStatus": "completed", "samples": len(samples),
            "firstSampleRecordedAt": samples[0]["recordedAt"], "lastSampleRecordedAt": samples[-1]["recordedAt"],
            "wallClockSampleSpanSeconds": (last_wall - first_wall).total_seconds(),
            "monotonicSampleSpanSeconds": (sample_elapsed[-1] - sample_elapsed[0]) / 1000,
            "collectorScheduledDurationSeconds": summary["scheduledDurationSeconds"],
            "collectorActualElapsedSeconds": summary["actualElapsedSeconds"],
            "cpuClock": {"assumedTicksPerSecond": ASSUMED_HZ, "measuredByThisScript": False,
                "percentBasis": "one_cpu_core_equals_100_percent_multithread_process_can_exceed_100"},
            "allProcessIdentitiesConsistent": all(value["processIdentityConsistent"] for value in processes.values()),
            "processes": processes,
            "limitations": ["Only a completed collector run is accepted; sample span and collector elapsed time differ by observation overhead.",
                "CPU is conditional on the 100 ticks per second assumption and uses host monotonic process-observation intervals.",
                "RSS is resident memory, not live allocations; short positive or negative RSS trends do not diagnose or exclude a memory leak.",
                "The last-20-minute fit uses only observed points in that trailing interval and reports their actual coverage; no interpolation is invented.",
                "FD unavailable/null does not mean zero; process restart invalidates a whole-process CPU mean and RSS trend.",
                "Process observations alone do not prove network connectivity, battery use or long-term reliability."]}


def load_completed(directory):
    summary_path = directory / "summary.json"
    if not summary_path.is_file():
        raise AnalysisError("SUMMARY_MISSING_RUN_NOT_COMPLETED")
    try:
        summary_bytes = summary_path.read_bytes()
        summary = json.loads(summary_bytes)
    except (OSError, ValueError):
        raise AnalysisError("SUMMARY_READ_FAILED") from None
    if not isinstance(summary, dict) or summary.get("status") != "completed":
        raise AnalysisError("RUN_NOT_COMPLETED")
    try:
        sample_bytes = (directory / "samples.jsonl").read_bytes()
        samples = [json.loads(line) for line in sample_bytes.decode("utf-8").splitlines() if line.strip()]
        report = analyze(summary, samples)
    except AnalysisError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        raise AnalysisError("SAMPLE_READ_OR_STRUCTURE_FAILED") from None
    report["inputSHA256"] = {"summary.json": hashlib.sha256(summary_bytes).hexdigest(),
                             "samples.jsonl": hashlib.sha256(sample_bytes).hexdigest()}
    return report, samples


def atomic_json(destination, value):
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def optional_plot(directory, report, samples, disabled=False):
    if disabled:
        return {"status": "disabled"}
    if importlib.util.find_spec("matplotlib") is None:
        return {"status": "unavailable", "reason": "matplotlib_not_installed_no_install_attempted"}
    temporary = directory / ("analysis." + uuid.uuid4().hex + ".tmp.png")
    figure = None
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        figure, axes = plt.subplots(1, 2, figsize=(11, 4.2), constrained_layout=True)
        colors = {"service": "#1967b3", "ui": "#ca6500"}
        for role in ROLES:
            rows = [sample["processes"][role] for sample in samples]
            times = [row["observedAtMs"] / 60000 for row in rows]
            cpus = []
            for before, after in zip(rows, rows[1:]):
                same = (before["pid"], before["startTimeTicks"]) == (after["pid"], after["startTimeTicks"])
                seconds = (after["observedAtMs"] - before["observedAtMs"]) / 1000
                cpus.append(100 * (after["totalTicks"] - before["totalTicks"]) / ASSUMED_HZ / seconds if same else math.nan)
            axes[0].plot(times[1:], cpus, color=colors[role], label=role, linewidth=1.3)
            axes[1].plot(times, [row["rssKiB"] / 1024 for row in rows], color=colors[role], label=role, linewidth=1.3)
        axes[0].set_ylabel("CPU (% of one core; assumed 100 ticks/s)")
        axes[1].set_ylabel("Resident memory (MiB)")
        for axis in axes:
            axis.set_xlabel("Actual observation time from collection start (min)")
            axis.grid(True, alpha=0.22)
            axis.legend()
        figure.suptitle("Completed VPN process observations — descriptive resource sample")
        figure.savefig(temporary, dpi=160)
        temporary.replace(directory / "analysis.png")
        return {"status": "created", "file": "analysis.png"}
    except Exception:
        return {"status": "unavailable", "reason": "optional_plot_failed_no_input_data_changed"}
    finally:
        if figure is not None:
            plt.close(figure)
        if temporary.exists():
            temporary.unlink()


def synthetic_fixture(minutes=30):
    start = datetime(2026, 9, 8, 12, tzinfo=timezone.utc)
    samples = []
    for index in range(minutes * 2 + 1):
        elapsed = index * 30000
        processes = {}
        for role, pid, offset, tick_step, base_rss, rss_step in (
                ("service", 123, 500, 60, 100000, 1), ("ui", 124, 1000, 30, 200000, 0)):
            total = 100 + index * tick_step
            processes[role] = {"pid": pid, "startTimeTicks": 2000 + pid, "userTicks": total - 10,
                "systemTicks": 10, "totalTicks": total, "observedAtMs": elapsed + offset,
                "rssKiB": base_rss + index * rss_step, "threads": 20, "fdCount": None, "fdCategory": "unavailable_permission"}
        samples.append({"kind": "sample", "index": index, "recordedAt": (start + timedelta(milliseconds=elapsed)).isoformat(),
                        "elapsedMs": elapsed, "processes": processes})
    summary = {"status": "completed", "failure": None, "runId": "1789000000000", "samples": len(samples),
               "actualElapsedSeconds": minutes * 60 + 1.2, "scheduledDurationSeconds": minutes * 60,
               "cpuClock": {"ticksPerSecond": 100}}
    return summary, samples


def self_test():
    fixture_root = Path(__file__).resolve().parents[1] / "build" / "stability-analysis-selftest"
    fixture_root.mkdir(parents=True, exist_ok=True)
    results = []

    def check(name, callback):
        try:
            callback()
            results.append({"name": name, "passed": True})
        except Exception:
            results.append({"name": name, "passed": False})

    def expect_error(code, callback):
        try:
            callback()
        except AnalysisError as error:
            assert str(error) == code
        else:
            raise AssertionError("expected rejection")

    def completed_case():
        summary, samples = synthetic_fixture()
        directory = fixture_root / "completed"
        directory.mkdir(exist_ok=True)
        atomic_json(directory / "summary.json", summary)
        (directory / "samples.jsonl").write_text("".join(json.dumps(row) + "\n" for row in samples), encoding="utf-8")
        before = {name: (directory / name).read_bytes() for name in ("summary.json", "samples.jsonl")}
        report, loaded = load_completed(directory)
        service = report["processes"]["service"]
        assert len(loaded) == 61 and report["monotonicSampleSpanSeconds"] == 1800
        assert service["cpuPercentSingleCoreAssumingHz100"]["weightedWholeWindowMean"] == 2
        assert service["rssKiB"] == {"first": 100000, "last": 100060, "min": 100000, "max": 100060, "availableSamples": 61, "unavailableSamples": 0}
        assert service["last20MinutesRssTrend"]["slopeKiBPerMinute"] == 2
        assert service["last20MinutesRssTrend"]["samples"] == 41
        assert service["last20MinutesRssTrend"]["actualCoverageMinutes"] == 20
        assert service["fdCount"]["first"] is None and service["fdCount"]["unavailableSamples"] == 61
        assert report["allProcessIdentitiesConsistent"] is True
        atomic_json(directory / "analysis.json", report)
        assert all((directory / name).read_bytes() == content for name, content in before.items())

    check("completed fixture yields exact CPU, RSS, 20-minute slope and unchanged inputs", completed_case)
    for status in ("running", "failed", "interrupted"):
        def incomplete_case(value=status):
            summary, samples = synthetic_fixture()
            summary["status"] = value
            expect_error("RUN_NOT_COMPLETED", lambda: analyze(summary, samples))
        check("refuse " + status + " summary", incomplete_case)
    missing = fixture_root / "missing-summary"
    missing.mkdir(exist_ok=True)
    check("refuse a missing summary before reading any sample", lambda: expect_error("SUMMARY_MISSING_RUN_NOT_COMPLETED", lambda: load_completed(missing)))

    def short_case():
        summary, samples = synthetic_fixture(5)
        trend = analyze(summary, samples)["processes"]["service"]["last20MinutesRssTrend"]
        assert trend["actualCoverageMinutes"] == 5 and not trend["fullRequestedWindowCovered"]
        assert trend["slopeKiBPerMinute"] == 2
    check("short completed window reports its actual five-minute coverage", short_case)

    def changed_identity():
        summary, samples = synthetic_fixture()
        samples[-1]["processes"]["service"]["startTimeTicks"] += 1
        report = analyze(summary, samples)
        service = report["processes"]["service"]
        assert not report["allProcessIdentitiesConsistent"]
        assert service["cpuPercentSingleCoreAssumingHz100"]["weightedWholeWindowMean"] is None
        assert service["last20MinutesRssTrend"]["reason"] == "process_identity_changed"
    check("PID start-tick change invalidates aggregate CPU and RSS fit", changed_identity)

    for name, code, mutate in (
            ("sample count mismatch", "SAMPLE_COUNT_MISMATCH", lambda summary, samples: summary.update(samples=99)),
            ("CPU assumption changed", "CPU_CLOCK_ASSUMPTION_MISMATCH", lambda summary, samples: summary["cpuClock"].update(ticksPerSecond=250)),
            ("failure attached to completed summary", "COMPLETED_SUMMARY_HAS_FAILURE", lambda summary, samples: summary.update(failure={"code": "synthetic"})),
            ("duplicated observation time", "PROCESS_CLOCK_NOT_INCREASING", lambda summary, samples: samples[1]["processes"]["service"].update(observedAtMs=500))):
        def invalid_case(change=mutate, expected=code):
            summary, samples = synthetic_fixture()
            change(summary, samples)
            expect_error(expected, lambda: analyze(summary, samples))
        check(name, invalid_case)
    passed = sum(item["passed"] for item in results)
    report = {"scope": "synthetic fixtures only; no live collection, device or private files", "passed": passed,
              "failed": len(results) - passed, "total": len(results), "results": results}
    atomic_json(fixture_root / "verification.json", report)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if passed == len(results) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path)
    parser.add_argument("--no-plot", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.directory is None:
        parser.error("directory is required unless --self-test is used")
    directory = args.directory.resolve()
    try:
        report, samples = load_completed(directory)
        report["plot"] = optional_plot(directory, report, samples, args.no_plot)
        atomic_json(directory / "analysis.json", report)
    except AnalysisError as error:
        print(json.dumps({"status": "refused", "code": str(error), "finalAnalysisWritten": False}), file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError):
        print(json.dumps({"status": "failed", "code": "ANALYSIS_OUTPUT_FAILED"}), file=sys.stderr)
        return 2
    print(json.dumps({"status": "completed", "samples": report["samples"], "inputStatus": report["inputStatus"],
                      "allProcessIdentitiesConsistent": report["allProcessIdentitiesConsistent"],
                      "analysis": str(directory / "analysis.json"), "plot": report["plot"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
