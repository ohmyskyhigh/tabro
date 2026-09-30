# MCP 管理 Chrome Profile 的实施决策

日期：2026-09-27。状态：用户已授权执行，四个工具与 MCP v2 已实施并同步 canonical；真实演示及升级回退证据见实施任务。本文保留批准时的设计依据。

## 确认需求

### MCP 必须列出 Octopus 管理的 Profile 而不只列出当前在线扩展

用户要求能够管理已打开与未打开的 Chrome Profile，并通过 Octopus Broker MCP 查看其控制的 Profile。Profile 列表因此是持久资源目录：关闭浏览器、扩展断开或 Broker 重启，不会使该 Profile 从列表消失。运行状态和连接状态应反映当前观测，不能把历史连接记为当前可用。

### Agent 可以打开已有 Profile 或创建自动带扩展并连接的新 Profile

用户要求 Agent 直接打开已有 Profile，或创建一个新的 Profile；新 Profile 应具备 Octopus 扩展并自动建立连接。新增 Profile 的公开创建旅程必须包含准备、启动、扩展安装/加载、认证及就绪检查，不能把空目录创建完成当作用户要求已经完成。

已有 Profile 重新打开时保留其数据和扩展身份，并检查扩展是否可用、是否需要加载或修复，完成连接后交还可操作端点。安装运行时和 Native Messaging 的一次性准备仍属于宿主环境前置条件，不转嫁为逐 Profile 手工安装操作。

## 产品方向

### Agent 可以从创建持久 Profile 开始完成浏览器任务

增加 Octopus 自行创建和管理的浏览器配置文件：创建、发现、启动、停止、重新打开。每个配置文件使用独立的 user-data-dir，启动一个独立浏览器实例。Profile 是持久资源，运行实例是可更换资源，workspace 继续是 Agent 的任务归属和托管标签页容器。

这里的 `profile_ref` 是 Broker 签发的逻辑资源引用，不是 Chrome 内部 profile ID，也不是可由 Agent 指定的本机文件路径。它不等同于 Google 账户；新建后尚未登录任何网站。

现有外部 Chrome/AdsPower 扩展连接可继续存在。生命周期工具只控制 Octopus 管理的实例，不因某个外部端点已连接而获得关闭外部浏览器的权限。

## 交互

### 四个候选工具覆盖持久目录与创建打开关闭的操作

| 候选工具 | 建议职责 |
| --- | --- |
| `list_browser_profiles` | 默认分页包含调用者可见的已打开与已关闭受管 Profile，同时返回运行、扩展连接和可用性事实 |
| `create_browser_profile` | 创建持久记录及独立目录，自动启动、安装/加载扩展并连接；终态成功返回 `profile_ref` 和已就绪端点 |
| `open_browser_profile` | 使用已有 `profile_ref` 打开并确保扩展连接就绪；若已运行则复用实例，不另开一份 |
| `stop_browser_profile` | 核对管理权限与工作区状态，停止本产品启动的实例，保留配置数据 |

工具名是设计建议；其中创建与打开明确按用户要求完成自动连接。创建、打开和停止建议复用接受票据后查询 `get_browser_request` 的流程。接受回复只表示请求已登记；创建/打开票据的终态成功要求可用性核对通过。具体输入、输出、管理授权、重复请求和暂停语义需写入新的 MCP 契约版本，不能仅增加目录项而继续宣称旧 schema 完整有效。

### 浏览器已打开与扩展可控制必须作为不同事实呈现

建议列表每项至少包含 Broker 签发的 Profile 引用、名称、浏览器运行状态、扩展连接状态、是否可用、最近观测时间、可关联的端点以及错误原因。内部状态与 Agent 可发起的动作分开。展示可以派生为“已关闭”“启动中”“已打开但未连接”“已就绪”“异常”，但不能仅依赖单一 socket 布尔值。

