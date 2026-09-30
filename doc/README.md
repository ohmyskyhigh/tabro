# Tabro documentation

[English documentation](./README.md) | [简体中文文档](./zh-CN/README.md)

The documentation vault is the project source of truth. Begin with [`TOP-DOWN-MOC.md`](./TOP-DOWN-MOC.md) and read Product → User Experience → User Interface → System → Components → Files.

## Authority

### Canonical documents define intent before implementation evidence

Files under `01-Product` through `06-Files` are canonical in hierarchy order. A lower level realizes its confirmed parent and cannot silently redefine it.

## Governance

### Plans, proposals, and changelog records support but do not override the authority spine

- [`80-Plans`](./80-Plans/_MOC.md) describes intended development work.
- [`90-Proposals`](./90-Proposals/_MOC.md) holds unapproved changes and accepted historical proposals.
- [`99-Changelog`](./99-Changelog/_MOC.md) records applied vault changes.

Editing and evidence rules are in [`AGENTS.md`](./AGENTS.md).

## Translations

### Simplified Chinese operator documents translate public guidance without creating a second authority spine

[`zh-CN/README.md`](./zh-CN/README.md) routes Chinese readers to installation and architecture guidance. English canonical documents remain authoritative when wording differs.
