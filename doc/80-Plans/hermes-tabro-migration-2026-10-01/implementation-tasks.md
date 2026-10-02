# Hermes Tabro 迁移执行 TODO

执行日期：2026-10-01。活动迁移完成。六组十八项记录如下；旧聊天逐轮验证独立列为未执行项。

## 清单与边界

### T1.1 最新扫描覆盖十四个 Profile 并列出限制

- [x] 全目录快照与 49 个当前 SQLite 只读检查完成；IPC、锁定 lease、权限错误、Git 和二进制扫描边界单列。证据：final-audit、sqlite-inventory.json、sqlite-events.json。

### T1.2 每项改动与残留均有处置依据

- [x] 两批 manifest、路径预览、分类 residuals.json 已生成；路径、身份、第三方与历史各自保留。

### T1.3 外部备份已校验且执行历史保真分支

- [x] 使用执行前已说明的 preserve 策略。两套备份 verify-backup 通过；不是全机 ACL 或未改写数据库的快照。

## 迁移工具

### T2.1 CLI 提供只读计划和范围受限写入

- [x] 脚本与规则已实现。plan/scan 只读；apply 使用路径、摘要与冲突门禁。没有 --section 参数。

### T2.2 结构化改名保护非目标内容并同步引用

- [x] YAML/JSON/JSONL、frontmatter、中文边界、标识符与文件映射已验证；改动链接另查 link-checks.json。

### T2.3 十三项隔离测试验证提交与失败恢复

- [x] python -m unittest discover -s tests/migrations -p test_*.py：13 项通过。fixture 临时合成，无私人数据。

## 活动内容

### T3.1 十四个配置统一名称并保留连接目标

- [x] 默认及 tabro-1/2 连接 Demo 13618；其他具名 Profile 连接原普通 Broker 7331。新 Profile 缺少的入口从默认补充。

### T3.2 四十二份 Skill 安装同步正文与路径

- [x] 127 个资源文件、23 处文件或目录改名完成；hermes -p asc-lp-dev skills list 发现 tabro-site-screenshots。

### T3.3 七份记忆与活动定义使用新名

- [x] 七个 USER.md 已更新；活动 cron 定义无待改命中。spawn ledger 保存真实 argv；SQLite 相关 delivery 已 delivered、异步委派已 completed。

## 历史与运行时

### T4.1 保真历史与活动报告分别保留可追溯原文

- [x] 原日志、会话、系统提示、备份、curator 流水与数据库历史未写；活动报告新版本的原文在外部备份。rewrite 未实现、未执行。

### T4.2 活动索引及新 Skill 路径可发现

- [x] 相关 .usage.json 和 .hub 产品引用已更新；保留第三方索引及历史流水，没有删除整个 cache。

### T4.3 十二个常驻网关通过 Profile 级命令重载

- [x] 空闲检查后逐个 gateway restart，最终新 PID 均 running。原生停止流程有一次 drain 超时后结束目标进程，恢复状态已确认。未用 --all。

## 连通与数据

### T5.1 全部 Profile 发现正确十八工具集合

- [x] 十四个 hermes [-p profile] mcp test tabro 均通过；mcp-profile-checks.json 比较具体名称，不只看数量。

### T5.2 两个真实 Hermes Agent 只读调用成功

- [x] 默认与 asc-lp-dev 实例经 tool_search、tool_describe、tool_call 获得两套 Broker 的 complete/ready。没有模型请求，独立实例不是旧聊天 turn。

### T5.3 认证文件和浏览器身份保持原位置

- [x] 两个 token 文件摘要不变；既有 MCP 目标不变；没有 Chrome 数据、Cookie 或扩展身份迁移，没有浏览器控制调用。Demo Relay 恢复到 13620，MCP 仍13618。

## 验收与恢复

### T6.1 最后活动计划零改动并解释可读取残留

- [x] final-plan 为零写入、零改名，47 处路径或第三方例外；全目录快照补漏后重查 782 个保留文件。扫描错误不算零命中。

### T6.2 两批真实快照逆向恢复原文摘要

- [x] rollback-check.json：隔离快照恢复全部148个文件。真实根没有回滚；后续配置变更保留，整文件回滚会拒绝覆盖。

### T6.3 最终报告和应用记录如实记录限制

- [x] final-report.json 经 verify-report 验证；计划、Changelog 和同一交互页同步。私人配置、备份及历史不提交 Git。

## 验证边界

### 旧聊天没有逐一发送验证消息或观察下一轮行为

- [ ] 不冒充已验证旧聊天的每一轮行为；本次没有向已有 Agent 发送 /reload-mcp、/reload-skills 或测试消息。
- [ ] 没有重新打开网站登录页面；认证文件与数据目录未动不等同于页面 auth 实测。

当前实例通过原生工具发现使用 Tabro。旧聊天原文可能继续出现 Octopus，属于已选择保留的历史。

## 恢复

### 恢复按批次逆序并拒绝覆盖后续变化

工作目录为仓库根，<R> 是本次运行目录；先审查当前变化，再执行：

```powershell
python tools/migrate-hermes-tabro.py rollback --manifest <R>/follow-up-plan/manifest.json --backup <R>/follow-up-backup
python tools/migrate-hermes-tabro.py rollback --manifest <R>/plan-v3/manifest.json --backup <R>/backup
```

Hermes 后续更新了默认插件配置与 tabro-1 版本戳，MCP 语义不变。真实回滚因此可能拒绝，不得修改摘要或强制覆盖；恢复磁盘后按 Profile 重载运行时。
