"""Record actual linked Go dependencies and their available root license files."""

import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--verification", type=Path, required=True)
parser.add_argument("--module-cache", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()

verification = json.loads(args.verification.read_text(encoding="utf-8-sig"))
args.output.mkdir(parents=True, exist_ok=True)
inventory = []
module_info = verification.get("moduleInfo")
if module_info is None:
    module_info = Path(verification["moduleInfoPath"]).read_text(encoding="utf-8-sig")
for line in module_info.splitlines():
    fields = line.strip().split("\t")
    if len(fields) < 3 or fields[0] != "dep":
        continue
    module, version = fields[1:3]
    # Go module cache escapes uppercase characters as ! followed by lowercase.
    escaped = "".join("!" + c.lower() if c.isupper() else c for c in module)
    module_dir = args.module_cache / f"{escaped}@{version}"
    record = {"module": module, "version": version, "goSum": fields[3] if len(fields) > 3 else None, "licenses": []}
    if module == "github.com/xtls/xray-core" and verification.get("xrayCore", {}).get("patchedReplacement"):
        # Publish the reproducible build-relative location, not a personal path.
        record["localReplacement"] = "${BuildRoot}/stage-xray-core"
        record["patches"] = [p["file"] for p in verification.get("patches", []) if "socket-controller" in p["file"]]
    candidates = sorted(
        path for path in module_dir.iterdir()
        if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE", "COPYRIGHT"))
    )
    for source in candidates:
        destination = args.output / (module.replace("/", "_") + "__" + source.name)
        data = source.read_bytes()
        destination.write_bytes(data)
        record["licenses"].append({"file": destination.name, "sha256": hashlib.sha256(data).hexdigest()})
    inventory.append(record)

(args.output / "dependency-inventory.json").write_text(
    json.dumps({"artifactSha256": verification["output"]["sha256"], "dependencies": inventory}, indent=2) + "\n",
    encoding="utf-8",
)
missing = [r["module"] for r in inventory if not r["licenses"]]
print(f"Collected root license notices for {len(inventory) - len(missing)}/{len(inventory)} linked modules.")
if missing:
    raise SystemExit("Missing license notice requires review: " + ", ".join(missing))
