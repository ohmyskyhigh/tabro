# Fix macOS release qualification

## Objective

Repair macOS release checks, verify Apple Silicon and Intel qualification, and perform the user's single authorized commit and push.

## Changes

Kept the temporary macOS Keychain alive for the complete native qualification suite. The old workflow made the fixture the default Keychain, then deleted it before starting the input-only Chrome test; neither the default nor search list was restored. Chrome can block on Keychain access during encrypted storage initialization, as documented in [Chromium's implementation](https://chromium.googlesource.com/chromium/src/+/1b0837a60b07719c4c4d8804ec83d1c24fd12122/components/os_crypt/sync/os_crypt.h). The workflow now serializes the vault, installer and input tests within that lifetime, restores the original default and search list before deletion, and verifies the input report. Production Chrome configuration and the real OS credential-vault tests retain their existing security behavior.

Fixed test synchronization: register the simulated extension's operation listener before AUTH, explicitly receive and answer startup inventory alongside READY, and wait for observable broker state instead of 5/10-millisecond sleeps. Multi-agent checks wait for the public profile-readiness result. A promise controls the intentionally blocked CDP command, replacing the assumption that an 800-millisecond delay outlasts other agents. Dashboard qualification waits for the restored viewport and compositor frames, checks panel visibility, and checks input focus before typing. The input fixture retains its original startup deadline and now records bounded transport metadata and Chrome stderr for failures without recording authentication payloads.

## Result

The original commit's Intel rerun reproduced an inventory assertion before asynchronous delivery completed; the ARM64 rerun again failed only after the preceding step deleted the default Keychain. Twelve isolated local Chrome startup probes passed, consistent with the CI-specific Keychain lifecycle difference.

Local lint, type checking, 321 source tests, 2 end-to-end tests, build and ARM64 packaging passed. Twenty-one transport and multi-agent tests passed in five consecutive runs. The four native tests passed with both Chrome for Testing and ordinary Google Chrome 157.0.8103.50 on macOS ARM64. Workflow YAML/Python syntax passed; an isolated subprocess mock verified original-Keychain restoration after successful and failed tests without modifying this host's Keychain settings. Evidence is under `artifacts/qualification/macos-fix/`.

This entry records the pre-commit validation. Exact-commit ARM64/Intel CI outcomes are reported in the chat after the authorized push. The commit must not imply a published release. The three unrelated pre-existing untracked changelogs remain outside this change.

After the single authorized push of `336fcf5`, macOS ARM64 job `131215317540` passed the complete native qualification. Intel job `131215317697` passed all source tests but its three-agent end-to-end test reached the suite's 15-second test deadline. The follow-up gives these two multi-session transport scenarios a 60-second whole-test budget and the production 45-second heartbeat timeout; their per-operation readiness deadlines and assertions remain intact. Lint, type checking and all 21 affected tests passed locally. The user explicitly renewed commit/push authorization for this follow-up; its exact-commit native CI results will be reported in the chat.
