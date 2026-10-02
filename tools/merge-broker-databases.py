from contextlib import closing
"""Merge two offline Broker stores into a new file without changing either source."""
import argparse
import json
from pathlib import Path
import sqlite3
import tempfile


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def backup(source, destination):
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as reader:
        with closing(sqlite3.connect(destination)) as writer:
            reader.backup(writer)


def merge(primary, secondary, output):
    primary, secondary, output = map(lambda p: Path(p).resolve(), (primary, secondary, output))
    if output.exists() or output in (primary, secondary):
        raise ValueError('The output must be a new file distinct from both sources.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='tabro-merge-') as temporary:
        candidate = Path(temporary) / 'candidate.sqlite'
        incoming = Path(temporary) / 'incoming.sqlite'
        backup(primary, candidate)
        backup(secondary, incoming)
        connection = sqlite3.connect(candidate)
        try:
            connection.execute('ATTACH DATABASE ? AS incoming', (str(incoming),))
            schemas = []
            for namespace in ('main', 'incoming'):
                schemas.append(dict(connection.execute(
                    f"SELECT name,sql FROM {namespace}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )))
            if schemas[0] != schemas[1]:
                raise ValueError('Both Broker databases must have exactly the same table schemas.')
            versions = [connection.execute(f'SELECT version FROM {ns}.schema_migrations ORDER BY version').fetchall()
                        for ns in ('main', 'incoming')]
            if versions[0] != versions[1]:
                raise ValueError('Broker migration versions differ.')
            # Only unreferenced AUTOINCREMENT history IDs can be renumbered.
            integer_ids = {}
            for table, schema in schemas[0].items():
                if 'AUTOINCREMENT' in schema.upper():
                    integer_ids[table] = next(col[1] for col in connection.execute(f'PRAGMA table_info({quote(table)})') if col[5])
            for table in schemas[0]:
                for foreign in connection.execute(f'PRAGMA foreign_key_list({quote(table)})'):
                    if foreign[2] in integer_ids:
                        raise ValueError('A referenced history ID requires an explicit migration before merging.')
            report = {}
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('PRAGMA defer_foreign_keys=ON')
            for table in schemas[0]:
                if table == 'schema_migrations':
                    continue
                before = connection.execute(f'SELECT count(*) FROM main.{quote(table)}').fetchone()[0]
                added = connection.execute(f'SELECT count(*) FROM incoming.{quote(table)}').fetchone()[0]
                columns = [col[1] for col in connection.execute(f'PRAGMA table_info({quote(table)})')]
                selections = list(map(quote, columns))
                if table in integer_ids:
                    key = integer_ids[table]
                    offset = connection.execute(f'SELECT coalesce(max({quote(key)}),0) FROM {quote(table)}').fetchone()[0]
                    selections[columns.index(key)] = f'{quote(key)}+{offset}'
                # Constraints reject identity/nickname/session conflicts instead of silently losing rows.
                connection.execute(f'INSERT INTO main.{quote(table)} ({",".join(map(quote, columns))}) '
                                   f'SELECT {",".join(selections)} FROM incoming.{quote(table)}')
                after = connection.execute(f'SELECT count(*) FROM main.{quote(table)}').fetchone()[0]
                if after != before + added:
                    raise ValueError(f'Row count mismatch in {table}.')
                report[table] = {'primary': before, 'secondary': added, 'merged': after}
            violations = connection.execute('PRAGMA foreign_key_check').fetchall()
            if violations:
                raise ValueError('The merged store contains foreign key violations.')
            connection.commit()
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('The merged store failed its integrity check.')
            connection.execute('DETACH DATABASE incoming')
            # SQLite backup includes WAL state; no raw copying of a live database file.
            with closing(sqlite3.connect(output)) as destination:
                connection.backup(destination)
            return report
        finally:
            connection.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('primary', 'secondary', 'output'):
        parser.add_argument('--' + name, required=True)
    arguments = parser.parse_args()
    print(json.dumps(merge(arguments.primary, arguments.secondary, arguments.output), indent=2))
