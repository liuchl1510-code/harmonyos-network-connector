"""Copy fixed Xray-core module to a private stage and apply two audited hunks.

Never modifies the Go module cache. Rebuilding starts from upstream every time,
so a patched staging tree can be reused without double application.
"""

import hashlib
import json
from pathlib import Path
import shutil
import sys

source, destination = (Path(arg).resolve() for arg in sys.argv[1:3])
relative = Path("transport/internet/system_dialer.go")
patch_path = Path(__file__).with_name("0002-socket-controller-fail-closed.patch")
expected_sha256 = "56f537193a0e8c51231c91dc838bd637e7fb8fb8ae211c6adcce94c5c395ed85"
if source == destination or source in destination.parents or destination in source.parents:
    raise SystemExit("Core staging tree must be separate from the original module")
if destination.name != "stage-xray-core":
    raise SystemExit("Expected dedicated stage-xray-core destination")
original = (source / relative).read_bytes().replace(b"\r\n", b"\n")
if hashlib.sha256(original).hexdigest() != expected_sha256:
    raise SystemExit("Pinned system_dialer.go SHA256 mismatch; refusing patch")

patch_bytes = patch_path.read_bytes().replace(b"\r\n", b"\n")
lines = patch_bytes.decode("utf-8").splitlines(keepends=True)
starts = [index for index, line in enumerate(lines) if line.startswith("@@ ")]
if len(starts) != 2:
    raise SystemExit("Expected exactly two controller patch hunks")
text = original.decode("utf-8")
for position, start in enumerate(starts):
    end = starts[position + 1] if position + 1 < len(starts) else len(lines)
    hunk = lines[start + 1:end]
    old = "".join(line[1:] for line in hunk if line.startswith((" ", "-")))
    new = "".join(line[1:] for line in hunk if line.startswith((" ", "+")))
    if text.count(old) != 1:
        raise SystemExit(f"Controller hunk {position + 1} must match exactly once")
    text = text.replace(old, new, 1)

shutil.copytree(source, destination, dirs_exist_ok=True, copy_function=shutil.copyfile)
(destination / relative).write_text(text, encoding="utf-8", newline="\n")
if (source / relative).read_bytes().replace(b"\r\n", b"\n") != original:
    raise SystemExit("Original Go module cache changed unexpectedly")
evidence = {
    "file": "native/xray/patches/0002-socket-controller-fail-closed.patch",
    "sha256": hashlib.sha256(patch_bytes).hexdigest(),
    "upstream": "https://github.com/XTLS/Xray-core/blob/v1.250803.0/transport/internet/system_dialer.go",
    "originalSourceSha256LF": expected_sha256,
    "patchedSourceSha256LF": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    "hunkMatches": [1, 1],
    "reason": "Propagate external socket-controller errors from TCP Dialer.Control and UDP ListenConfig.Control; Go then closes its owned socket before connect/bind.",
    "moduleCacheUnmodified": True,
}
(destination / "harmony-patch-evidence.json").write_text(
    json.dumps(evidence, indent=2) + "\n", encoding="utf-8", newline="\n"
)
print("Applied audited Xray-core fail-closed controller patch to private stage")
