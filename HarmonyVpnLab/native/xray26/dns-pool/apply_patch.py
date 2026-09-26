"""Apply the pinned DoH transport patch only to a clean isolated core copy."""
from pathlib import Path
import hashlib
import json
import os
import subprocess


def normalized_hash(file):
    return hashlib.sha256(file.read_text(encoding='utf-8').encode()).hexdigest()


def apply_pool_patch(core, stage, recipe):
    core, stage, recipe = (Path(p).resolve() for p in (core, stage, recipe))
    assert core != stage and stage.is_dir(), 'Isolated core copy required'
    manifest = json.loads((recipe/'dns-pool/manifest.json').read_text(encoding='utf-8'))
    assert manifest['schemaVersion'] == 1
    assert manifest['coreCommit'] == '94ffd50060f1cfd5d7482ec90a23a92bdefdff68'
    assert manifest['patch'] == 'patches/0002-doh-session-transport-pool.patch'
    patch = recipe/manifest['patch']
    assert normalized_hash(patch) == manifest['patchSHA256'], 'DoH patch hash changed'
    allowed = {'app/dns/dns.go', 'app/dns/nameserver.go', 'app/dns/nameserver_doh.go', 'app/dns/doh_transport.go'}
    assert len(manifest['files']) == 4 and {f['path'] for f in manifest['files']} == allowed
    headers = [line for line in patch.read_text(encoding='utf-8').splitlines() if line.startswith(('--- ', '+++ '))]
    assert len(headers) == 8
    assert {line[6:] for line in headers if line.startswith('+++ b/')} == allowed
    assert {line[6:] for line in headers if line.startswith('--- a/')} == allowed - {'app/dns/doh_transport.go'}
    assert headers.count('--- /dev/null') == 1
    for file in manifest['files']:
        original, target = core/file['path'], stage/file['path']
        if file['originalSHA256LF'] is None:
            assert not original.exists() and not target.exists(), 'New DoH source already exists'
        else:
            assert normalized_hash(original) == file['originalSHA256LF'], 'Pinned DNS source changed'
            assert normalized_hash(target) == file['originalSHA256LF'], 'Core stage is not clean'
    assert normalized_hash(recipe/'dns-pool/doh_transport.go') == next(f['patchedSHA256LF'] for f in manifest['files'] if f['path'].endswith('/doh_transport.go'))
    # The build stage is outside the source repository. No index/git metadata
    # is touched, and changed paths are fixed above and checked after apply.
    env = dict(os.environ)
    for name in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
        env.pop(name, None)
    git = ['git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply']
    subprocess.run(git + ['--check', str(patch)], cwd=stage, env=env, check=True)
    subprocess.run(git + [str(patch)], cwd=stage, env=env, check=True)
    for file in manifest['files']:
        target = stage/file['path']
        target.write_text(target.read_text(encoding='utf-8'), encoding='utf-8', newline='\n')
        assert hashlib.sha256(target.read_bytes()).hexdigest() == file['patchedSHA256LF'], 'Patched DNS source differs'
        if file['originalSHA256LF']:
            assert normalized_hash(core/file['path']) == file['originalSHA256LF'], 'Upstream cache changed'
    return {'file': 'native/xray26/'+manifest['patch'], 'sha256': manifest['patchSHA256'],
            'sourceFiles': manifest['files'], 'moduleCacheUnmodified': True,
            'normalRemoteHttpsOnly': True, 'instanceScoped': True,
            'separateNameserverCaches': True, 'tlsVerificationUnchanged': True}
