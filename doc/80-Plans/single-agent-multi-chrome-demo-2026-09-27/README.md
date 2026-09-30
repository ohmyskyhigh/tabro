# 受管 Chrome Profile 与单 Agent 多浏览器 Demo 更新方案

日期：2026-09-27。状态：已按用户授权实现，真实演示与升级回退已验证。目标里程碑：一个真实 Agent 会话通过 Octopus 查看已打开及未打开的受管 Profile，创建或打开后自动具备扩展连接，并操作三个独立浏览器。

## 执行入口

### 实施从环境基线开始并按 123 条 TODO 逐项验收

[实施任务](./implementation-tasks.md) 包含 13 个任务、123 条带稳定编号的实施 TODO、G0–G4 阶段门槛和执行证据表。用户已授权执行；四个生命周期工具、持久管理器、自动扩展引导和两轮真实 Demo 已实现。真实 Chrome 153.0.8010.53 实验报告位于 `artifacts/real-world/managed-probe-007/managed-chrome-probe/report.json`。最终证据与实现差异见实施任务的执行记录。

检查已修正：契约测试引用未创建文件、生产 schema 提前切换、G0 依赖后期演示站、实验依赖安装时机、请求表 CHECK 迁移、实例重连代次、长启动租约和演示摘要重叠窗口。canonical schema 与运行时工具在任务 3.1 成套切换；此前不把新接口文档当作已经可调用的工具。

## 目标

### 一个自然语言任务从创建三个 Profile 开始并完成各自的浏览器工作

用户已选择本地演示站和三个不同身份，并明确要求 MCP 列出 Octopus 管理的已打开与未打开 Profile；Agent 可以打开已有 Profile，或创建自动带扩展并建立连接的新 Profile。演示采用本地三账户待办站，固定 Chrome 153.0.8010.53。

展示创建与启动、身份隔离、多路任务和状态复用。所有浏览器动作由一个真实 Agent 会话经 MCP 发起。准备阶段只安装运行时、注册 Native Messaging 并启动测试站；Profile 创建和启动也发生在正式演示中。

## 管理模型

### 持久 Profile、运行实例和任务工作区分别承担不同职责

Profile 保存独立的 Cookie、网站存储和扩展身份；实例表示当前运行的浏览器；workspace 表示 Agent 此次任务控制的标签组。停止实例保留 Profile，重新启动得到新的运行实例。新 Profile 最初是空环境，不会自动拥有 Google 账户或网站登录状态。

建议新增 `list_browser_profiles`、`create_browser_profile`、`open_browser_profile`、`stop_browser_profile`。列表默认包含打开与关闭的受管 Profile；创建调用自动完成启动、安装/加载扩展和连接；打开调用复用已有 Profile 与身份。两者只有在浏览器可用时才返回终态成功。上述工具已在 MCP contract v2 的十八工具目录中提供。完整边界见 [MCP Profile 管理提案](../../90-Proposals/MCP-Managed-Chrome-Profiles.md)。

列表同时显示浏览器运行状态、扩展连接状态和是否可用。“Chrome 已打开但扩展未连接”必须可辨认，不能与“已就绪”混为一谈。Profile 关闭后和 Broker 重启后仍保留在目录中；打开已就绪的 Profile 复用当前实例。

## 更新路线

### 先交付单 Profile 的完整生命周期再扩展到三个浏览器演示

推荐以 Windows 本机运行作为首版范围，选定并固定一个实测通过的 Chrome 运行时。一个逻辑 Profile 对应一个独立 `user-data-dir`，其中使用默认 Chrome 配置文件；不将三个 Chrome 子 Profile 塞入同一个数据根目录。现有外部扩展端点继续用于浏览器工作，受管生命周期只覆盖 Octopus 创建的目录和实例。

