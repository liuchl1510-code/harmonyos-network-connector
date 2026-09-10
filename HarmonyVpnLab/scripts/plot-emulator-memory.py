"""Plot finalized emulator soak records without exposing device/process IDs.

Dependencies: an existing Python 3.10+ environment with Matplotlib and NumPy.
No package download, device operation, or application-source access is performed.
Example (PowerShell, using the already installed local Anaconda runtime):
  & "$env:USERPROFILE/anaconda3/python.exe" scripts/plot-emulator-memory.py `
    --cohort C3 --runs candidate-014-phone-navigation `
    candidate-014-phone-idle-after-partial candidate-014-phone-inspection-control `
    --output c3-phone-memory.png

Input: build/<phase>-soak/<run>/{summary.json,samples.jsonl} only.
Output: PNG and a numeric verification receipt under build/<phase>-analysis.
Defaults: --phase phase14 --device phone. Device is an explicit plot label.
Different package hashes or process births must be plotted in separate invocations.
An early producer completion is displayed as WINDOW SHORT, without altering its
original declared outcome. This plot does not replace inspect-emulator-soak.cjs.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys

ROOT = Path(__file__).resolve().parents[1]
INPUT_ROOT = ROOT / "build" / "phase14-soak"
OUTPUT_ROOT = ROOT / "build" / "phase14-analysis"
PHASES = ("phase14", "phase15")
DEVICES = {"phone": "phone", "tablet": "tablet", "pc": "PC"}
ACTIVITIES = {"navigation": "Navigation", "idle": "Idle", "inspection": "Layout inspection"}
OUTCOMES = {"completed", "failed", "stopped", "deadline-reached", "insufficient-observation"}
COLORS = {"navigation": "#c66030", "idle": "#238573", "inspection": "#3f6fba"}


class InvalidRecord(ValueError):
    """Use only fixed, non-sensitive messages in the CLI error path."""


def number(value, *, positive=False):
    valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    if not valid or not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise InvalidRecord("A required numeric measurement is invalid.")
    return float(value)


def optional_number(value):
    return None if value is None else number(value)


def utc(value):
    if not isinstance(value, str):
        raise InvalidRecord("A required UTC timestamp is missing.")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise InvalidRecord("Timestamps must include an explicit timezone.")
    return result.astimezone(timezone.utc)


def validate_run(name, summary, samples):
    if not isinstance(summary, dict) or not isinstance(samples, list) or len(samples) < 2:
        raise InvalidRecord("A final summary and at least two samples are required.")
    activity, outcome = summary.get("activity"), summary.get("outcome")
    if activity not in ACTIVITIES or outcome not in OUTCOMES:
        raise InvalidRecord("The activity or outcome is not supported.")
    if summary.get("sameProcess") is not True:
        raise InvalidRecord("The run does not claim a continuous process observation.")
    artifact = summary.get("artifactSHA256")
    if not isinstance(artifact, str) or not re.fullmatch(r"[a-f0-9]{64}", artifact):
        raise InvalidRecord("The package identity is missing or invalid.")
    target = summary.get("target")
    if not isinstance(target, str) or not re.fullmatch(r"127\.0\.0\.1:15\d{3}", target):
        raise InvalidRecord("The record is not bound to an explicit local emulator.")
    if summary.get("samples") != len(samples):
        raise InvalidRecord("The summary sample count does not match the JSONL file.")
    if not str(summary.get("version", "")).endswith("-ui-preview"):
        raise InvalidRecord("Only explicitly labelled UI preview records are accepted.")
    started, finished = utc(summary.get("startedAt")), utc(summary.get("finishedAt"))
    elapsed = number(summary.get("elapsedSeconds"), positive=True)
    if finished < started or abs((finished - started).total_seconds() - elapsed) > 2:
        raise InvalidRecord("The reported duration and wall-clock timestamps disagree.")
    first = samples[0]
    identity = (first.get("pid"), first.get("startTimeTicks"), artifact, target)
    for value in identity[:2]:
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise InvalidRecord("A numeric process identity is invalid.")
    rows = []
    previous = -1.0
    for sample in samples:
        if not isinstance(sample, dict):
            raise InvalidRecord("A sample is not a JSON object.")
        if (sample.get("pid"), sample.get("startTimeTicks"), sample.get("artifactSHA256"), target) != identity:
            raise InvalidRecord("Package or process identity changed inside a run.")
        seconds = number(sample.get("elapsedSeconds"))
        if seconds <= previous or seconds > elapsed + 0.02:
            raise InvalidRecord("Sample times are unordered or outside the run window.")
        previous = seconds
        breakdown = sample.get("memoryBreakdown")
        ark = native = None
        if isinstance(breakdown, dict) and breakdown.get("status") == "available":
            if breakdown.get("unit") != "KiB":
                raise InvalidRecord("Memory breakdown values must declare KiB.")
            ark = optional_number(breakdown.get("arkPrivateDirtyKiB"))
            native = optional_number(breakdown.get("nativePrivateDirtyKiB"))
        rows.append({"time": started + timedelta(seconds=seconds), "elapsed": seconds,
                     "rss": optional_number(sample.get("rssKiB")), "ark": ark, "native": native})
    observed = rows[-1]["elapsed"] - rows[0]["elapsed"]
    if abs(observed - number(summary.get("observedSeconds"))) > 0.025:
        raise InvalidRecord("The observed span does not match first and last samples.")
    requested = number(summary.get("requestedMinutes"), positive=True)
    duration_met = elapsed >= requested * 60
    display_status = ("WINDOW SHORT" if outcome == "completed" and not duration_met
                      else outcome.upper())
    if outcome == "completed":
        if summary.get("failure") is not None or summary.get("deadlineLimited") is True:
            raise InvalidRecord("A completed outcome conflicts with failure or deadline metadata.")
        if observed < requested * 60 - 20:
            raise InvalidRecord("A completed run does not have the required sample span.")
        if activity == "navigation" and number(summary.get("actions")) < 1:
            raise InvalidRecord("Completed navigation requires a navigation action.")
        if activity == "inspection" and number(summary.get("uiInspections")) < 1:
            raise InvalidRecord("Completed inspection requires an inspection sample.")
    if activity == "inspection" and number(summary.get("actions")) != 0:
        raise InvalidRecord("Inspection must not claim navigation actions.")
    intervals = [b["elapsed"] - a["elapsed"] for a, b in zip(rows, rows[1:])]
    return {"name": name, "activity": activity, "outcome": outcome, "started": started,
            "finished": finished, "elapsed": elapsed, "observed": observed, "rows": rows,
            "requested_minutes": requested, "requested_duration_met": duration_met,
            "display_status": display_status,
            "identity": identity, "gap_seconds": max(30.0, 2.5 * statistics.median(intervals)),
            "actions": summary.get("actions", 0), "uiInspections": summary.get("uiInspections")}


def phase_roots(phase):
    if phase not in PHASES:
        raise InvalidRecord("The requested observation phase is not supported.")
    return ROOT / "build" / f"{phase}-soak", ROOT / "build" / f"{phase}-analysis"


def load_run(name, phase="phase14"):
    input_root, _ = phase_roots(phase)
    if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
        raise InvalidRecord("Run names must be safe soak folder names.")
    directory = (input_root / name).resolve()
    if directory.parent != input_root.resolve():
        raise InvalidRecord("An input directory resolves outside the selected soak folder.")
    summary_path, samples_path = directory / "summary.json", directory / "samples.jsonl"
    if not summary_path.is_file():
        raise InvalidRecord("A requested run has no final summary; completion is unconfirmed.")
    for file in (summary_path, samples_path):
        if file.resolve().parent != directory:
            raise InvalidRecord("An input file resolves outside its run folder.")
    summary_bytes, sample_bytes = summary_path.read_bytes(), samples_path.read_bytes()
    summary = json.loads(summary_bytes.decode("utf-8-sig"))
    if not isinstance(summary, dict) or summary.get("phase", "phase14") != phase:
        raise InvalidRecord("The final summary does not belong to the selected phase.")
    samples = [json.loads(line) for line in sample_bytes.decode("utf-8-sig").splitlines() if line.strip()]
    result = validate_run(name, summary, samples)
    result["input_digests"] = {"summarySHA256": hashlib.sha256(summary_bytes).hexdigest(),
                               "samplesSHA256": hashlib.sha256(sample_bytes).hexdigest()}
    return result


def validate_cohort(runs):
    runs.sort(key=lambda run: run["started"])
    if any(run["identity"] != runs[0]["identity"] for run in runs):
        raise InvalidRecord("Different package hashes, targets, PIDs or process births cannot share this plot.")
    if any(a["finished"] > b["started"] for a, b in zip(runs, runs[1:])):
        raise InvalidRecord("Run windows overlap; sequential phase attribution is ambiguous.")


def rss_segments(run):
    segment, previous = [], None
    for row in run["rows"]:
        if row["rss"] is None or (previous is not None and (row["time"] - previous).total_seconds() > run["gap_seconds"]):
            if segment:
                yield segment
            segment = []
        if row["rss"] is not None:
            segment.append(row)
        previous = row["time"]
    if segment:
        yield segment


def figure_title(cohort, device, sequence):
    if device not in DEVICES:
        raise InvalidRecord("The requested device label is not supported.")
    title = "Sequential memory observations" if sequence else "Memory observations"
    return f"{cohort} {DEVICES[device]} preview | {title}"


def render(runs, cohort, output_name, phase="phase14", device="phone"):
    _, output_root = phase_roots(phase)
    title = figure_title(cohort, device, len(runs) > 1)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,100}\.png", output_name):
        raise InvalidRecord("Output must be a simple PNG filename.")
    output_root.mkdir(parents=True, exist_ok=True)
    os.environ["MPLCONFIGDIR"] = str(output_root / ".mpl-cache")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
                         "axes.spines.top": False, "axes.spines.right": False})
    fig, (rss_ax, dirty_ax) = plt.subplots(2, 1, figsize=(14.5, 9.2), sharex=True,
                                          gridspec_kw={"height_ratios": [1.1, 1]})
    fig.subplots_adjust(left=.09, right=.975, top=.82, bottom=.17, hspace=.18)
    sequence = len(runs) > 1
    fig.suptitle(title, x=.09, y=.965,
                 ha="left", fontsize=19, fontweight="bold")
    identity_note = ("Same emulator, process birth and package verified across these phases." if sequence
                     else "Process birth and package verified across all samples in this run.")
    fig.text(.09, .927, identity_note,
             fontsize=11, color="#475569")
    sequence_note = ("Sequential observations from one process; this is not a randomized comparison." if sequence
                     else "One run, one process and one package; original observation timestamps are preserved.")
    fig.text(.09, .899, sequence_note,
             fontsize=10, color="#64748b")
    for index, run in enumerate(runs):
        color = COLORS[run["activity"]]
        for ax in (rss_ax, dirty_ax):
            ax.axvspan(run["started"], run["finished"], color=color, alpha=.045, zorder=0)
        for segment in rss_segments(run):
            rss_ax.plot([row["time"] for row in segment], [row["rss"] / 1024 for row in segment],
                        color=color, linewidth=1.9, marker=".", markersize=2.8)
        for key, marker, metric_color in (("ark", "^", "#7654a1"), ("native", "o", "#167c80")):
            measured = [row for row in run["rows"] if row[key] is not None]
            dirty_ax.scatter([row["time"] for row in measured], [row[key] / 1024 for row in measured],
                             marker=marker, s=25, color=metric_color, edgecolors="white", linewidths=.35,
                             label=("Ark private dirty" if key == "ark" else "Native private dirty") if index == 0 else None)
        midpoint = run["started"] + (run["finished"] - run["started"]) / 2
        status = run["display_status"]
        rss_ax.text(midpoint, 1.025, f"{ACTIVITIES[run['activity']]} | {status}\n"
                    f"window {run['elapsed']/60:.2f} min / sampled {run['observed']/60:.2f} min"
                    f" / requested {run['requested_minutes']:g} min",
                    transform=rss_ax.get_xaxis_transform(), ha="center", va="bottom", fontsize=9,
                    color=color, linespacing=1.45)
        if run["outcome"] == "failed":
            for ax in (rss_ax, dirty_ax):
                ax.axvline(run["finished"], color="#ba433e", linestyle="--", linewidth=1, alpha=.85)
            rss_ax.annotate(f"Failed at {run['elapsed']/60:.2f} min\nNo samples after the last marker",
                            (run["finished"], .86), xycoords=("data", "axes fraction"),
                            xytext=(-10, -43), textcoords="offset points", ha="right", fontsize=9,
                            color="#a23a37", arrowprops={"arrowstyle": "-", "color": "#a23a37"})
    for ax in (rss_ax, dirty_ax):
        ax.grid(axis="y", color="#cbd5e1", alpha=.55, linewidth=.65)
        ax.margins(x=.015, y=.13)
        ax.tick_params(colors="#475569")
    rss_ax.set_ylabel("Process RSS (MiB)")
    dirty_ax.set_ylabel("Private dirty memory (MiB)")
    dirty_ax.legend(loc="upper left", ncol=2, frameon=False, fontsize=10)
    locator = mdates.AutoDateLocator(minticks=7, maxticks=13)
    dirty_ax.xaxis.set_major_locator(locator)
    dirty_ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=timezone.utc))
    dirty_ax.set_xlabel(f"UTC on {runs[0]['started'].date().isoformat()}  |  startedAt + sample.elapsedSeconds", labelpad=9)
    fig.text(.09, .091, "Blank intervals stay blank. RSS lines stop at phase boundaries, missing values and large sampling gaps.", fontsize=10, color="#475569")
    fig.text(.09, .063, "Private-dirty markers show only actual measurements (KiB / 1024). No forced-GC or leak-cause inference is made.", fontsize=10, color="#475569")
    png = output_root / output_name
    if png.resolve().parent != output_root.resolve() or png.with_suffix(".verification.json").resolve().parent != output_root.resolve():
        raise InvalidRecord("An output file resolves outside the selected analysis folder.")
    fig.savefig(png, dpi=170, facecolor="white", metadata={"Title": f"{cohort} {DEVICES[device]} emulator memory observations"})
    plt.close(fig)
    receipt = {"cohort": cohort, "phase": phase, "device": device,
               "deviceLabelSource": "explicit-cli-label", "samePackageProcessBirthAndTargetVerified": True,
               "alignment": "UTC summary.startedAt plus numeric sample.elapsedSeconds",
               "rssGapPolicy": "Separate each phase; break missing values or gaps over max(30 s, 2.5 times median interval)",
               "privateDirtyPolicy": "Actual sampled markers only; never replace missing data with zero",
               "rawDeviceOrProcessIdentifiersPublished": False, "matplotlibVersion": matplotlib.__version__,
               "figure": output_name, "figureSHA256": hashlib.sha256(png.read_bytes()).hexdigest(), "runs": []}
    for run in runs:
        receipt["runs"].append({"folder": run["name"], "activity": run["activity"], "outcome": run["outcome"],
                                "outcomeSource": "original-producer-summary", "displayStatus": run["display_status"],
                                "requestedMinutes": run["requested_minutes"], "requestedDurationMet": run["requested_duration_met"],
                                "startedAtUtc": run["started"].isoformat(), "finishedAtUtc": run["finished"].isoformat(),
                                "windowMinutes": run["elapsed"] / 60, "sampleSpanMinutes": run["observed"] / 60,
                                "sampleCount": len(run["rows"]), "actions": run["actions"], "uiInspections": run["uiInspections"],
                                "rssGapThresholdSeconds": run["gap_seconds"], **run["input_digests"]})
    png.with_suffix(".verification.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"figure": str(png), "verification": str(png.with_suffix('.verification.json')),
                      "runs": len(runs), "sameIdentityVerified": True}))


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cohort", required=True, choices=[f"C{i}" for i in range(1, 100)])
    parser.add_argument("--runs", required=True, nargs="+")
    parser.add_argument("--output", required=True)
    parser.add_argument("--phase", choices=PHASES, default="phase14")
    parser.add_argument("--device", choices=DEVICES, default="phone")
    return parser.parse_args(argv)


def main():
    args = parse_arguments()
    if len(set(args.runs)) != len(args.runs):
        raise InvalidRecord("Duplicate run names are not allowed.")
    runs = [load_run(name, args.phase) for name in args.runs]
    validate_cohort(runs)
    render(runs, args.cohort, args.output, args.phase, args.device)


if __name__ == "__main__":
    try:
        main()
    except (InvalidRecord, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        print("Memory plot refused: records are incomplete, inconsistent or unavailable; no source payload is printed.", file=sys.stderr)
        sys.exit(1)