| 场景 | 列表中的事实 | 打开操作的预期行为 |
| --- | --- | --- |
| 已保存但浏览器未运行 | 保留 Profile，报告已关闭 | 启动同一数据目录并自动连接 |
| 浏览器运行且扩展就绪 | 报告已打开、已连接、可用 | 返回当前实例及端点，不重复启动 |
| 浏览器运行但扩展未连接 | 报告已打开、未连接、不可用 | 核对原实例并恢复连接或明确失败，不复制 Profile |
| 创建记录后启动失败 | 保留已分配 Profile 和失败原因 | 后续打开继续处理同一 Profile，不自动生成第二份 |
| Broker 重启后尚未核对 | 保留 Profile，报告状态待核对 | 先验证进程身份、锁和握手，不假报关闭或在线 |

受管 Profile 目录是列表的基础数据源，进程与扩展注册表提供运行观测。只有来源明确且具备管理信息的 Profile 才可提供打开/关闭动作；仅有历史外部扩展端点记录，不能推导其启动路径。自动扫描或导入用户全部 Chrome Profile 不属于这次确认的需求。

### 一次创建调用完成从资源登记到可用端点的完整流程

建议内部顺序为：持久登记并分配 `profile_ref` → 创建空目录 → 启动 Chrome → 自动准备扩展 → 扩展身份认证 → Profile 与端点精确关联 → 新鲜 inventory 核对 → 成功返回。阶段事实记录到票据；例如浏览器已打开但 Native Messaging 失败，应返回具体失败阶段和已创建资源引用。

打开已有 Profile 使用同一就绪链路，但不重新创建资源或重置登录和配对身份。同一 Profile 的并发打开应合并到已有启动实例或明确返回正在启动，不产生两个进程占用同一个数据目录。停止后 Profile 继续可见。

管理权限与 workspace 的 session 所有权分开。建议 Profile 管理权绑定持久调用主体，以便新会话重新使用；停止前必须核对所有受影响工作区的权限和执行状态。首版演示只使用当前会话新建的资源，默认先终止这些工作区，再停止实例。`kill_browser_endpoint` 保留现有“暂停自动化”语义，不能改成杀浏览器进程。

首版不需要删除或导入 Profile，也不需要复制已有浏览器数据。重命名、删除、共享和代理配置可以单独设计。

## 实现路线

### 自动加载现有扩展可以使用安装协议而不局限于旧启动参数

建议在安装阶段准备固定版本的受支持 Chrome 与 Native Messaging 注册。Chrome for Testing 仍可作为可复现的测试基线，但不是自动装载扩展的唯一发行版选择。创建 Profile 时分配空目录；以该版本要求的自动化配置启动后，通过 CDP `Extensions.loadUnpacked` 或相应 WebDriver BiDi 接口安装本地构建扩展。Puppeteer 已封装 `enableExtensions` 和 `browser.installExtension()`。随后由扩展建立独立密钥并连接，再进入现有 workspace/CDP 流程。

安装阶段使用管理器私有的自动化连接，业务页面仍走 Native Messaging 和 `chrome.debugger`，不要求改成直接 CDP 执行业务。该初始化连接本身也需要纳入规范，不能继续声称整个产品从不打开调试端口或管道。连接是否在安装后可断开、断开与重启是否保持扩展正常工作，必须通过所选版本的实测确定。

Profile Manager 管理目录、进程、启动代次与端点关联。关联不能靠连接顺序、全局连接数量或昵称猜测：建议使用每次启动专属的一次性 bootstrap 凭据，绑定扩展公钥认证及启动代次。凭据仅在受控的本地配置与握手中流转，不进入 Agent 输出；不能复制其他 profile 的扩展存储、密钥或 endpoint ID。

`ready` 必须表示启动的浏览器确实可被 Octopus 使用；进程存在、扩展 socket 已连接均不足以宣布成功。原有启动者崩溃后恢复进程管理，需要核对 PID、启动时间、可执行文件与数据目录。相同 Profile 同时只能有一个活跃启动实例。

停止应先完成工作区收尾并正常关闭浏览器，以验证持久数据落盘。PID 重用、实例已被外部启动、未完成请求、关闭超时必须产生明确失败或待处理事实，不能按进程名批量结束 Chrome。

### 直接 CDP 是独立备选路线并会改变现有传输约定