| 阶段 | 改动 | 交付门槛 |
| --- | --- | --- |
| 0：可行性 | 基线与隔离环境、自动加载扩展的真实实验 | 空目录自动连接；原生标签组、页面操作、关闭重开全部通过 |
| 1：资源与契约 | 持久 Profile 目录、管理主体、MCP v2 设计与迁移 | 关闭的 Profile 可查；新会话可复用；旧数据完整 |
| 2：运行时 | Chrome Launcher、扩展 bootstrap、状态核对 | 创建直接就绪；并发打开只产生一个实例；失败可以恢复 |
| 3：MCP 与安装 | 四个工具、持久票据、适配器、安装升级 | 同一 Agent 可经 MCP 完成创建、打开、停止及重开 |
| 4：演示 | 同源三账户站点、单会话测试、独立验收 | 两轮真实演示证明三浏览器隔离、任务重叠与数据复用 |

新增核心组件为 Profile Repository、Profile Manager、Chrome Launcher 和 Managed Bootstrap。现有 Native Messaging、扩展 `chrome.debugger`、原生 Tab Group、请求轮询与标签页队列继续承担浏览器工作。四个新工具是在这些能力前面补齐资源生命周期。

### 新版本采用协调升级并明确区分 MCP 契约与扩展协议

建议 MCP 契约升为 v2，工具目录由 14 个变为 18 个，Broker 与 stdio 适配器一起升级；保留原有十四工具的工作语义。旧适配器须重启到新版本，不能承诺旧 schema 自动识别新结果。版本不匹配应在执行前给出明确错误，详见技术设计。

扩展 relay-v2 保持原有消息流程，增加可选的受管引导字段；新 Broker 继续接收不带该字段的外部扩展。只有受管流程要求新扩展和相应能力。Profile 功能开关控制是否允许创建和启动，不隐藏持久记录，也不改变既有暂停工具的含义。

### 自动安装接口可用性和进程恢复是第一阶段必须实测的风险

