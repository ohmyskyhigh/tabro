from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

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
        with self.assertRaises(sqlite3.IntegrityError):
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


if __name__ == '__main__':
    unittest.main()
