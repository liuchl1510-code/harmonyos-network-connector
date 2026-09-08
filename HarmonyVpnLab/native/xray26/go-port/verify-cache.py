"""Read-only check of the frozen source, tool binaries and exposed target."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys

source=Path(sys.argv[1]).resolve()
manifest=json.loads(Path(__file__).with_name('port-manifest.json').read_text())
result={'sourceRoot':str(source),'cacheReady':False,'sourceBase':manifest['baseCommit'],'patchSHA256':manifest['finalPatchSHA256']}
if not (source/'VERSION').is_file():
    result['state']='empty; full build will fetch and prepare the pinned compiler'
    print(json.dumps(result))
    raise SystemExit(0)
bad=[x['path'] for x in manifest['files'] if not (source/x['path']).is_file() or hashlib.sha256((source/x['path']).read_bytes().replace(b'\r\n',b'\n')).hexdigest()!=x['portedSHA256']]
if bad:
    result['state']='source mismatch';result['mismatchedFiles']=bad
    print(json.dumps(result));raise SystemExit(1)
go=source/'bin/go.exe'
if not go.is_file():
    result['state']='source prepared; compiler build required'
    print(json.dumps(result));raise SystemExit(0)
env=os.environ.copy();env.update(GOROOT=str(source),GOENV='off',GOTOOLCHAIN='local',GOOS='windows',GOARCH='amd64')
version=subprocess.check_output([str(go),'version'],text=True,env=env).strip()
targets=subprocess.check_output([str(go),'tool','dist','list'],text=True,env=env).splitlines()
tools=['asm.exe','compile.exe','link.exe','cgo.exe']
missing=[name for name in tools if not (source/'pkg/tool/windows_amd64'/name).is_file()]
result.update(version=version,supportsOpenharmonyArm64='openharmony/arm64' in targets,sourceFilesVerified=len(manifest['files']),missingTools=missing)
result['cacheReady']=version=='go version go1.26.7 windows/amd64' and result['supportsOpenharmonyArm64'] and not missing
result['state']='ready' if result['cacheReady'] else 'compiler refresh required'
print(json.dumps(result))
