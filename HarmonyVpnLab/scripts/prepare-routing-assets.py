#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify or reproduce the pinned v2rayN whitelist's unmodified GeoData records.

Only Python's standard library is required. ``verify`` is offline and read-only.
``prepare`` verifies complete upstream files before atomically replacing assets.
"""

import argparse
import hashlib
import json
import re
import tempfile
import unittest
import urllib.request
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
LOCK = PROJECT / "rules" / "sources.lock.json"
ASSETS = PROJECT / "entry" / "src" / "main" / "resources" / "rawfile"
MAX_SOURCE_BYTES = 32 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_varint(data, offset):
    value = 0
    for index in range(10):
        if offset >= len(data):
            raise ValueError("truncated protobuf varint")
        byte = data[offset]
        offset += 1
        if index == 9 and byte > 1:
            raise ValueError("protobuf varint exceeds uint64")
        value |= (byte & 127) << (index * 7)
        if byte < 128:
            return value, offset
    raise ValueError("unterminated protobuf varint")


def fields(data):
    """Yield field, wire type, payload and complete encoded bytes, without re-encoding."""
    offset = 0
    while offset < len(data):
        start = offset
        key, offset = read_varint(data, offset)
        field, wire = key >> 3, key & 7
        if field == 0 or field > (1 << 29) - 1:
            raise ValueError("invalid protobuf field number")
        if wire == 0:
            value, offset = read_varint(data, offset)
        elif wire in (1, 2, 5):
            if wire == 2:
                size, offset = read_varint(data, offset)
            else:
                size = 8 if wire == 1 else 4
            if size > len(data) - offset:
                raise ValueError("truncated protobuf field")
            value = data[offset:offset + size]
            offset += size
        else:
            raise ValueError("unsupported protobuf wire type")
        yield field, wire, value, data[start:offset]


def categories(data):
    """Read GeoIPList/GeoSiteList, rejecting missing or duplicate category codes."""
    seen = set()
    result = []
    for field, wire, payload, raw in fields(data):
        if field != 1 or wire != 2:
            raise ValueError("GeoData top level must contain repeated message field 1")
        messages = list(fields(payload))
        codes = [value for number, kind, value, _ in messages if number == 1 and kind == 2]
        if len(codes) != 1:
            raise ValueError("GeoData entry must contain exactly one category code")
        try:
            code = codes[0].decode("ascii")
        except UnicodeDecodeError as error:
            raise ValueError("non-ASCII category code") from error
        if not re.fullmatch(r"[A-Z0-9_!@.\-]+", code):
            raise ValueError("invalid category code")
        if code in seen:
            raise ValueError("duplicate GeoData category: " + code)
        seen.add(code)
        records = [value for number, kind, value, _ in messages if number == 2 and kind == 2]
        for record in records:
            list(fields(record))  # Validate nested wire boundaries; preserve all fields.
        result.append({"category": code, "items": len(records), "raw": raw})
    if not result:
        raise ValueError("empty GeoData file")
    return result


def extract(data, wanted):
    wanted = set(wanted)
    if not wanted:
        raise ValueError("empty selection")
    selected = [item for item in categories(data) if item["category"] in wanted]
    if {item["category"] for item in selected} != wanted:
        raise ValueError("required GeoData category missing")
    return b"".join(item["raw"] for item in selected)


def check_bytes(data, expected, label):
    if len(data) != expected["bytes"] or digest(data) != expected["sha256"]:
        raise ValueError(label + ": size or SHA-256 mismatch")


def check_subset(data, spec):
    check_bytes(data, spec["output"], spec["name"])
    actual = categories(data)
    expected = spec["entries"]
    if [entry["category"] for entry in actual] != [entry["category"] for entry in expected]:
        raise ValueError(spec["name"] + ": category order mismatch")
    for item, locked in zip(actual, expected):
        if item["items"] != locked["items"] or digest(item["raw"]) != locked["entrySha256"]:
            raise ValueError(spec["name"] + ": category bytes or record count mismatch")


def load_lock():
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    if lock["schemaVersion"] != 1:
        raise ValueError("unsupported lock format")
    if [item["name"] for item in lock["assets"]] != ["geoip.dat", "geosite.dat"]:
        raise ValueError("unexpected asset names")
    return lock


def verify():
    lock = load_lock()
    check_bytes((PROJECT / "rules" / "custom_routing_white.json").read_bytes(),
                lock["routing"]["source"], "v2rayN whitelist")
    results = []
    for spec in lock["assets"]:
        data = (ASSETS / spec["name"]).read_bytes()
        check_subset(data, spec)
        results.append({"name": spec["name"], "bytes": len(data), "sha256": digest(data)})
    return {"verified": True, "networkAccess": False, "assets": results}


def download(source):
    if not source["url"].startswith("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/"):
        raise ValueError("unexpected upstream download URL")
    if not 0 < source["bytes"] <= MAX_SOURCE_BYTES:
        raise ValueError("source exceeds download size limit")
    request = urllib.request.Request(source["url"], headers={"User-Agent": "HarmonyVPN-routing-assets"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(source["bytes"] + 1)
    check_bytes(data, source, "upstream asset")
    return data


def prepare(source_dir=None):
    lock = load_lock()
    prepared = []
    # Validate every input/output before replacing either installed resource.
    for spec in lock["assets"]:
        if source_dir is None:
            data = download(spec["source"])
        else:
            source_path = source_dir / spec["name"]
            if source_path.stat().st_size > MAX_SOURCE_BYTES:
                raise ValueError("local source exceeds size limit")
            data = source_path.read_bytes()
            check_bytes(data, spec["source"], spec["name"] + " upstream")
        selected = extract(data, [entry["category"] for entry in spec["entries"]])
        check_subset(selected, spec)
        prepared.append((spec["name"], selected))
    ASSETS.mkdir(parents=True, exist_ok=True)
    for name, data in prepared:
        with tempfile.NamedTemporaryFile(dir=ASSETS, prefix=name + ".", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        try:
            temporary.replace(ASSETS / name)
        finally:
            temporary.unlink(missing_ok=True)
    result = verify()
    result["networkAccess"] = source_dir is None
    result["reproduced"] = True
    return result


def encode_varint(value):
    data = bytearray()
    while value > 127:
        data.append((value & 127) | 128)
        value >>= 7
    data.append(value)
    return bytes(data)


def message(number, payload):
    return encode_varint(number << 3 | 2) + encode_varint(len(payload)) + payload


class ExtractionTests(unittest.TestCase):
    def entry(self, code, extra=b""):
        return message(1, message(1, code.encode("ascii")) + message(2, message(1, b"example.test")) + extra)

    def test_retains_bytes_and_source_order(self):
        private = self.entry("PRIVATE", b"\x18\x01")
        cn = self.entry("CN")
        self.assertEqual(extract(private + self.entry("DE") + cn, ["CN", "PRIVATE"]), private + cn)

    def test_missing_category(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            extract(self.entry("CN"), ["CN", "PRIVATE"])

    def test_duplicate_selected_category(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            extract(self.entry("CN") * 2, ["CN"])

    def test_duplicate_unselected_category(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            extract(self.entry("CN") + self.entry("DE") * 2, ["CN"])

    def test_duplicate_code_field(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            extract(message(1, message(1, b"CN") * 2), ["CN"])

    def test_missing_code_field(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            extract(message(1, message(2, b"")), ["CN"])

    def test_truncated_messages(self):
        good = self.entry("CN")
        for end in range(len(good)):
            with self.subTest(end=end), self.assertRaises(ValueError):
                extract(good[:end], ["CN"])

    def test_nested_truncation(self):
        with self.assertRaisesRegex(ValueError, "truncated"):
            extract(message(1, message(1, b"CN") + message(2, b"\x0a\x05x")), ["CN"])

    def test_varint_overflow(self):
        with self.assertRaisesRegex(ValueError, "uint64"):
            extract(b"\xff" * 10, ["CN"])

    def test_invalid_top_level(self):
        for data in [b"\x08\x01", b"\x00", b"\x0b", message(2, b"CN")]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                extract(data, ["CN"])

    def test_corruption_fails_hash(self):
        original = self.entry("CN")
        expected = {"bytes": len(original), "sha256": digest(original)}
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            check_bytes(original[:-1] + b"!", expected, "fixture")

    def test_empty_selection(self):
        with self.assertRaisesRegex(ValueError, "empty selection"):
            extract(self.entry("CN"), [])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["verify", "prepare", "selftest"])
    parser.add_argument("--source-dir", type=Path, help="Use pinned complete dat files from this directory instead of downloading")
    args = parser.parse_args()
    if args.source_dir is not None and args.command != "prepare":
        parser.error("--source-dir requires prepare")
    if args.command == "selftest":
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ExtractionTests))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    print(json.dumps(verify() if args.command == "verify" else prepare(args.source_dir), indent=2))


if __name__ == "__main__":
    main()
