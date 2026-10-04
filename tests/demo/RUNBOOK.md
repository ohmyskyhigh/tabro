# 单 Agent 三浏览器演示运行手册

## 前置条件

### Windows 上的 Chrome 153.0.8010.53 已验证自动加载扩展

从仓库根目录运行 `pnpm verify`。默认浏览器为 `C:\Program Files\Google\Chrome\Application\chrome.exe`；其他版本/平台未验证。运行时在安装时准备，不在创建 Profile 时下载。

Native Messaging host 一次性注册并允许扩展 ID `caekiojlchhifdomfghejkbfpmaklafe`。开发安装入口为 `pwsh -NoProfile -File tools/install-local.ps1 -Install -EnableManagedProfiles`；已有环境应先核对注册。受管 Profile 自动加载扩展，不需逐个进入扩展管理页。

## 启动

### 准备命令只启动基础设施而不代替 Agent 操作浏览器

```powershell
pnpm build
pnpm exec tsx tools/prepare-single-agent-demo.ts --run-id=demo-new-run --port=7341
```

每轮使用新 run ID；已有目录或端口占用会报错，不清除旧记录或结束其他进程。输出的 manifest 记录实际 URL、服务 PID、token 文件路径和 trace 目录，不输出 token。本轮演示站、trace 和输出位于 `artifacts/real-world/<run-id>/single-agent-demo/`；Broker 数据库、令牌和 Chrome 身份目录继续使用共享安装的位置。

### 准备入口复用共享 Broker，退出只关闭本轮演示站

默认准备入口调用 `tools/start-local-broker.ps1`，然后读取 `.relay-data/runtime.json` 与 `.relay-data/admin-token.txt`。MCP 和 relay 由系统分配端口；`--port` 仅指定演示站端口。可用 `--runtime-file=<path>` 与 `--token-file=<path>` 指向已有安装，此时准备器要求该 Broker 已运行。受管功能必须事先启用。

manifest 同时保存 runtime 文件路径和当时的 `mcpUrl`。当前 `single-agent-demo-call.ts` 仍将该 URL 传给适配器，不能把普通 MCP 注册的自动重连能力当作这个辅助入口的保证。若 Broker 在本轮重启，先从同一 runtime 文件核对新实例，再刷新 manifest 的 `mcpUrl`；保留 `runtimeSession`、既有票据和 trace，先检查原票据状态，不重放可能已派发的调用。

## 操作

### 一个 Agent 使用真实 MCP 结果建立三路资源分工

四个管理工具为 `list_browser_profiles`、`create_browser_profile`、`open_browser_profile`、`stop_browser_profile`。后三个返回异步票据，用 `get_browser_request` 等待终态；创建/打开仅在 `succeeded` 且 `ready: true` 时成功。create 只传 `idempotency_key`，同一主体同键复用原 Profile。扩展生成的 pairing alias 是唯一名称；Alice、Bob、Carol 是本次演示的账户分工，不是 Profile 显示名称。

演示提示词：

> 列出受管 Profile，创建三个新 Profile，分别用于 Alice、Bob、Carol。按返回端点昵称申请三个工作区，访问同一演示 URL，分别选择对应身份。读取待办，完成各自最早到期的未完成事项，备注为 Reviewed by 对应姓名。先处理三路事项，再连续发起三个摘要，等待并回读结果。终止 Bob 工作区、停止 Bob 使用的 Profile，核对列表中的混合运行状态，再打开它验证登录、任务和身份保持。重复 open 应复用实例。最后终止全部工作区并停止三个 Profile，确认目录仍保留。

Agent 可使用 `tools/single-agent-demo-call.ts <run-id> <commands.json>` 传送显式工具调用数组。每项包含 `tool`、`arguments`、可选 `wait: true`，后者仅轮询票据；脚本不选择账户、任务或答案。批次沿用 manifest 中同一个 runtime session。可选 `adapterEntry` 指向打包版 adapter。

业务页面经 MCP → Broker → Native Messaging → 扩展 debugger 执行；workspace 仍对应原生 Tab Group。私有 loopback CDP 仅用于引导、实例核对和正常关闭。

站点固定参考日期 2026-09-27/Asia/Shanghai，持久 Cookie 隔离三账户。摘要耗时 Alice 45 秒、Bob 90 秒、Carol 60 秒。服务端不代 Agent 选择任务或填写答案。

## 证据

### 验收同时关联原始票据、进程身份、页面回读和站点事件

创建后从实际结果写入 `profiles.json`、`assignments.json`。分工字段为 role、profile_ref、endpoint_nickname、workspace_ref、tab_ref、owner_session_ref。Bob 重开后新增 `assignments-after-reopen.json`，保留旧引用。

```powershell
pnpm exec tsx tools/snapshot-demo-runtime.ts demo-new-run before
# Bob 重开并完成回读后
pnpm exec tsx tools/snapshot-demo-runtime.ts demo-new-run after
pnpm exec tsx tools/verify-single-agent-demo.ts --run-id=demo-new-run
```

`agent-run.json` 如实记录 actor、delegatedAgents、taskDecisionsFromAgent。本轮使用当前会话时 actor 为 `current-codex-conversation`。MCP trace 仅证明所记录调用使用一个会话，不能单独证明没有其他未记录操作者。

`verification.json` 包含 25 项检查及源文件摘要。缺证、失败或未验证时退出非零。检查三个真实创建结果、独立进程与身份、真实 workspace/tab 映射、仅修改最早任务、正确备注、页面回读、摘要重叠、Bob 同身份重开、重复 open 复用、最终全部停止后可发现、所有已接受请求的成功终态。

## 收尾

### 先终止工作区再停止 Profile 可以保留可复用数据

经 MCP `terminate_workspace` 后逐个 `stop_browser_profile`；活跃工作区会阻止停止。保存最终 list 后停止本轮演示站；准备器的退出仅关闭 fixture，不关闭共享 Broker。Broker 退出也不会隐式杀死 Chrome。异常退出先核对本轮 manifest、Profile 引用和完整进程身份，禁止按进程名批量结束浏览器。

无法验证归属时返回 uncertain，不盲目重启。运行中扩展未就绪且无活跃工作区时，open 最多重新加载一次；有活跃工作区时等待恢复或返回超时。身份损坏不会自动清空 Profile。

## 已验证结果

### 两轮真实演示和独立的 Broker 重启探针均已通过

2026-09-27：`single-agent-demo-002`、`single-agent-demo-003` 各通过 25 项验收，六个 Profile 正常停止并保留数据。`single-agent-demo-001` 失败记录保留，不计成功轮次。

`managed-probe-007/managed-chrome-probe/report.json` 验证原生 Tab Group、管理连接断开/重连、Cookie/localStorage 和启动器退出行为。`profile-manager-004/profile-manager/report.json` 验证正式管理器认证、停止、身份复用和 Broker 重启复用实例。路径均相对于 `artifacts/real-world/`。

确定性检查为 `pnpm test` 与 `pnpm test:e2e`，不会启动物理 Chrome。安装/回退日志位于 `artifacts/real-world/managed-profile-execution/`；打包版真实 MCP trace 位于 `artifacts/real-world/release-mcp-smoke/single-agent-demo/trace/`。
