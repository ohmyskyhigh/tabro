# Profile alias naming

## Decision

### The pairing alias is the sole public name of a Profile

Accepted from the user's October 3 instruction to remove the separate display name and either rename aliases or retain the existing aliases. Implementation retains `mapleglen`, `fairwave` and `cloudcanyon`. Profile discovery and lifecycle results expose `endpoint_nickname` without `display_name`; creation requires only an idempotency key and the extension assigns its alias through the existing pairing flow.

## Compatibility

### Contract version 4 removes the second name without changing stored browser identity

The Broker and adapter must agree on version 4. The user further clarified that the extra name must not be stored: remove the internal property and database column, remove the retired field from stored Profile ticket arguments/results, and normalize existing creation hashes to the key-only request. Existing profile references, directories, pairing aliases and browser data remain stable. No separate name or copied alias is stored on the managed Profile.
