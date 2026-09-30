# Persistent custom pairing labels

## User experience

### Pairing codes now remain editable and stable across ordinary reconnects

The extension settings page now accepts a two-word pairing code, previews its derived alias, stores the normalized value in profile-local extension storage, and reconnects with the saved label. New profiles still receive an automatically generated default.

### Naming collisions now require an explicit operator choice

The extension preserves a colliding saved code and shows the broker error instead of silently changing the profile label.

## Implementation

### Authenticated reconnects synchronize legacy and canonical endpoint names

Relay-v2 carries the requested alias through challenge authentication. After proof of the existing profile key, the broker atomically updates the legacy target alias and canonical browser-endpoint nickname.

## Verification

### Automated coverage proves persistence, secure renaming, and conflict rollback

Unit and contract tests cover profile-local identity persistence, custom-code normalization, and the editable options control. Integration tests cover authenticated rename and atomic rollback when another endpoint owns the requested alias.
