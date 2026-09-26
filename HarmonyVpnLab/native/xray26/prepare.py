"""Prepare fixed libXray 26.6.1 and an isolated fail-closed core copy."""
from pathlib import Path
import difflib
import hashlib
import json
import re
import runpy
import shutil
import sys

stage,core,core_stage,recipe=(Path(x).resolve() for x in sys.argv[1:5])
wrapper=stage/'xray/xray.go'
wrapper_text=wrapper.read_text(encoding='utf-8')
assert hashlib.sha256(wrapper_text.encode()).hexdigest()=='0a4de5e0928337cc7b5d77d964e195c0a8c1ea3ee9c673863c98932f3729d95d'
run=wrapper_text.split('func RunXrayFromJSON(',1)[1].split('// Get Xray State',1)[0]
assert 'coreServer.Start()' not in run and run.count('StartXrayFromJSON(configJSON)')==1
for path in stage.glob('*.go'):
    text=path.read_text(encoding='utf-8')
    path.write_text(re.sub(r'(?m)^package libXray$','package main',text),encoding='utf-8',newline='\n')
shutil.copyfile(recipe/'main.go.template',stage/'main.go')
shutil.copyfile(recipe/'connection_stats.go.template',stage/'xray/connection_stats.go')
shutil.copyfile(recipe/'validation/connection_stats_test.go.template',stage/'xray/connection_stats_test.go')

relative=Path('transport/internet/system_dialer.go')
original=(core/relative).read_text(encoding='utf-8')
assert hashlib.sha256(original.encode()).hexdigest()=='915d5163efb93d44b01f800f39b5e5d5505905db593955c8423b0327d8f2ffd1'
old='''				if err := ctl(network, address, c); err != nil {
					errors.LogInfoInner(ctx, err, "failed to apply external controller")
				}'''
new=old.replace('\n\t\t\t\t}', '\n\t\t\t\t\treturn err\n\t\t\t\t}')
assert original.count(old)==2
patched=original.replace(old,new)
shutil.copytree(core,core_stage,dirs_exist_ok=True,copy_function=shutil.copyfile)
(core_stage/relative).write_text(patched,encoding='utf-8',newline='\n')
patch=''.join(difflib.unified_diff(original.splitlines(keepends=True),patched.splitlines(keepends=True),fromfile='a/'+relative.as_posix(),tofile='b/'+relative.as_posix()))
assert (recipe/'patches/0001-socket-controller-fail-closed.patch').read_text(encoding='utf-8')==patch, 'Authored patch differs from audited core edit'
evidence={'file':'native/xray26/patches/0001-socket-controller-fail-closed.patch','sha256':hashlib.sha256(patch.encode()).hexdigest(),'originalSourceSha256LF':hashlib.sha256(original.encode()).hexdigest(),'patchedSourceSha256LF':hashlib.sha256(patched.encode()).hexdigest(),'matches':2,'moduleCacheUnmodified':(core/relative).read_text(encoding='utf-8')==original,'upstreamStartupAlreadySingleStart':True,'oldStartupPatchApplied':False,'nativeTunFdExported':False}
pool_apply=runpy.run_path(str(recipe/'dns-pool/apply_patch.py'))['apply_pool_patch']
evidence['dohTransportPool']=pool_apply(core,core_stage,recipe)
(core_stage/'harmony-patch-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf-8')

tests=(recipe/'validation/socket_protect_test.go.template').read_text(encoding='utf-8')
anchor='\t\t\t\tdialer := &internet.DefaultSystemDialer{}'
assert tests.count(anchor)==1
setup='''				// New core controllers are process-global. Cases are serial, and all
				// socket defers run before restoring the saved global list.
				internet.ControllersLock.Lock()
				savedControllers := internet.Controllers
				internet.Controllers = nil
				internet.ControllersLock.Unlock()
				defer func() {
					internet.ControllersLock.Lock()
					internet.Controllers = savedControllers
					internet.ControllersLock.Unlock()
				}()
'''
tests=tests.replace(anchor,setup+anchor)
test_dir=stage/'harmony_socket_validation'
test_dir.mkdir(exist_ok=True)
(test_dir/'socket_protect_test.go').write_text(tests,encoding='utf-8',newline='\n')
assert (recipe/'validation/socket_protect_26_test.go').read_text(encoding='utf-8')==tests, 'Authored serial-controller tests changed'
print('Prepared true 26.6.1: upstream single-start retained, 9 ABI shim, fail-closed controllers and instance-scoped DoH transport pool.')
