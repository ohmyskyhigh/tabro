# Tabro 的 Hermes Provider 与一键安装方案

日期：2026-10-01；更新：2026-10-04。状态：Windows Portable Plugin 已实现并通过隔离安装检查，目录提交正在准备；其余平台和上游菜单仍待交付。证据见 [October 4 交付记录](./plugin-delivery-2026-10-04.md)。

父级：[开发计划](../_MOC.md)。下文十八工具与 0.3.1 是 October 1 计划基线；后续交付以[当前 MCP 契约](../../03-User-Interface/MCP-Contract.md)为准。October 4 的商城分发要求见下一节，优先于旧计划中仅复用本机运行环境的交付范围。

## 商城分发

### 首次设置必须下载安装 Broker 并包含现有代理能力

2026-10-04 用户已确认[全组件开源和首次安装要求](../../01-Product/Product-Definition.md#distribution)，对应[首次设置体验](../../02-User-Experience/User-Experience-Definition.md#first-time-hermes-setup-downloads-and-installs-the-local-browser-runtime)。公开发行必须覆盖没有 Tabro 的新机器；仅在开发者电脑上复用已有 Broker 的 M 阶段不能作为商城交付完成证据。

- [ ] 交付插件设置入口和安装流程，下载并安装配套 Broker、Adapter、Native Host、扩展及所需运行依赖，完成启动、注册和连接检查。
- [ ] 将现有代理实现和使用说明纳入发行内容，验证 HTTP/HTTPS 与 SOCKS5 账号密码代理，以及关闭 broker-owned Profile 后配置、重开应用和出口检查。
- [ ] 在没有 Tabro 的环境验证首次安装，并验证已有安装复用、重复设置和失败恢复；全部 Tabro 自有实现均遵循 Product 的开源要求。
- [ ] 完成插件校验和固定代码版本的目录提交；上架状态以 Hermes 维护者审核为准。

以上是 October 4 最初的完整交付门槛。后续 Windows 实现与已完成检查见[交付记录](./plugin-delivery-2026-10-04.md)；干净机器浏览器验收和上游收录仍待交付。拟采用与审核代码绑定的固定运行包版本和校验值；首次下载运行组件及后续更新机制须在提交中说明，并按[商城准入规则](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/catalog-submission)接受审核，不把通用下载器当作已获准的发行机制。

## 目标

### 用户在 Browser Automation 菜单选择 Tabro 后能够直接使用多身份浏览器工具

目标是在截图中的 `hermes setup` / `hermes tools` → Browser Automation → Choose a provider 中提供一行：

```text
Tabro [local · multi-profile] — Persistent Chrome identities and tab-group workspaces
```

“进入默认工具列表”在本方案中指新用户可以发现和选择 Tabro；不解释为强制安装、默认启用，或替换所有人的默认浏览器。首次选择下载与配置运行环境，完成后 Agent 可以调用 Tabro。是否进入 Hermes 的预置发现列表仍需上游接受。

- 本地先完成一个入口的安装、启动、注册和连接验收。
- 安装包包含 Windows PowerShell、Linux Bash 和 macOS Bash 入口，共用安装状态与核心流程；每个平台单独通过运行验收。
- 独立 Hermes 插件封装 MCP 入口、Skills 和接入说明；Tabro Broker 与扩展保持独立职责。
- 受管 Chrome 继续在创建或打开 Profile 时自动加载扩展并连接。
- 现有 Chrome Profile 仍支持手动加载扩展；安装器报告等待连接，不强行改变其数据目录。
- 向 Hermes 提出通用的 MCP 浏览器后端配置接口，再申请目录推荐或预置发现入口。

## 文档

| 文档 | 内容 |
| --- | --- |
| [技术架构](./technical-architecture.md) | 已验证接入点、插件内容、安装链路与上游接口缺口 |
| [执行 TODO](./implementation-tasks.md) | 安装、跨平台迁移、插件、菜单和上游工作的交付与验收 |

## 本机迁移

### 本机先迁移已有 MCP 接入，完整三平台安装与上游菜单随后交付

用户当前希望把已有接入转为 Plugin。先执行 TODO 的 M1–M5：制作复用现有运行环境的 Portable 插件，导入十四个 Hermes Profile 的连接信息，在 `tabro-1` 试点后逐个切换并验证。无需等待全新机器安装器或 Unix 运行层全部完成，也不以本机验证冒充三平台发行支持。

目标是实际由插件 `mcp.json` 提供十八工具，而不是只安装 Skill 后仍使用旧 `mcp_servers.tabro`。用户最新要求覆盖此前双 Broker 的保留安排：本机先统一为一个动态端口 Broker，十四个 Hermes Profile 和 Codex 共用 `.relay-data/runtime.json`；Demo 只保留演示站、trace 与输出。Chrome 身份数据不搬移。完整 Windows/Linux/macOS 安装、新机器部署和默认 Provider 菜单仍保留为后续里程碑。

两套 Broker 来自部署历史。运行合并独立备份并保留两侧身份、配对、请求与 Chrome 数据；后续 Plugin 直接接管共享发现记录，不再保存固定端口分组。实际结果见 [统一运行记录](../../99-Changelog/2026-10-01-shared-dynamic-runtime.md)。

Plugin 制作、安装与启用仍待执行；共享运行环境完成不等于 Plugin 迁移完成。

## 边界

### 一键安装与默认菜单可见是两个独立里程碑

| 里程碑 | 交付 | 完成证据 |
| --- | --- | --- |
| A：本地安装 | Windows、Linux、macOS 各有一个入口完成运行环境和 Hermes 接入 | 各目标平台在隔离环境发现十八工具并完成双 Profile 任务 |
| B：独立插件 | 可安装、启用、更新的 Hermes 插件包 | 插件发现 MCP、Skills，更新后登录和配对身份保留 |
| C：菜单接入 | Tabro 出现在 Provider 选择中 | 上游接受通用接口；选中、安装、状态和工具路由均通过测试 |
| D：默认发现 | 未安装 Tabro 的新用户也能看到选项 | 上游接受目录或预置发现政策；不是仅在本机改菜单 |

本机统一执行不修改 Hermes 核心代码，不发布插件，也不发送上游消息。

## 依据

### Hermes 的公开接口支持插件承载 MCP，但浏览器 Provider 仍以 CDP 会话为中心

October 1 核对快照：Hermes checkout `c2606ad109f5f169ed1fc611c494a41089095aeb`；当时 Tabro 源码版本为 0.3.1，README 表明该版本尚未发布安装包。该快照不代表当前版本或发行状态；旧包不能冒充本方案的合格发行版。

官方插件指南支持插件包携带 MCP 配置和 Skills；贡献指南要求第三方产品在独立插件仓库维护，通用接口扩展单独讨论。因此，独立包、通用接口和默认发现分别推进。参考：[Hermes 插件指南](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/)、[贡献指南](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md#third-party-product-integrations-ship-as-a-standalone-plugin)。

## 成功标准

### 安装完成必须证明 Agent 能执行任务，而不只是看到菜单名称

安装重复执行不产生重复 Broker；失败不破坏既有配置；两名独立 Agent 拥有不同会话证据；一个 Agent 能在两个 Chrome Profile 中完成本地任务，关闭重开保持身份。浏览器截图和页面事实验证真实执行，工具发现仅是第一道验收。交付目标覆盖 Windows、Linux 和 macOS，发布支持范围只包含已通过实机验收的平台、架构和 Chrome 组合；新增 shell 脚本不构成跨平台运行支持的证据。