另一条曾讨论的路线是由 Broker 启动带私有调试连接的浏览器，并增加 direct-CDP adapter。这会影响目前“扩展是唯一控制传输”的 Product/System 约定，以及标签组、能力、事件与恢复实现。用户最新要求已明确保留扩展及自动连接；直接 CDP 执行业务保留为历史备选，不是当前目标流程。

首选路线若无法实现无人值守启动，应明确报告具体阻塞并比较备选，不能静默切换到另一种传输后宣称原链路已经通过。

## 验证

### 最小实验先证明一个空 Profile 可以全自动成为可用端点

第一道门槛：新目录 → 可见浏览器 → 自动加载扩展 → Native Messaging 认证 → 精确关联 Profile → inventory 可用 → 执行一次托管标签页 CDP。过程不能要求逐 Profile 手工加载扩展。

第二道门槛：写入有有效期的测试 Cookie 和 localStorage → 正常停止 → 用同一 `profile_ref` 重新启动 → 从页面读取原值，扩展身份保持一致。使用新的工作区或按规范恢复，不要求旧 tab_ref 无条件继续有效。

第三道门槛：同时创建三个 Profile，验证目录、扩展密钥、端点和账户独立，乱序握手也不串映射；一个实例启动失败不影响其余已启动实例。

## 规范影响

### 新能力需要从 Product 向下补齐定义而不是只增加启动脚本

Product 增加受管 Profile 与生命周期范围；UX 增加创建到复用的旅程；UI 定义候选工具、引用、授权与新契约版本；System 定义进程与连接核对；Components/Files 定义管理器、存储、引导及安装实现。此前已连接扩展的浏览器工作流程可复用。

这是对已有 Demo 计划的方向调整，具体细节保留在本提案及 [演示计划](../80-Plans/single-agent-multi-chrome-demo-2026-09-27/README.md)，当前不改写规范或运行时代码。

### 更新方案先交付单 Profile 闭环再验证单 Agent 的三浏览器任务

详细建议已收敛到 [技术设计](../80-Plans/single-agent-multi-chrome-demo-2026-09-27/technical-architecture.md) 和 [实施任务](../80-Plans/single-agent-multi-chrome-demo-2026-09-27/implementation-tasks.md)：Windows 本机、独立数据目录、四个生命周期工具、MCP v2 与适配器协调升级、持久 principal 管理权、每 Profile 操作队列、一次性认证引导及数据库迁移。原有十四工具语义和外部扩展接入保持。旧适配器需要升级，不能宣称新增工具对旧 schema 透明兼容。

实施门槛依次为真实自动引导实验、目录与契约、浏览器运行时、MCP/安装闭环、两轮三浏览器演示。以上具体技术选择是推荐方案，未变为规范事实或已实现能力。

## 参考

### PinchTab 的持久 Profile 与运行实例区分可供借鉴

检查日期：2026-09-27。[PinchTab Core Concepts](https://pinchtab.com/docs/core-concepts/) 将 Profile 定义为持久浏览器数据目录，允许停止后再次启动；实例是运行资源。[其 MCP 参考](https://github.com/pinchtab/pinchtab/blob/main/skills/pinchtab/references/mcp.md) 当前将 Profile 创建、编辑和删除列为 CLI/HTTP 操作，未将它们作为 MCP 工具提供。因此本提案借鉴其资源模型，并按用户要求把管理旅程放进 Octopus MCP。

### 移除旧参数不意味着普通 Chrome 无法自动安装扩展

[Chrome 官方公告及后续答复](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY) 说明普通 Chrome 从 137 起移除 `--load-extension` 支持，而 Chromium 与 Chrome for Testing 保留；同一讨论中 Chrome 团队明确给出 CDP `Extensions.loadUnpacked` 和 WebDriver BiDi 的替代路径，并说明新的 Puppeteer 方法面向各 Chrome 通道。

[当前 Puppeteer 指南](https://pptr.dev/guides/chrome-extensions) 提供启动时加载和运行时安装扩展的方法；[其实现](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Browser.ts) 调用 `Extensions.loadUnpacked`。自动化安装适用于按要求启动的受管浏览器，不等于向任意已运行的普通用户浏览器无条件注入扩展。本项目仍需实测固定版本、启动选项、Native Messaging、扩展身份、Tab Group 和停止重开行为。
