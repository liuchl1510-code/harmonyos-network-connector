# Third-party components and source provenance

HarmonyOS Network Connector publishes the Harmony VPN application source and
native build recipes. The
initial public source publication excludes compiled `.so` libraries, HAP packages,
signing materials, and device data. The local binary hashes below identify the
builds used to check the recipes and dependency inventory; they are not download
links or a claim that a fresh public checkout has completed a cold build.

The repository's original code is offered under GPL-3.0-or-later, as stated in
the root README and LICENSE. That own-code license does not replace the licenses or copyright
notices of third-party code. Original notices remain in the linked license files.
This document is an index and explanation, not a substitute for those texts.

## Current components

Paths in the table are relative to `HarmonyVpnLab/` unless stated otherwise.

| Component | Version or fixed source | Original license and retained notices | Local use or modification |
| --- | --- | --- | --- |
| Xray-core | Reported version 26.6.1; commit `94ffd50060f1cfd5d7482ec90a23a92bdefdff68`; module `v1.260327.1-0.20260601021109-94ffd50060f1` | [MPL-2.0](HarmonyVpnLab/native/xray26/licenses/dependencies/github.com_xtls_xray-core__LICENSE) | Proxy core. The [socket-controller patch](HarmonyVpnLab/native/xray26/patches/0001-socket-controller-fail-closed.patch) propagates rejected socket-protection calls. |
| libXray | Commit `1a6c2baedcf102053c1117ea08b3510d6dada895` | [MIT](HarmonyVpnLab/native/xray26/licenses/libXray-MIT.txt), copyright XTLS | [Preparation script](HarmonyVpnLab/native/xray26/prepare.py), [C ABI wrapper](HarmonyVpnLab/native/xray26/main.go.template), and [per-instance statistics accessor](HarmonyVpnLab/native/xray26/connection_stats.go.template). |
| Go and its OpenHarmony platform adaptation | Go 1.26.7; base commit `3cc00d9c2b8ac231a5432ececa784814cc1eb075`; inherited platform fork `302a5306b6fad2f47196360b82561d1db1f954cf` | [Go BSD license](HarmonyVpnLab/native/xray26/licenses/Go-BSD.txt); source-file copyright notices are retained in the port patch | [Complete port patch and manifest](HarmonyVpnLab/native/xray26/go-port/), including file hashes and platform provenance. |
| Hev SOCKS5 Tunnel | 2.9.0; commit `99cd2d5d5dfc9b21038e977808e59a0b90b38fa0` | [MIT](HarmonyVpnLab/native/hev/licenses/hev-socks5-tunnel-MIT.txt), copyright hev | TUN-to-SOCKS forwarding; [demand-driven I/O patch](HarmonyVpnLab/native/hev/patches/demand-driven-io.patch) and local OHOS I/O diagnostics. |
| Hev SOCKS5 core | Commit `5d37a81dc8d492d54c89aa6a00a5c4f505b75b99` | [MIT](HarmonyVpnLab/native/hev/licenses/hev-socks5-core-MIT.txt) | Linked into the Hev library. |
| Hev task system | Commit `ed320fd855e84c6a0b8792db1edf5899f1584132` | [MIT](HarmonyVpnLab/native/hev/licenses/hev-task-system-MIT.txt) | Hev scheduling and I/O support. |
| lwIP fork | Commit `7a246bcd7ab66f6057bcbae979ca8b11428cc459` | [BSD-3-Clause](HarmonyVpnLab/native/hev/licenses/lwip-BSD-3-Clause.txt) and [individual source notices](HarmonyVpnLab/native/hev/licenses/lwip-source-notices.txt) | Hev TCP/IP implementation; individual file notices remain applicable. |
| libyaml and the Hev yaml fork | Fork commit `efa36117a8646d26d12b58e05bac472d7854a70d` | [Fork MIT notice](HarmonyVpnLab/native/hev/licenses/yaml-fork-MIT.txt) and [original libyaml 0.2.5 MIT notice](HarmonyVpnLab/native/hev/licenses/libyaml-original-MIT.txt) | Hev configuration parsing. |
| Mozilla CA certificate snapshot distributed by curl | Mozilla certificate data dated 2026-08-13 | MPL-2.0; [provenance](HarmonyVpnLab/native/xray/ca-bundle.json), [distribution explanation](HarmonyVpnLab/native/xray/README.md#application-ca-bundle), and [license text](HarmonyVpnLab/native/xray/licenses/Xray-core-MPL-2.0.txt) | Unmodified application CA bundle, SHA256 `f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9`. |

Upstream repository URLs, archive hashes and all Hev submodule pins are recorded
in [Xray source locks](HarmonyVpnLab/native/xray26/sources.lock.json),
[Go port provenance](HarmonyVpnLab/native/xray26/go-port/port-manifest.json), and
[Hev source locks](HarmonyVpnLab/native/hev/source-lock.json).

## Linked Go dependencies: GPL, LGPL, MPL, MIT, BSD and Apache terms

The current Xray recipe includes **42 Go module dependencies**. The complete
[dependency inventory](HarmonyVpnLab/native/xray26/licenses/dependencies/dependency-inventory.json)
records each module, exact version, available Go checksum, retained notice file,
and notice SHA256. The corresponding
[module table](HarmonyVpnLab/native/xray26/licenses/module-info.txt) comes from
the same build. Local build-directory paths are replaced with stable labels;
module versions, checksums, and original license-file bytes are unchanged.

These components require particular attention; Xray's MPL license is not the
only license involved in a build:

| Dependency | Version | Applicable original terms |
| --- | --- | --- |
| `github.com/sagernet/sing` | `v0.5.1` | [GPL-3.0-or-later notice](HarmonyVpnLab/native/xray26/licenses/dependencies/github.com_sagernet_sing__LICENSE), copyright nekohasekai. |
| `github.com/sagernet/sing-shadowsocks` | `v0.2.7` | [GPL-3.0-or-later notice](HarmonyVpnLab/native/xray26/licenses/dependencies/github.com_sagernet_sing-shadowsocks__LICENSE), copyright nekohasekai. |
| `github.com/juju/ratelimit` | `v1.0.2` | [LGPLv3 plus its specific linking exception](HarmonyVpnLab/native/xray26/licenses/dependencies/github.com_juju_ratelimit__LICENSE), copyright Canonical Ltd. The exception waives the stated section 4(d)/4(e) obligations for a qualifying combined work; it does not erase the other LGPL terms or other components' licenses. |
| `github.com/xtls/reality` | See the exact module version in the inventory | [MPL-2.0](HarmonyVpnLab/native/xray26/licenses/dependencies/github.com_xtls_reality__LICENSE) and [retained Go BSD notice](HarmonyVpnLab/native/xray26/licenses/dependencies/github.com_xtls_reality__LICENSE-Go). |

Full [GNU GPL version 3](HarmonyVpnLab/native/xray26/licenses/GPL-3.0.txt) and
[GNU LGPL version 3](HarmonyVpnLab/native/xray26/licenses/LGPL-3.0.txt) texts are
included alongside these original component notices. The GNU texts' byte hashes
and local distribution provenance are recorded in
[license-texts-provenance.json](HarmonyVpnLab/native/xray26/licenses/license-texts-provenance.json).
The LGPL's GPL incorporation and the ratelimit exception must be read together.

Other modules include MIT, BSD, Apache-2.0, and multi-notice files. Their original
`LICENSE`, `COPYING`, `NOTICE`, and `COPYRIGHT` files collected from the module
roots are retained in the inventory directory; Apache `NOTICE` files must not be
discarded when assembling a distribution. This root-file inventory is not a
claim that every nested vendored source file has received a separate license
audit.

## Obtaining and rebuilding the corresponding sources

The repository contains local modifications and source-retrieval recipes rather
than a vendored copy of every upstream repository or Go module. Keep the source
locks, original notices, patches, templates and scripts together when sharing it.

- [Hev build instructions](HarmonyVpnLab/native/hev/README.md) and
  [`build-hev.ps1`](HarmonyVpnLab/scripts/build-hev.ps1) retrieve the five pinned
  repositories, verify the clean baseline and local patch, and build the library.
- [Xray build instructions](HarmonyVpnLab/native/xray26/README.md) and
  [`build-xray26.ps1`](HarmonyVpnLab/scripts/build-xray26.ps1) retrieve the pinned
  Go/libXray sources, apply the recorded port and core modifications, and fetch
  the exact dependencies from the retained
  [`go.mod`](HarmonyVpnLab/native/xray26/upstream/go.mod) and
  [`go.sum`](HarmonyVpnLab/native/xray26/upstream/go.sum).
- A normal Xray rebuild copies matching dependency notices and a portable module
  table to `native/xray26/licenses/`. A custom `-OutputPath` defaults to an adjacent
  `<output>.licenses` directory; `-LicenseOutputPath` selects another metadata
  destination. The script checks the candidate SHA256 and every collected notice
  hash before exporting the snapshot. `-ValidateCacheOnly` remains read-only.
- The reference local Xray library has SHA256
  `0cfda2bd92a12cdbd5bcd9cf516ca17344023c93cb3a6659747af0ceecd974bc`;
  the Hev library has SHA256
  `c774d64188cbef76b3dfb56db9792fc36ebbb68a8c38861236beddf1eb9d2875`.
  These hashes identify a previously built reference, not a promise of byte-for-byte
  reproduction across different toolchains or build paths.

For any later binary distribution, supply the corresponding source and notices
for that actual combined build through a durable recipient-accessible location;
evaluate its GPL/LGPL requirements and make modified MPL-covered source files
available with their MPL notices. Merely linking an upstream homepage or shipping
this summary does not describe all obligations of a compiled distribution. See
the original license texts and Mozilla's
[MPL distribution guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

## Reference projects and historical recipes

The project records v2rayNG commit
`2020807c255b76b09c9ced4255c95600250aef48` as a sharing-format reference in the
[node-import documentation](HarmonyVpnLab/docs/node-import-support.md).
It records Hey commit `a02a6a51fe02707a5e1ac5fecd90b3966452ef2d` as a build
architecture reference in the
[historical Xray recipe](HarmonyVpnLab/native/xray/README.md#source-and-version-pins),
which explicitly states that the Hey script was not executed. These references
are distinct from the components actually integrated above. They are not a basis
for relabeling every project file as derived from v2rayNG. Direct copying or
porting of additional upstream code must be recorded with its applicable notice.

The historical Xray 25.8.3 recipe and its original notices remain under
`HarmonyVpnLab/native/xray/`. Some currently used CA-bundle provenance is also in
that directory. Its historical module inventory must not be substituted for the
current Xray 26.6.1 inventory.
