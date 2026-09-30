# Persistent custom pairing labels

## Decision

### Operators can customize a profile-local pairing code without replacing its cryptographic identity

Accepted by the user on 2026-09-04. A new extension profile still generates a two-word pairing code automatically, but the options page also accepts a user-selected code containing two three-to-eight-letter words. The normalized uppercase code is stored in profile-local extension storage and remains the authoritative source of the lowercase endpoint alias across browser windows, service-worker restarts, and reconnects.

### An existing endpoint changes its alias only after challenge authentication succeeds

The extension includes its saved code and derived alias when reconnecting. The broker verifies the existing profile key before changing the endpoint name, then updates the retained legacy target alias and canonical browser-endpoint nickname atomically. The readable code remains a human correlation label, not an authentication credential.

## Consequences

### A naming collision preserves the requested code until the operator changes it

The broker rejects an alias owned by another endpoint. The extension displays the conflict and stops reconnecting instead of silently generating a different label. Reset pairing remains the explicit operation that replaces the profile key, code, and endpoint identity together.
