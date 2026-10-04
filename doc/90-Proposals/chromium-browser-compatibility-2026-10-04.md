# Chromium browser compatibility decision

## Approval

### The user approved compatible Chromium browsers and the implementation update

On 2026-10-04 the user clarified that the browser can be Chrome or a Chromium-based browser such as Microsoft Edge, then said to fix, update the PR and reply to the review. The applied scope is Chrome, Chromium and compatible derivatives, with capability checks and explicit qualification limits. A specific Chrome build is no longer the eligibility contract. Windows x64 remains the delivered package boundary.

## Ownership

### The compatibility decision flows from Product through setup and lifecycle owners

Product owns browser-family scope; UX owns selection and actionable prerequisites; System owns version/capability checks and exact process identity; Components owns setup and launcher behavior; Files maps the implementation and tests. The [delivery plan](../80-Plans/tabro-hermes-provider-2026-10-01/browser-compatibility-2026-10-04.md) records the chosen use of Hermes's existing application declaration.
