# 架构与 MCP

本说明帮助中文读者理解 Tabro 的运行边界和 18 个 Agent 工具。规范性定义仍由英文 [System Architecture](../04-System/System-Architecture.md) 和 [MCP Contract](../03-User-Interface/MCP-Contract.md) 拥有。

## 目标

### Broker 在不公开 Chrome 调试端口和私有 ID 的情况下协调多个 Agent 与浏览器配置文件

每个浏览器配置文件拥有一个扩展端点。Agent 不直接连接扩展，也不接触 Chrome 的窗口、标签页、调试器 Session 或 WebSocket ID。Broker 通过公开引用建立以下关系：

```text
agent session
  -> endpoint nickname
    -> window_ref
      -> workspace_ref
        -> tab_ref
          -> request_ref / event cursor
```

公开引用由 Broker 签发，Agent 只能原样回传。两词配对代码和端点昵称由扩展生成，用于识别配置文件，不是 Agent 创建的 ID。

## 组件

### 八个规范组件分配运行时、协议、浏览器和验证责任

| 规范组件 | 责任 |
| --- | --- |
| Broker Runtime | 组合运行组件、启动锁、健康和运行记录发布 |
| MCP Gateway | 会话 stdio 适配、18 工具 Schema、身份注入、票据交付与发现重连 |
| Broker Core | 工作区所有权、票据、FIFO、控制和恢复；Broker 内的 Profile 管理器处理主体所有权与生命周期 |
| Durable Store | SQLite 端点、会话、工作区、Profile、票据、检查点、事件和审计 |
| Extension Gateway | relay-v2 认证、代次与消息关联；Native Host 提供浏览器到 loopback 的传输 |
| Browser Extension | 自动配对、清单、原生标签组和 `chrome.debugger` 执行 |
| Protocol Contract | MCP v2、relay v2、运行记录 v1、能力清单与共享版本 |
| Setup and Qualification | 安装、更新、共享启动、显式迁移与验证证据 |

### Demo 与普通 MCP 通过运行记录发现同一个本地 Broker

MCP 和 relay 是同一进程的两个 loopback 接口，默认端口均为 `0`，实际地址写入运行记录。普通 MCP 注册使用 `TABRO_RUNTIME_FILE` 与独立令牌文件；适配器校验记录及 health 实例标识，在新调用前处理 Broker 实例变化，保留会话身份，不重试已经派发的调用。

Native Host 每次连接读取可执行文件旁的 `relay-runtime.json`，校验版本、进程存活和本地 relay URL；仅记录不存在时沿用旧配置 URL，记录存在但无效时失败。其校验不等于适配器的 HTTP 实例握手。启动助手复用健康实例，Broker 数据目录锁拒绝第二个存活所有者。Demo 退出仅关闭自己的站点。

## 请求周期

### 浏览器影响操作遵循“请求票据 → 执行 → 监控”的完整周期

1. Agent 调用异步工具。
2. Broker 持久化票据并返回 `request_ref`。
3. Broker 在确认票据响应已经交付后才允许浏览器动作进入调度。
4. Agent 用 `get_browser_request` 读取 `queued`、`running`、暂停条件和最终结果。
5. 扩展断线时，Broker 暂停请求并记录检查点。
6. 扩展重连后先上报清单，Broker 协调实际标签页状态，再从检查点恢复或请求人工确认。

模型不创建请求、Profile、窗口或标签页引用及游标。`create_browser_profile` 的 `idempotency_key` 则由调用者提供，用来避免重复创建；它不是 Broker 签发的资源引用。

## 同标签页并发

### 同一工作区和标签页的 CDP 请求从接受到终态保持 FIFO

同一 `(workspace_ref, tab_ref)` 的命令按 Broker 持久接受顺序进入一条私有队列。队首请求在预派发等待、扩展执行、断线暂停、协调和人工确认期间保持队首，直到终态提交。后续请求不得越过它。不同标签页、工作区或端点之间的调度由系统负责，不向 Agent 暴露队列位置或优先级 ID。

## 控制

### 停止、端点 Kill、接管和终止使用独立控制边界

- `stop_workspace_automation` 添加工作区手动暂停原因；
- `resume_workspace_automation` 协调状态后只清除手动暂停；
- `kill_browser_endpoint` 暂停调用者完整拥有的一个端点上的所有工作区；
- `resume_browser_endpoint` 协调后只清除端点 Kill 原因；
- `take_over_workspace` 原子转移工作区和相关活动票据的所有权；
- `terminate_workspace` 阻止新工作、失败尚未开始的工作、协调已派发工作，确认归档后结束工作区。

