"""Exercise the real migration against an isolated synthetic Hermes home."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

spec=importlib.util.spec_from_file_location('tabro_migration',Path(__file__).resolve().parents[2]/'tools/migrate-hermes-tabro.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'Hermes 测试';self.root.mkdir()
        self.token=self.base/'octopus-browser-relay'/'token.txt';self.token.parent.mkdir();self.token.write_text('octopus-is-part-of-a-real-token',encoding='utf-8')
        self.entry={'command':'node','args':[r'G:\funstuff\octopus-browser-relay\dist\main.js'],'env':{'OCTOPUS_BROKER_URL':'http://127.0.0.1:13618/mcp','OCTOPUS_BROWSER_RELAY_TOKEN_FILE':str(self.token),'OCTOPUS_RUNTIME':'hermes'}}
        self.write('config.yaml',yaml.safe_dump({'model':'unchanged','mcp_servers':{'other':{'command':'other'},'tabro':self.entry}},sort_keys=False))
        child=json.loads(json.dumps(self.entry));child['env']['OCTOPUS_BROKER_URL']='http://127.0.0.1:7331/mcp'
        self.write('profiles/worker/config.yaml',yaml.safe_dump({'mcp_servers':{'tabro':child}},sort_keys=False))
        self.write('profiles/new/config.yaml','model: unchanged\nmcp_servers: {}\nagent:\n  max_turns: 12\n')
        self.write('skills/octopus-site-screenshots/SKILL.md','---\nname: octopus-site-screenshots\ndescription: Real screenshots.\n---\n# Octopus Browser Relay\nUse mcp__octopus_browser_relay__get_browser_context.\n[workflow](references/octopus-browser-relay.md#steps)\n')
        self.write('skills/octopus-site-screenshots/references/octopus-browser-relay.md','# Octopus Relay\nCollector octopus_browser_relay.\n')
        self.write('skills/radar/references/platforms.yaml','collectors:\n  octopus_browser_relay:\n    workflow: octopus-browser-relay.md\nplatforms:\n  x:\n    collector: octopus_browser_relay\n')
        self.write('skills/radar/references/octopus-browser-relay.md','# Octopus Browser Relay\n')
        self.write('memories/USER.md','Prefer Octopus Chrome Relay. Keep OctopusDeploy.\n')
        self.write('logs/history.log','Original mcp__octopus_browser_relay__get_browser_context\n')
        self.write('skills/.curator_ledger.jsonl','{"old":"octopus-site-screenshots"}\n')
        self.original={str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def write(self,relative,text):
        p=self.root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text,encoding='utf-8');return p

    def plan(self):return m.make_plan(self.root,self.base/'report',add_missing=True)

    def apply(self,manifest=None,fail_after=None):
        manifest=manifest or self.plan();backup=self.base/'backup';m.backup_manifest(manifest,backup)
        return m.apply_manifest(manifest,backup,fail_after),manifest

    def test_real_round_trip_and_idempotence(self):
        before={str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        manifest=self.plan()
        self.assertEqual(before,{str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        _,manifest=self.apply(manifest)
        self.assertTrue((self.root/'skills/tabro-site-screenshots/SKILL.md').exists())
        self.assertTrue((self.root/'skills/tabro-site-screenshots/references/tabro.md').exists())
        # Child file references inside a renamed folder must also map consistently.
        text=(self.root/'skills/tabro-site-screenshots/SKILL.md').read_text()
        self.assertIn('references/tabro.md',text)
        self.assertEqual('http://127.0.0.1:13618/mcp',yaml.safe_load((self.root/'config.yaml').read_text())['mcp_servers']['tabro']['env']['TABRO_BROKER_URL'])
        self.assertEqual('http://127.0.0.1:7331/mcp',yaml.safe_load((self.root/'profiles/worker/config.yaml').read_text())['mcp_servers']['tabro']['env']['TABRO_BROKER_URL'])
        m.verify_manifest(manifest)
        second=m.make_plan(self.root,self.base/'second',add_missing=True)
        self.assertEqual([],second['entries'])
        m.rollback_manifest(manifest,self.base/'backup')
        self.assertEqual(self.original,{str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_commit_failure_restores_entire_batch(self):
        with self.assertRaisesRegex(RuntimeError,'Injected'):
            self.apply(fail_after=2)
        self.assertEqual(self.original,{str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_concurrent_change_is_not_overwritten(self):
        manifest=self.plan();m.backup_manifest(manifest,self.base/'backup')
        p=Path(manifest['entries'][0]['source']);p.write_text('user edit')
        with self.assertRaisesRegex(ValueError,'Concurrent'):
            m.apply_manifest(manifest,self.base/'backup')
        self.assertEqual('user edit',p.read_text())

    def test_rollback_refuses_later_edits(self):
        _,manifest=self.apply();p=Path(manifest['entries'][0]['target']);p.write_text('later edit')
        with self.assertRaisesRegex(ValueError,'later edits'):
            m.rollback_manifest(manifest,self.base/'backup')
        self.assertEqual('later edit',p.read_text())

    def test_collision_rejected_before_write(self):
        self.write('skills/tabro-site-screenshots/SKILL.md','existing')
        with self.assertRaisesRegex(ValueError,'already exists'):self.plan()

    def test_conflicting_environment_rejected(self):
        d=yaml.safe_load((self.root/'config.yaml').read_text());d['mcp_servers']['tabro']['env']['TABRO_BROKER_URL']='http://127.0.0.1:9999/mcp'
        self.write('config.yaml',yaml.safe_dump(d))
        with self.assertRaisesRegex(ValueError,'Conflicting'):self.plan()

    def test_duplicate_yaml_key_rejected(self):
        self.write('skills/radar/references/platforms.yaml','octopus_browser_relay: 1\noctopus_browser_relay: 2\n')
        with self.assertRaisesRegex(ValueError,'Duplicate'):self.plan()

    def test_history_and_token_are_unchanged(self):
        self.apply()
        for rel in ['logs/history.log','skills/.curator_ledger.jsonl']:
            self.assertEqual(self.original[str(Path(rel))],(self.root/rel).read_bytes())
        self.assertEqual('octopus-is-part-of-a-real-token',self.token.read_text())

    def test_compatibility_paths_and_identities_survive(self):
        text=r'G:\funstuff\octopus-browser-relay\dist\main.js'+'\nio.github.ohmyskyhigh.octopus_browser_relay\noctopus-extension-baseline-v1\nOctopusDeploy\nOctopus Browser Relay'
        self.assertEqual(text.rsplit('\n',1)[0]+'\nTabro',m.brand(text))

    def test_chinese_prose_and_underscore_identifiers_migrate(self):
        self.assertEqual('须用Tabro实际Google验证 tabro_cdp_only Octopustank',
                         m.brand('须用Octopus实际Google验证 octopus_cdp_only Octopustank'))

    def test_root_escape_and_internal_backup_rejected(self):
        with self.assertRaisesRegex(ValueError,'outside'):m.make_plan(self.root,self.root/'report')
        with self.assertRaisesRegex(ValueError,'escapes'):m.safe_target(self.root/'..'/'outside',self.root)
        manifest=self.plan()
        with self.assertRaisesRegex(ValueError,'outside'):m.backup_manifest(manifest,self.root/'backup')

    def test_secret_and_id_fields_are_opaque(self):
        source={'token':'octopus','session_id':'octopus-123','title':'Octopus Relay','octopus_browser_relay':'value'}
        self.assertEqual({'token':'octopus','session_id':'octopus-123','title':'Tabro','tabro':'value'},m.transform_tree(source))

    def test_bom_crlf_preserved(self):
        p=self.root/'memories/USER.md';p.write_bytes(b'\xef\xbb\xbfPrefer Octopus.\r\n')
        self.apply()
        self.assertEqual(b'\xef\xbb\xbfPrefer Tabro.\r\n',p.read_bytes())


if __name__=='__main__':unittest.main()
