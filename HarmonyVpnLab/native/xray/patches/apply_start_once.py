"""Apply one audited hunk to the pinned libXray staging copy only."""

import hashlib
from pathlib import Path
import sys

source_path = Path(sys.argv[1]) / "xray" / "xray.go"
patch_path = Path(__file__).with_name("0001-run-json-start-once.patch")
original = source_path.read_bytes().replace(b"\r\n", b"\n")
expected_sha256 = "d558e729b91600b663cddfea9ed93620bcd1d3ec60754a1327dea3154898f8e9"
if hashlib.sha256(original).hexdigest() != expected_sha256:
    raise SystemExit("Pinned xray/xray.go source SHA256 mismatch; refusing patch")

lines = patch_path.read_text(encoding="utf-8").splitlines(keepends=True)
if sum(line.startswith("@@ ") for line in lines) != 1:
    raise SystemExit("Expected exactly one patch hunk")
hunk_start = next(i for i, line in enumerate(lines) if line.startswith("@@ ")) + 1
old = "".join(line[1:] for line in lines[hunk_start:] if line.startswith((" ", "-")))
new = "".join(line[1:] for line in lines[hunk_start:] if line.startswith((" ", "+")))
text = original.decode("utf-8")
if text.count(old) != 1:
    raise SystemExit("Expected function pattern must occur exactly once; refusing patch")
source_path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
print("Applied audited libXray JSON single-start patch")
