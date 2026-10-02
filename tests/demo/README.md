# 受管 Chrome Profile 实验与演示

## 环境

### 单 Profile 实验使用独立数据库和随机本地端口

从仓库根目录运行。Windows 上先运行 `pnpm verify`，确认 Chrome 和 Native Messaging 已安装。默认 Chrome 路径为 `C:\Program Files\Google\Chrome\Application\chrome.exe`，可通过 `--chrome=<absolute-path>` 指定。Native host 的注册扩展 ID 必须为 `caekiojlchhifdomfghejkbfpmaklafe`。

`pnpm exec tsx tools/probe-managed-chrome.ts --run-id=managed-probe-005`

每次使用新的 run ID；已有目录会被拒绝。实验在 `artifacts/real-world/<run-id>/managed-chrome-probe/` 内创建数据库、扩展构建和持久 Chrome 数据目录，自动分配 MCP、relay 和测试页端口。只在实验扩展构建中覆写首次连接 URL，保留固定 manifest key。不会重新注册 Native host 或修改其他浏览器 Profile。

## 验证

### 独立探针必须先核对 Native Host 的发现目标

当前 Native Host 优先读取其可执行文件旁的 `relay-runtime.json`。上述旧探针自行启动隔离 Broker 并设置扩展 relay URL，尚未为该隔离实例发布独立的 native 发现记录。若已注册的 Host 指向共享 Broker，探针可能连接错误的实例；仅覆写扩展 URL 不能隔离它。该路径需独立 Native Host 路由准备与重新资格验证，不能在共享实例使用中覆盖其运行记录。下面的历史通过记录不构成当前发现机制下的新一次通过。

### 真实实验覆盖自动加载扩展与关闭重开后的状态保持

实验通过 browser-level CDP 安装扩展、读取扩展公钥和关闭自己的浏览器；业务页面经真实 HTTP MCP、Native Messaging、扩展 debugger 执行。检查原生 Tab Group、安装连接断开/重连、Broker 重启、Profile 重开后的公钥与持久 Cookie/localStorage，并检查独立启动进程退出后浏览器仍可被管理。

报告为该目录的 `report.json`。失败保留资源和阶段事实；不自动复用旧实验目录，不把失败报告改成通过。退出时正常关闭本轮浏览器；仅无法正常关闭自己直接创建的进程时报告强制清理。

`pnpm exec vitest run tests/real-world/managed-chrome-probe.test.ts tests/integration/broker-shutdown.test.ts tests/integration/websocket-gateway.test.ts`

这些测试不会启动物理 Chrome。真实浏览器必须单独运行 probe CLI，不能用单元测试通过代替实测结果。

## 状态

### 四个公开生命周期工具和两轮真实三 Profile 演示已经通过

公开 MCP v2 已提供 list/create/open/stop 四个 Profile 工具。`single-agent-demo-002`、`single-agent-demo-003` 分别通过 25 项验收；工作区和浏览器已正常收尾，Profile 目录及原始证据保留。启动与执行步骤见 [演示运行手册](./RUNBOOK.md)。模拟测试不能替代真实证据，失败的 `single-agent-demo-001` 保留且不计成功轮次。
