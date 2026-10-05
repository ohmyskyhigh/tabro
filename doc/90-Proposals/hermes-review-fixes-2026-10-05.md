# Hermes review decision

## Authority

### The user approved Teknium's three review requests and publication to main

On October 5, 2026, the user requested implementation of [Teknium's review](https://github.com/NousResearch/hermes-agent/pull/132619#pullrequestreview-5410318729), a catalog PR update and publication to main. This approves the narrow fixes below. The [delivery plan](../80-Plans/tabro-hermes-provider-2026-10-01/review-fixes-2026-10-05.md) records implementation and verification work.

## Ownership

### The fixes refine transport admission and setup without changing the MCP contract

Product's extension-backed automation, UX's automatic registration and named-profile setup, and the existing MCP contract remain the parents. System owns rejection of browser-page relay upgrades before registration while retaining Native Messaging. Components assigns this check to Extension Gateway. Files maps its integration tests and the Hermes environment probe. The exact accepted browser Origin is `chrome-extension://caekiojlchhifdomfghejkbfpmaklafe`; absent Origin remains valid for WinHTTP. This check is not authentication for arbitrary local processes.

Setup and Qualification retain custom install roots by declaring `TABRO_INSTALL_ROOT` in `mcp.json`. An unresolved placeholder uses the existing default; an explicit invalid path still fails. README and skill guidance must describe the actual behavior. README also discloses the existing AdsPower SunBrowser HKCU registration and random loopback remote-debugging port with `--enable-unsafe-extension-debugging` while broker-owned browsers are open. These disclosures add no browser capability.
