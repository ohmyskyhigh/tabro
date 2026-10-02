"""Migrate Hermes product references without changing browser identities or history.

The manifest is private: it contains paths and hashes, not file contents or tokens.
Backups and staged content are kept outside Hermes. No service is stopped here.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import yaml

RULES = json.loads(Path(__file__).with_name('hermes-tabro-rules.json').read_text('utf-8'))
SECRET_KEY = re.compile(r'(?:token|secret|password|credential|api[_-]?key)|(?:^|_)(?:id|ref|hash)$', re.I)


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError('Duplicate YAML key; migration refused')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def yload(text):
    return yaml.load(text, Loader=UniqueLoader)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))


def atomic_write(path, data):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.tabro-migrate-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as h:
            h.write(data)
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def inside(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def safe_target(path, root):
    path, root = Path(path), Path(root).resolve()
    if not inside(path, root):
        raise ValueError('Target escapes intended root')
    for ancestor in [path, *path.parents]:
        if ancestor == root:
            break
        if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
            raise ValueError('Reparse point requires explicit review')
    return path


def brand(text, path_map=()):
    if 'octopus' not in text.lower():
        return text
    # Map only actual renamed Skill paths; preserve other real Windows paths.
    for old, new in sorted(path_map, key=lambda pair: -len(pair[0])):
        text = text.replace(old, new).replace(old.replace('\\', '/'), new.replace('\\', '/'))
    protected = []

    def guard(match):
        protected.append(match.group(0))
        return f'\x01{len(protected)-1}\x02'

    for literal in RULES['identities'] + RULES['thirdParty']:
        text = re.sub(re.escape(literal), guard, text, flags=re.I)
    text = re.sub(r'(?:[A-Za-z]:[\\/]|%[^%]+%[\\/]|\$env:[A-Z_]+[\\/])[^\r\n\"\x27`<>|]+', guard, text)
    text = re.sub(r'https://github\.com/ohmyskyhigh/octopus-browser-relay(?=[/#?\s)]|$)', 'https://github.com/ohmyskyhigh/tabro', text, flags=re.I)
    for old, new in RULES['env'].items():
        text = re.sub(r'\b' + re.escape(old) + r'\b', new, text)
    for old, new in [
        ('mcp__octopus_browser_relay__', 'mcp__tabro__'),
        ('Octopus_managed_browser', 'Tabro_managed_browser'),
        ('Octopus Browser Relay', 'Tabro'), ('Octopus Chrome Relay', 'Tabro'),
        ('Octopus Relay', 'Tabro'), ('octopus-site-screenshots', 'tabro-site-screenshots'),
        ('octopus-browser-relay', 'tabro'), ('octopus_browser_relay', 'tabro'),
    ]:
        text = re.sub(re.escape(old), new, text, flags=re.I)
    # Chinese prose and underscore-separated identifiers have no Unicode word
    # boundary at the brand. Protect Latin names such as Octopustank instead.
    text = re.sub(r'(?<![A-Za-z0-9])octopus(?![A-Za-z0-9])', lambda m: 'tabro' if m[0].islower() else 'TABRO' if m[0].isupper() else 'Tabro', text, flags=re.I)
    return re.sub(r'\x01(\d+)\x02', lambda m: protected[int(m[1])], text)


def transform_tree(value, path_map=(), key=''):
    if SECRET_KEY.search(key):
        return value
    if isinstance(value, str):
        return brand(value, path_map)
    if isinstance(value, list):
        return [transform_tree(v, path_map) for v in value]
    if isinstance(value, dict):
        result = {}
        for k, v in value.items():
            nk = brand(k, path_map) if isinstance(k, str) else k
            nv = transform_tree(v, path_map, str(k))
            if nk in result and result[nk] != nv:
                raise ValueError('Conflicting renamed keys; migration refused')
            result[nk] = nv
        return result
    return value


def config_transform(text, default_entry=None):
    before = yload(text) or {}
    expected = copy.deepcopy(before)
    servers = expected.setdefault('mcp_servers', {})
    for old in ('octopus-browser-relay', 'octopus-demo'):
        if old in servers:
            if 'tabro' in servers and servers['tabro'] != servers[old]:
                raise ValueError('Conflicting MCP server entries')
            servers['tabro'] = servers.pop(old)
            text = re.sub(r'^(  )' + re.escape(old) + r':\s*$', r'\1tabro:', text, flags=re.M)
    entry = servers.get('tabro')
    if entry is None and default_entry is not None:
        entry = copy.deepcopy(default_entry)
        servers['tabro'] = entry
        if 'mcp_servers' not in before:
            text = text.rstrip('\r\n') + '\n\nmcp_servers:\n'
        elif not isinstance(before.get('mcp_servers'), dict) or not before['mcp_servers']:
            text = re.sub(r'^mcp_servers:\s*(?:\{\}|null|~)?\s*$', 'mcp_servers:', text, flags=re.M)
        # Append inside a possibly non-final section, rather than after another root key.
        lines = text.splitlines(keepends=True)
        start = next(i for i, line in enumerate(lines) if re.match(r'^mcp_servers:', line))
        end = next((i for i in range(start+1, len(lines)) if re.match(r'^\S[^#]*:', lines[i])), len(lines))
        block = yaml.safe_dump({'tabro': entry}, allow_unicode=True, sort_keys=False)
        lines[end:end] = [''.join('  '+line+'\n' for line in block.splitlines())]
        text = ''.join(lines)
    if entry:
        env = entry.get('env', {})
        for old, new in RULES['env'].items():
            if old not in env:
                continue
            if new in env:
                if env[new] != env[old]:
                    raise ValueError('Conflicting old/new environment values')
                text = re.sub(r'^\s*' + old + r':[^\r\n]*(?:\r?\n|$)', '', text, flags=re.M)
                env.pop(old)
            else:
                env[new] = env.pop(old)
                text = re.sub(r'^(\s*)' + old + r':', r'\1'+new+':', text, flags=re.M)
    if yload(text) != expected:
        raise ValueError('Config edits changed unrelated semantics')
    return text, before, expected


def active_paths(root):
    root = Path(root)
    homes = [root, *sorted((root/'profiles').glob('*'))] if (root/'profiles').is_dir() else [root]
    for home in homes:
        if not home.is_dir():
            continue
        for name in ('config.yaml', 'SOUL.md', 'AGENTS.md'):
            p = home/name
            if p.is_file():
                yield p
        for folder in ('skills', 'shared-skills', 'memories'):
            start = home/folder
            if not start.is_dir():
                continue
            for base, dirs, files in os.walk(start, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in RULES['historyDirectories'] and d not in ('__pycache__', '.git', 'node_modules'))
                for name in sorted(files):
                    p = Path(base)/name
                    if name in RULES['historicalSkillFiles'] or '.bak' in name or 'before-' in name:
                        continue
                    if p.suffix in RULES['textExtensions']:
                        yield p
        cron = home/'cron'
        if cron.is_dir():
            for p in sorted(cron.glob('*')):
                if p.is_file() and p.suffix in ('.json', '.yaml', '.yml'):
                    yield p


def read_text(data):
    return data.decode('utf-8-sig'), data.startswith(b'\xef\xbb\xbf')


def mapped_path(path, renames, skip=None):
    path=Path(path)
    for a,b in renames:
        if a==skip:
            continue
        if inside(path,a):
            path=Path(b)/path.relative_to(a)
    return path


def validate_document(text, suffix, before=None, path_map=()):
    if suffix in ('.yaml', '.yml'):
        parsed = yload(text)
        if before is not None and parsed != transform_tree(yload(before), path_map):
            raise ValueError('YAML transformation changed non-brand semantics')
    elif suffix == '.json':
        json.loads(text)
    elif suffix == '.jsonl':
        for line in text.splitlines():
            if line.strip():
                json.loads(line)
    elif suffix == '.md' and text.startswith('---'):
        parts = text.split('---', 2)
        if len(parts) == 3:
            yload(parts[1])


def make_plan(root, output, add_missing=False):
    root, output = Path(root).resolve(), Path(output).resolve()
    if not root.is_dir() or inside(output, root):
        raise ValueError('Root must exist; report and backups must be outside it')
    output.mkdir(parents=True, exist_ok=True)
    paths = sorted(set(active_paths(root)))
    # rg performs the text filtering before expensive per-file integrity checks.
    scopes=[]
    for home in [root,*list((root/'profiles').glob('*'))]:
        for name in ('skills','shared-skills','memories','cron','SOUL.md','AGENTS.md'):
            if (home/name).exists():scopes.append(str(home/name))
    result=subprocess.run(['rg','--files-with-matches','--hidden','--no-ignore','-i','octopus',*scopes],capture_output=True,text=True,encoding='utf-8',errors='replace') if scopes else None
    candidates={Path(p).resolve() for p in result.stdout.splitlines()} if result else set()
    paths=[p for p in paths if p.resolve() in candidates or 'octopus' in p.name.lower() or (p.name=='config.yaml' and p.parent in [root,*list((root/'profiles').glob('*'))])]
    renames = []
    for p in paths:
        if p.name == 'SKILL.md' and p.parent.name == 'octopus-site-screenshots':
            renames.append((str(p.parent), str(p.parent.with_name('tabro-site-screenshots'))))
        if 'skills' in p.relative_to(root).parts and 'octopus' in p.name.lower():
            renames.append((str(p), str(p.with_name(brand(p.name)))))
    # Rename descendants first, then their parents. Both are required for links.
    renames=sorted(set(renames),key=lambda pair:-len(pair[0]))
    for a, b in renames:
        safe_target(a,root);safe_target(b,root)
        if Path(b).exists():
            raise ValueError('Rename target already exists')
    if len({b.lower() for a,b in renames}) != len(renames):
        raise ValueError('Rename targets collide')
    default = yload((root/'config.yaml').read_text('utf-8-sig')) or {}
    default_entry = default.get('mcp_servers',{}).get('tabro') if add_missing else None
    entries, exceptions, tokens = [], [], []
    for p in paths:
        safe_target(p,root)
        data = p.read_bytes()
        text,bom = read_text(data)
        target = mapped_path(p,renames)
        is_config = p.name=='config.yaml' and p.parent in [root,*list((root/'profiles').glob('*'))]
        if not is_config and target == p and not re.search('octopus',text,re.I):
            continue
        if is_config:
            changed,before,expected=config_transform(text,default_entry)
            for servers in (before.get('mcp_servers',{}),):
                for name,v in servers.items():
                    if name in ('tabro','octopus-browser-relay','octopus-demo'):
                        env=v.get('env',{});tf=env.get('TABRO_TOKEN_FILE',env.get('OCTOPUS_BROWSER_RELAY_TOKEN_FILE'))
                        if tf:
                            tokenp=Path(tf)
                            if not tokenp.is_file():raise ValueError('Configured token file is missing')
                            tokens.append({'path':str(tokenp),'sha256':digest(tokenp.read_bytes())})
        elif p.suffix=='.json':
            obj=json.loads(text);value=transform_tree(obj,renames)
            changed=(json.dumps(value,ensure_ascii=False,indent=2)+'\n') if value!=obj else text
        elif p.suffix=='.jsonl':
            lines=[]
            for line in text.splitlines():
                if not line.strip():lines.append(line);continue
                obj=json.loads(line);value=transform_tree(obj,renames)
                lines.append(json.dumps(value,ensure_ascii=False) if value!=obj else line)
            changed='\n'.join(lines)+('\n' if text.endswith('\n') else '')
        else:
            changed=brand(text,renames)
            validate_document(changed,p.suffix,text if p.suffix in ('.yaml','.yml') else None,renames)
        encoded=(b'\xef\xbb\xbf' if bom else b'')+changed.encode('utf-8')
        # Preserve physical newlines in edited text files.
        if b'\r\n' in data and b'\r\n' not in encoded:
            encoded=encoded.replace(b'\n',b'\r\n')
        validate_document(read_text(encoded)[0],p.suffix)
        if encoded!=data or target!=p:
            index=len(entries);stage=output/'staged'/str(index)
            stage.parent.mkdir(parents=True,exist_ok=True);stage.write_bytes(encoded)
            entries.append({'source':str(p),'target':str(target),'relative':str(p.relative_to(root)),'before':digest(data),'after':digest(encoded),'stage':str(stage),'kind':'config' if p.name=='config.yaml' else 'skill' if 'skills' in p.relative_to(root).parts else 'context'})
        for i,line in enumerate(changed.splitlines(),1):
            if re.search('octopus',line,re.I):
                clean=brand(line,renames)
                if clean==line or p.name=='config.yaml':
                    exceptions.append({'path':str(target),'line':i,'reason':'retained installation path or compatibility identity'})
                else:
                    raise ValueError('Unclassified remaining product reference')
    manifest={'version':1,'root':str(root),'historyPolicy':'preserve','entries':entries,'renames':[{'source':a,'target':b} for a,b in renames],'tokens':tokens,'exceptions':exceptions,'scan_scope':'Active configurations, Skills, memories, prompts and cron definitions; original histories retained','discovery_errors':result.stderr.splitlines() if result else [],'add_missing':add_missing}
    dump(output/'manifest.json',manifest);dump(output/'exceptions.json',exceptions)
    # No source text in preview: configuration diffs could otherwise expose secrets.
    (output/'preview.txt').write_text('\n'.join(f"{e['kind']}: {e['relative']} -> {Path(e['target']).relative_to(root)}" for e in entries)+'\n',encoding='utf-8')
    return manifest


def check_manifest(manifest):
    root=Path(manifest['root'])
    if manifest['historyPolicy']!='preserve':
        raise ValueError('Only the preserve branch is implemented')
    for e in manifest['entries']:
        safe_target(e['source'],root);safe_target(e['target'],root)
        if digest(Path(e['stage']).read_bytes())!=e['after']:
            raise ValueError('Staged file hash mismatch')
    for r in manifest['renames']:
        safe_target(r['source'],root);safe_target(r['target'],root)


def backup_manifest(manifest,backup):
    backup=Path(backup).resolve();root=Path(manifest['root'])
    if inside(backup,root):raise ValueError('Backup must be outside Hermes')
    if (backup/'hashes.json').exists():raise ValueError('Backup already exists')
    originals=[]
    for e in manifest['entries']:
        p=Path(e['source'])
        if digest(p.read_bytes())!=e['before']:raise ValueError('Concurrent file modification')
        dest=backup/'original'/e['relative'];dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(p,dest)
        originals.append({'relative':e['relative'],'sha256':e['before']})
    # Whole renamed folder: preserve every file, including unchanged binary resources.
    folders=[]
    for r in manifest['renames']:
        p=Path(r['source'])
        if p.is_dir():
            dest=backup/'directories'/p.relative_to(root)
            shutil.copytree(p,dest,copy_function=shutil.copy2)
            folders.append(str(p.relative_to(root)))
    dump(backup/'hashes.json',{'files':originals,'directories':folders})
    dump(backup/'manifest.json',manifest)
    return verify_backup(backup)


def verify_backup(backup):
    backup=Path(backup)
    info=json.loads((backup/'hashes.json').read_text('utf-8'))
    for e in info['files']:
        p=safe_target(backup/'original'/e['relative'],backup)
        if digest(p.read_bytes())!=e['sha256']:raise ValueError('Backup hash mismatch')
    return {'status':'verified','files':len(info['files'])}


def apply_manifest(manifest,backup,fail_after=None):
    check_manifest(manifest);verify_backup(backup)
    root=Path(manifest['root']);journal={'writes':[],'renames':[],'state':'applying'}
    jp=Path(backup)/'journal.json'
    if jp.exists():raise ValueError('Journal already exists; rollback or create a fresh plan')
    # Check every file and rename before the first write.
    for e in manifest['entries']:
        if digest(Path(e['source']).read_bytes())!=e['before']:raise ValueError('Concurrent file modification')
    for r in manifest['renames']:
        if Path(r['target']).exists():raise ValueError('Rename target appeared after planning')
    dump(jp,journal)
    try:
        for e in manifest['entries']:
            p=Path(e['source']);safe_target(p,root)
            if digest(p.read_bytes())!=e['before']:raise ValueError('Concurrent file modification during commit')
            journal['writes'].append(e['source']);dump(jp,journal)
            atomic_write(p,Path(e['stage']).read_bytes())
            if fail_after and len(journal['writes'])==fail_after:raise RuntimeError('Injected commit failure')
        for r in manifest['renames']:
            journal['renames'].append(r);dump(jp,journal)
            Path(r['source']).rename(r['target'])
        verify_manifest(manifest)
        journal['state']='applied';dump(jp,journal)
    except Exception:
        rollback_manifest(manifest,backup,partial=True)
        raise
    return {'status':'applied','files':len(manifest['entries']),'renames':len(manifest['renames'])}


def rollback_manifest(manifest,backup,partial=False):
    root=Path(manifest['root']);backup=Path(backup);verify_backup(backup)
    journal=json.loads((backup/'journal.json').read_text('utf-8'))
    if not partial:
        for e in manifest['entries']:
            p=Path(e['target']);safe_target(p,root)
            if digest(p.read_bytes())!=e['after']:raise ValueError('Rollback refuses to overwrite later edits')
    # Validate every reverse rename before any move.
    for r in reversed(journal['renames']):
        a,b=Path(r['source']),Path(r['target']);safe_target(a,root);safe_target(b,root)
        if a.exists() and b.exists():raise ValueError('Reverse rename collision')
    for r in reversed(journal['renames']):
        a,b=Path(r['source']),Path(r['target'])
        if b.exists():b.rename(a)
    for e in reversed(manifest['entries']):
        if e['source'] in journal['writes']:
            p=safe_target(e['source'],root)
            if partial and digest(p.read_bytes()) not in (e['before'],e['after']):
                raise ValueError('Recovery stopped on a concurrent user edit')
            shutil.copy2(backup/'original'/e['relative'],p)
    journal['state']='rolled-back';dump(backup/'journal.json',journal)
    return {'status':'rolled-back'}


def verify_manifest(manifest):
    for e in manifest['entries']:
        p=safe_target(e['target'],manifest['root'])
        if digest(p.read_bytes())!=e['after']:raise ValueError('Applied file hash mismatch')
        validate_document(read_text(p.read_bytes())[0],p.suffix)
    for e in manifest['tokens']:
        if digest(Path(e['path']).read_bytes())!=e['sha256']:raise ValueError('Token changed')
    for r in manifest['renames']:
        pairs=[(x['source'],x['target']) for x in manifest['renames']]
        old=mapped_path(r['source'],pairs,skip=r['source'])
        new=mapped_path(r['target'],pairs)
        if old.exists() or not new.exists():raise ValueError('Rename did not complete')
    return {'status':'verified','files':len(manifest['entries']),'token_files':len({e['path'] for e in manifest['tokens']})}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['scan','plan','apply','verify','rollback','verify-manifest','verify-backup','verify-report'])
    parser.add_argument('--root',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--manifest',type=Path)
    parser.add_argument('--backup',type=Path)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--add-missing',action='store_true',help='Populate missing Profile registration from existing default Tabro entry')
    args=parser.parse_args()
    try:
        if args.command in ('scan','plan'):
            if not args.root or not args.output:raise ValueError('root and output are required')
            m=make_plan(args.root,args.output,args.add_missing)
            result={'status':'planned','files':len(m['entries']),'renames':len(m['renames']),'exceptions':len(m['exceptions']),'manifest':str(args.output/'manifest.json')}
        elif args.command=='verify-backup':result=verify_backup(args.backup)
        elif args.command=='verify-report':
            report=json.loads(args.report.read_text('utf-8'))
            if not report.get('status') or 'limitations' not in report:raise ValueError('Invalid report')
            result={'status':'report-verified'}
        else:
            m=json.loads(args.manifest.read_text('utf-8'))
            if args.command=='verify-manifest':check_manifest(m);result={'status':'manifest-verified'}
            elif args.command=='apply':
                if not args.backup:raise ValueError('backup required')
                backup_manifest(m,args.backup)
                result=apply_manifest(m,args.backup)
            elif args.command=='verify':result=verify_manifest(m)
            else:result=rollback_manifest(m,args.backup)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        # Do not serialize YAML parser errors: they can contain credential lines.
        print(json.dumps({'status':'failed','error_type':type(e).__name__,'reason':str(e) if isinstance(e,(ValueError,RuntimeError)) else 'Operation failed; inspect the scoped input privately'}),file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':
    raise SystemExit(main())
