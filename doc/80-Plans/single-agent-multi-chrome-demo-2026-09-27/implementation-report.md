# 受管 Profile 实施结果

日期：2026-09-27。用户授权执行后完成。本报告区分运行时代码、确定性测试和物理浏览器证据。

## 交付

### MCP 已支持持久 Profile 的发现、创建、打开和正常停止

MCP contract v2 提供 18 个工具，新增 list_browser_profiles、create_browser_profile、open_browser_profile、stop_browser_profile。Profile 属于认证主体，列表包含关闭记录；workspace 继续属于 Agent 会话。create 使用持久幂等键，生命周期进入既有 accepted/轮询/终态协议，回复交付前不启动 Chrome。

SQLite migration 006 保存 Profile、实例代次、Profile 请求关联、幂等记录、短期 grant 哈希和带续租的操作锁。每 Profile 串行，全局最多三路生命周期操作。停止有工作区准入屏障，拒绝活跃工作，不删除 Cookie、存储、扩展密钥或目录。

### 受管启动自动加载扩展并通过签名绑定正确实例

首版锁定 Windows / Chrome 153.0.8010.53。使用独立 user-data-dir、固定扩展 ID、稳定扩展目录和私有 loopback 管理连接。进程归属核对 PID、创建时间、可执行文件和数据目录；无法确认时保留 unknown/uncertain，禁止盲目重启或按进程名结束 Chrome。

扩展首先加载私有 bootstrap，再通过 Native Messaging 连接指定 Broker。grant 只有在公钥签名认证通过后消费；READY 后清除持久明文秘密。已认证实例重连不重复消费 grant。普通外部扩展沿用已有接入方式。已连接且完成库存核对才 ready；automation_paused 独立报告，打开不会解除暂停。

## 验证

### 两轮真实单 Agent 演示分别通过 25 项证据检查

| 运行 | 结果 | 证据目录（相对仓库根） |
| --- | --- | --- |
| 第一轮成功 Demo | 25 项 passed | `artifacts/real-world/single-agent-demo-002/single-agent-demo/verification.json` |
| 第二轮成功 Demo | 25 项 passed | `artifacts/real-world/single-agent-demo-003/single-agent-demo/verification.json` |
| 自动引导探针 | 原生 Tab Group、页面操作、管理连接重连、持久状态、启动器退出通过 | `artifacts/real-world/managed-probe-007/managed-chrome-probe/report.json` |
| 正式管理器复验 | 自动认证、stop/open、身份保持、Broker 重启复用实例通过 | `artifacts/real-world/profile-manager-005/profile-manager/report.json` |

两轮均由当前 Agent 读取页面后决定最早事项并填写备注，未使用子 Agent。Alice、Bob、Carol 使用同源 URL 和三个独立 Profile；摘要执行区间重叠，Alice/Carol 先于 Bob 完成。Bob 停止期间列表仍保留，重开后公钥、登录、localStorage 和业务结果保持；再次 open 复用实例。全部工作区已终止，六个 Demo Profile 已正常停止。

trace 保存原始 MCP 调用和返回，验收独立计算最早事项并关联进程快照、实际工作区分配、页面回读和业务事件。验收报告包含源文件摘要。一次会话的 trace 不能独自证明不存在未记录操作者，因此 Agent 执行记录另外声明来源，不把局部日志当作全局证明。

### 发布包安装和旧版回退都在隔离目录完成

独立开发安装和打包版安装均成功，未覆盖现有 Native host 注册。打包版 adapter → Broker → 实际 Chrome 完成 create、stop、open、工作区/CDP、终止和停止。升级在运行实例存在时拒绝；注入安装失败后恢复原运行时、配置和数据库，同一 Profile 仍可打开。

基线提交 `468209d` 的 v0.3.0 被单独构建：先确认旧版 14 个工具，再迁移到 v2 的 18 个工具并创建认证 Profile，保存升级后数据库和 Profile 元数据，恢复迁移前快照后再次启动旧版；新增 Profile 数据目录保留。旧版不显示新元数据，不能把直接运行旧二进制等同于安全降级。

证据：`artifacts/real-world/managed-profile-execution/install-smoke.log`、`release-install.log`、`upgrade-busy.log`、`upgrade-rollback.log`；打包 MCP trace 位于 `artifacts/real-world/release-mcp-smoke/single-agent-demo/trace/`；真正旧版往返报告为 `artifacts/real-world/profile-upgrade-probe-001/report.json`。

### 自动化回归覆盖持久权限、失败恢复和多浏览器路由

`pnpm verify` 通过 lint、typecheck、39 个测试文件的 178 项检查、2 项 E2E 和 build；记录在 `artifacts/real-world/managed-profile-execution/final-verify.log`。随后新增的 smoke 入口检查已确认实际工具目录为 18 项，记录在同目录 `smoke.log`。

回归包括迁移失败原子回滚、旧工作区/票据保留、主体 token 轮换、同键重试、分页隔离、唯一实例、PID 重用、junction 拒绝、grant 重放/过期/旧代次、丢失 READY、扩展 service worker 重启、失租无副作用、并发上限、stop 活跃工作阻塞、trace 脱敏及缺证拒绝。单 Agent 模拟 E2E 额外让第三路在创建前断开，重连后保留前两路工作区，并证明慢 B 不阻塞 A/C、同 tab 顺序不变。

## 实现差异

### 实现保留用户旅程并按实测调整内部组织和传输入口

1. 使用已安装的普通 Chrome 153.0.8010.53 和 Extensions.loadUnpacked，而不是下载 Chrome for Testing。该组合经真实实验验证。
2. 周期核对集成在 ProfileManager 内，没有单独 profile-reconciler 文件；请求续租 SQL 在 Profile repository，共用同一个 SQLite 数据库。
3. Demo 调用器每批启动一个 stdio adapter 进程，但所有批次使用同一个稳定 runtime session，Broker 实际 caller 也始终一致。验收的是一个 Agent 会话，不宣称始终只有一个 adapter OS 进程。未暴露宿主会话 ID 的普通使用仍应每会话单独启动 adapter。
4. Broker 重启由独立正式管理器探针验证，不伪装为三账户站点自身重启。站点内存数据只要求在本轮运行及浏览器重启期间保留。
5. 失败运行保留：`single-agent-demo-001` 暴露了瞬时 Chrome 子进程元数据缺失和 terminal uncertain 重调度导致的事件循环饥饿。已修复并增加回归，不将失败报告改写为通过。

## 使用边界

### 当前交付是已验证的本地 Demo 和开发版本

本次不发布远程 Release，不提交或推送 Git。Windows 与固定 Chrome 版本之外未验证；本机其他 Chrome/AdsPower 端点不会自动成为可停止的受管 Profile。Profile 不是 Google 账户，创建不等于登录网站。

停止前必须结束活跃工作区。未知进程归属需要人工检查；不自动清空损坏身份。连接修复每次 open 最多一次，且不得跨越活跃工作区或解除暂停。演示过程中穿插了编码和验证，因此运行时长不作为“三至五分钟”的性能承诺。

复现入口：[Demo 运行手册](../../../tests/demo/RUNBOOK.md)。执行清单：[123 条 TODO](./implementation-tasks.md)。
