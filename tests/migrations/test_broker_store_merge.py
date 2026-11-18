from contextlib import closing
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('merge_broker', Path(__file__).resolve().parents[2] / 'tools/merge-broker-databases.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.primary, self.secondary, self.output = [self.root / name for name in ('primary.sqlite', 'secondary.sqlite', 'merged.sqlite')]
        for path, identity in ((self.primary, 'ordinary'), (self.secondary, 'demo')):
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT);'
                                 'INSERT INTO schema_migrations VALUES(1,"date");'
                                 'CREATE TABLE profiles(id TEXT PRIMARY KEY);'
                                 'CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT REFERENCES profiles(id));')
                db.execute('INSERT INTO profiles VALUES(?)', (identity,))
                db.execute('INSERT INTO events(profile_id) VALUES(?)', (identity,))

    def test_preserves_both_sources_and_renumbers_history_without_losing_rows(self):
        original = [p.read_bytes() for p in (self.primary, self.secondary)]
        report = module.merge(self.primary, self.secondary, self.output)
        self.assertEqual(report['events']['merged'], 2)
        self.assertEqual([p.read_bytes() for p in (self.primary, self.secondary)], original)
        with closing(sqlite3.connect(self.output)) as db, db:
            self.assertEqual(db.execute('SELECT id,profile_id FROM events ORDER BY id').fetchall(), [(1, 'ordinary'), (2, 'demo')])
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_conflicting_identity_aborts_without_creating_output(self):
        with closing(sqlite3.connect(self.secondary)) as db, db:
            db.execute('UPDATE profiles SET id="ordinary"')
            db.execute('UPDATE events SET profile_id="ordinary"')
        with self.assertRaisesRegex(ValueError, 'Conflict in table profiles'):
            module.merge(self.primary, self.secondary, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_a_foreign_key_violation(self):
        with closing(sqlite3.connect(self.secondary)) as db, db:
            db.execute('UPDATE events SET profile_id="missing"')
        with self.assertRaisesRegex(ValueError, 'foreign key'):
            module.merge(self.primary, self.secondary, self.output)
        self.assertFalse(self.output.exists())

    def test_never_overwrites_a_source_or_existing_destination(self):
        with self.assertRaises(ValueError):
            module.merge(self.primary, self.secondary, self.primary)
        self.output.write_text('keep')
        with self.assertRaises(ValueError):
            module.merge(self.primary, self.secondary, self.output)
        self.assertEqual(self.output.read_text(), 'keep')

    def test_initialized_real_schemas_reconcile_only_the_marker(self):
        migrations = sorted((Path(__file__).resolve().parents[2] / 'apps/broker/src/storage/sqlite/migrations').glob('*.sql'))
        for path in (self.primary, self.secondary):
            path.unlink()
            with closing(sqlite3.connect(path)) as db, db:
                for migration in migrations:
                    db.executescript(migration.read_text())
                    db.execute('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
                               (int(migration.name.split('-')[0]), 'date'))
                db.execute('INSERT INTO browser_rules_initialization VALUES(1, ?)', ('date',))
        original = [p.read_bytes() for p in (self.primary, self.secondary)]
        report = module.merge(self.primary, self.secondary, self.output)
        self.assertEqual(report['browser_rules_initialization'], {'primary': 1, 'secondary': 1, 'merged': 1})
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute('SELECT * FROM browser_rules_initialization').fetchall(), [(1, 'date')])
        self.assertEqual([p.read_bytes() for p in (self.primary, self.secondary)], original)

    def test_empty_source_and_version_mismatch(self):
        with closing(sqlite3.connect(self.secondary)) as db, db:
            db.execute('DELETE FROM events')
            db.execute('DELETE FROM profiles')
        self.assertEqual(module.merge(self.primary, self.secondary, self.output)['profiles']['merged'], 1)
        self.output.unlink()
        with closing(sqlite3.connect(self.secondary)) as db, db:
            db.execute('INSERT INTO schema_migrations VALUES(2, "date")')
        with self.assertRaisesRegex(ValueError, 'migration versions differ'):
            module.merge(self.primary, self.secondary, self.output)
        self.assertFalse(self.output.exists())

    def test_alias_and_publication_failure_leave_no_output(self):
        with self.assertRaisesRegex(ValueError, 'distinct'):
            module.merge(self.primary, self.primary, self.output)
        with patch.object(module.os, 'link', side_effect=OSError('simulated disk failure')):
            with self.assertRaisesRegex(OSError, 'simulated disk failure'):
                module.merge(self.primary, self.secondary, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.tabro-merge-*')), [])

    def test_concurrent_output_creation_is_never_overwritten(self):
        real_link = os.link
        def publish_after_another_writer(source, destination):
            Path(destination).write_text('other writer')
            real_link(source, destination)
        with patch.object(module.os, 'link', side_effect=publish_after_another_writer):
            with self.assertRaises(FileExistsError):
                module.merge(self.primary, self.secondary, self.output)
        self.assertEqual(self.output.read_text(), 'other writer')
        self.assertEqual(list(self.root.glob('.tabro-merge-*')), [])

    def test_unique_browser_nickname_conflict_with_real_migrations(self):
        migrations = sorted((Path(__file__).resolve().parents[2] / 'apps/broker/src/storage/sqlite/migrations').glob('*.sql'))
        for path, endpoint in ((self.primary, 'ep_one'), (self.secondary, 'ep_two')):
            path.unlink()
            with closing(sqlite3.connect(path)) as db, db:
                for migration in migrations:
                    db.executescript(migration.read_text())
                    db.execute('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
                               (int(migration.name.split('-')[0]), 'date'))
                db.execute('INSERT INTO browser_endpoints(endpoint_ref, nickname, created_at, updated_at) VALUES(?,?,?,?)',
                           (endpoint, 'duplicate', 'date', 'date'))
        with self.assertRaisesRegex(ValueError, 'Conflict in table browser_endpoints'):
            module.merge(self.primary, self.secondary, self.output)
        self.assertFalse(self.output.exists())

    def test_different_indexes_are_rejected(self):
        with closing(sqlite3.connect(self.secondary)) as db, db:
            db.execute('CREATE INDEX extra_index ON profiles(id)')
        with self.assertRaisesRegex(ValueError, 'indexes, triggers, and views'):
            module.merge(self.primary, self.secondary, self.output)
        self.assertFalse(self.output.exists())

    def test_real_schema_rejects_active_or_unresolved_work(self):
        migrations = sorted((Path(__file__).resolve().parents[2] / 'apps/broker/src/storage/sqlite/migrations').glob('*.sql'))
        for path in (self.primary, self.secondary):
            path.unlink()
            with closing(sqlite3.connect(path)) as db, db:
                for migration in migrations:
                    db.executescript(migration.read_text())
                    db.execute('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
                               (int(migration.name.split('-')[0]), 'date'))
        cases = {
            'browser_workspaces': "INSERT INTO browser_workspaces(workspace_ref,endpoint_ref,window_ref,lineage_ref,owner_session_ref,group_label,created_at,updated_at) VALUES('w','e','win','l','s','g','date','date')",
            'request_tickets': "INSERT INTO request_tickets(request_ref,tool_name,requester_session_ref,authority_scope,authority_session_ref,authority_lineage_ref,normalized_body_json,state,phase,checkpoint_json,accepted_at,updated_at) VALUES('r','t','s','owner','s','l','{}','running','x','{}','date','date')",
            'managed_browser_instances': "INSERT INTO managed_browser_instances(instance_ref,profile_ref,generation,browser_state,extension_state,observed_at) VALUES('i','p',1,'running','connected','date')",
            'leases': "INSERT INTO leases(lease_id,target_id,principal_id,fencing_token,expires_at,created_at) VALUES('l','t','p',1,'date','date')",
        }
        for table, statement in cases.items():
            with self.subTest(table=table):
                with closing(sqlite3.connect(self.secondary)) as db, db:
                    db.execute(statement)
                with self.assertRaisesRegex(ValueError, f'active or unresolved work in {table}'):
                    module.merge(self.primary, self.secondary, self.output)
                self.assertFalse(self.output.exists())
                with closing(sqlite3.connect(self.secondary)) as db, db:
                    db.execute(f'DELETE FROM {table}')


if __name__ == '__main__':
    unittest.main()