Puppeteer 官方提供 `enableExtensions` 和 `browser.installExtension()`，可用于自动加载本地扩展，但仍需验证本项目的 Native Messaging、固定扩展 ID 和 `chrome.debugger` 能否一起工作。[Puppeteer 扩展指南](https://pptr.dev/guides/chrome-extensions)

自动化连接用于安装、核对和正常关闭受管实例；页面任务仍通过现有扩展执行。Browser Launcher 必须验证自身退出是否连带结束 Chrome，以及 Broker 重启后是否能够重新识别、接管正确实例。阶段 0 未通过时，不把后续模块完成度当成可演示结果。

## 演示任务

### 三个测试账户在同一网址处理不同待办并生成各自摘要

Agent 创建并启动三个空 Profile，分别通过本地演示站的测试账户入口建立 Alice、Bob、Carol 的会话，然后都访问同一个 `/workspace` URL。固定演示日期，给每个账户准备内容和顺序不同的待办。测试站采用持久 Cookie，以便明确验证停止后再次打开的登录状态。

建议提示词：

> 使用 Octopus Browser Relay 先列出其管理的全部 Profile，包括未打开的。创建三个新的持久 Profile，自动打开浏览器、准备扩展并连接。在本地演示站分别使用 Alice、Bob、Carol 测试账户，找出各自最早到期的未完成事项，填写包含账户名和事项标题的备注，完成事项并生成摘要。交错推进三路工作并汇总。收尾后停止 Bob，再列出 Profile，确认 Alice、Carol 在线而 Bob 仍在列表中且已关闭；直接打开 Bob，验证扩展自动连接、登录和处理结果仍在。只使用当前 Agent，不创建子 Agent。

Profile 引用与端点昵称由创建、启动及发现结果获得，不能预先编造。每个账户的待办答案必须由 Agent 读页面得到。重开后重新发现窗口和工作区，不假设旧标签引用仍可用。

## 演示流程

### 正式演示依次呈现创建、启动、执行和持久状态复用

| 阶段 | Agent 动作 | 观众可见证据 |
| --- | --- | --- |
| 查看 | 经 MCP 列出全部受管 Profile | 已打开和未打开的资源都可查询 |
| 创建 | 三次创建调用各自自动打开浏览器并连接扩展 | 三个新资源、实际窗口和就绪结果 |
| 工作区 | 对创建结果返回的端点申请工作区 | 同一 Agent 控制三个不同配置文件 |
| 识别 | 建立各自测试账户会话，再打开同一 URL | 页面显示三个不同账户和不同内容 |
| 执行 | 分别选事项、填备注、提交并生成摘要 | 三路出现不同操作结果，慢任务等待时其他任务继续 |
| 核对 | 重新读取三个页面并汇总 | 汇总与页面及服务端记录一致 |
| 关闭与查看 | 保存证据，收尾并停止 Bob，再列出 Profile | Alice、Carol 在线，Bob 已关闭但记录仍在 |
| 复用 | 打开 Bob 的 Profile 并回读页面 | 自动连接且登录状态和处理结果仍在 |
| 收尾 | 保存全部证据，终止本轮工作区并停止受管实例 | 三个 Profile 均保留并显示为已关闭 |

首次演示使用三个实际浏览器窗口和 Agent 输出即可。汇总面板与故障注入放在后续迭代。站点视觉实现前另做参考调研；本计划只规定交互行为和证据。

## 范围

### 首版新增 Profile 生命周期并复用现有工作区执行能力

- 复用 Broker、SQLite、stdio 适配器、扩展、Native Messaging、票据与工作区管理。
- 新增 Profile Manager、持久管理记录、受管浏览器启动与停止、扩展自动引导及候选 MCP 工具，并按新契约版本实现。
- 新增同源多账户演示站、准备与验收工具、演示提示词和单会话三端点测试。
- 首选验证自动加载现有扩展并保留原生 Tab Group；普通 Chrome 可评估 CDP 扩展安装接口，Chrome for Testing 可作为固定版本基线。先跑通一个新 Profile 的自动引导，再扩展到三个。
- 运行时安装属于前置准备；每个 Profile 的创建、浏览器启动和扩展接入属于正式演示。workspace 工具仍只在已就绪窗口创建标签组。
- 已有 E2E 是三个独立 Agent 各操作一个端点；已有 A/B/C fixture 只是不同 URL 的标记页。这两者都不能单独充当本 Demo 的完整证明。

## 验收

### 成功必须同时证明单会话、三配置、真实操作和正确结果

1. 同一 `session_ref` 拥有本轮三个工作区，对应三个不同端点；没有子 Agent。
2. 三个真实 Chrome 配置文件通过 Native Messaging 连接；同一 URL 展示三个独立账户。
3. 每个账户仅修改规则选中的一条事项，备注准确，其他账户和事项未被改写。
4. 所有操作保存接受票据及后续状态；不把 `accepted`、页面变化或 CDP 成功单独当作业务成功。
5. 至少两路摘要任务的执行区间实际重叠，并且慢任务未阻止其他账户完成。这证明浏览器任务重叠，不宣称模型同时进行多路推理。
6. 最终汇总与页面回读、演示站记录一致；缺失证据、暂停和失败都不能显示通过。
7. 复位演示数据后完成两次真实演示；自动化模拟测试和真实演示分别报告。
8. 三个 Profile 都由本轮 Agent 通过 MCP 创建并启动，没有逐 Profile 手工安装扩展。
9. 停止保留配置数据，重新启动 Bob 后仍识别同一 Profile、扩展身份和测试账户，并读取原处理结果。
10. 列表默认包含已打开与未打开的受管 Profile；混合状态及 Broker 重启后记录都完整，未核对状态不会被误报为就绪。
11. 创建调用包含自动启动和扩展连接；若仅创建目录或进程已运行但连接未就绪，不能报告创建终态成功。
12. 对已就绪的 Profile 再次打开复用原实例；连接失败或创建部分失败保留资源引用和具体原因供再次打开，不重复创建 Profile。

## 文档

| 文档 | 用途 |
| --- | --- |
| [技术设计](./technical-architecture.md) | 组件、数据流、执行语义和证据边界 |
| [实施任务](./implementation-tasks.md) | 13 个任务、123 条 TODO、依赖、验收命令和证据登记 |

依据：[产品定义](../../01-Product/Product-Definition.md)、[用户体验](../../02-User-Experience/User-Experience-Definition.md)、[MCP 契约](../../03-User-Interface/MCP-Contract.md)、[系统架构](../../04-System/System-Architecture.md)、[组件](../../05-Components/Component-Architecture.md)、[文件地图](../../06-Files/Repository-Map.md)、[真实运行手册](../../06-Files/Real-World-Runbook.md)。获准后的 canonical 更新已同步到上述规范与 changelog。