已派发浏览器效果不会被假定取消。系统通过协调获得事实。

## 工具目录

### 三类 18 个工具保持读取、异步工作和立即关闭的语义分离

| 类型 | 工具 | 作用 |
| --- | --- | --- |
| 读取 | `list_browser_profiles` | 列出持久 Profile，包括已停止的浏览器和观测到的就绪状态 |
| 异步 | `create_browser_profile` | 创建持久 Profile，启动 Chrome 并建立扩展连接 |
| 异步 | `open_browser_profile` | 打开已有 Profile 或复用正在运行的实例 |
| 异步 | `stop_browser_profile` | 在活动工作结束后正常关闭 Profile |
| 读取 | `get_browser_context` | 分页读取 Broker、端点、窗口、能力、工作区、标签页或票据摘要 |
| 异步 | `request_browser_workspace` | 在不同合格端点上申请精确数量的工作区 |
| 异步 | `create_browser_tab` | 在已拥有工作区创建托管标签页 |
| 异步 | `send_cdp_command` | 向一个托管标签页提交能力清单允许的原始 CDP 命令 |
| 读取 | `read_cdp_events` | 从 Broker 签发游标读取保留事件 |
| 读取 | `get_browser_request` | 读取一个有权限的票据 |
| 异步 | `take_over_workspace` | 接管精确标识的工作区 |
| 异步 | `terminate_workspace` | 协调运行工作、归档标签组并结束工作区 |
| 异步 | `resolve_browser_request` | 对等待人工确认的票据提交确认决策 |
| 立即 | `close_browser_request` | 从公开视图关闭终态票据，保留审计记录 |
| 异步 | `stop_workspace_automation` | 手动暂停一个工作区 |
| 异步 | `resume_workspace_automation` | 协调并恢复手动停止的工作区 |
| 异步 | `kill_browser_endpoint` | 暂停一个完整拥有端点的所有活动工作区 |
| 异步 | `resume_browser_endpoint` | 协调端点并清除端点 Kill |

精确字段、枚举、必填项、分页和输出联合类型只以英文 [MCP JSON Schema](../03-User-Interface/MCP-Contract.schema.json) 为准。

## CDP 边界

### 扩展只执行能力清单允许且限制在托管标签页的 CDP 方法

能力清单位于 [`extension-baseline.json`](../../apps/shared/protocol/capabilities/extension-baseline.json)。它包含选定的 Accessibility、DOM、Emulation、Input、Network、Page 和 Runtime 方法。Broker 在派发前检查能力；扩展再次验证目标和代次。浏览器级 Target 控制和公开调试端口不属于普通 Agent 接口。

## 受管身份

### Profile 属于认证主体，工作区仍属于 Agent 会话与 lineage

受管环境启用后，Agent 可列出打开和关闭的 Profile，通过 create/open 的票据得到 ready 端点，再沿既有工作区流程执行网站操作。stop 会拒绝活跃工作并保留 Cookie、存储和扩展身份。普通外部端点不会自动获得进程管理权限。

已记录的实机资格是 Windows / Chrome 153.0.8010.53。私有 loopback 管理连接用于启动引导、实例核对和正常关闭；网站 CDP 仍经扩展执行。跨平台安装、Hermes Plugin 和默认 Provider 菜单见[待办计划](../80-Plans/tabro-hermes-provider-2026-10-01/README.md)。

## 更新边界

### Broker 只有在扩展版本匹配后才允许该端点执行浏览器工作

Release 更新器先替换稳定扩展目录，再启动目标 Broker。relay `READY` 公开 Broker 版本、要求的扩展版本和是否重载。版本不匹配的扩展最多自动重载一次，重新认证并发布清单后才成为可工作端点。重复不匹配会失败关闭，避免重载循环。

## 状态和安全

### 本地 loopback、会话身份、所有权和持久审计共同限制控制范围

- MCP 与 relay 默认只监听 loopback；
- stdio 适配器在模型参数之外提供 Agent 会话事实；
- Broker 检查当前工作区所有权和控制代次；
- 扩展保留 Chrome 私有 ID，不把它们公开给 Agent；
- SQLite 保存公开票据、检查点、事件和审计事实；
- 令牌、扩展私钥、SQLite 和浏览器私有状态不得提交到 Git。

Parent: [`中文文档`](./README.md).
