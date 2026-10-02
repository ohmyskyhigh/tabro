# Hermes Tabro 迁移技术设计

状态：已实现、已应用历史保真分支。历史改写、SQLite 写入和网关控制不属于迁移 CLI 功能。

## 组件

### CLI 只提交 manifest 明确列出的活动文件

交付 `tools/migrate-hermes-tabro.py`、`tools/hermes-tabro-rules.json` 和 `tests/migrations/test_hermes_tabro.py`。需要带 PyYAML 的 Python 与 rg；未替换 Hermes 运行时或安装依赖。测试临时生成合成 fixture，不将私人数据保存到仓库。

支持 scan、plan、apply、verify、rollback、verify-manifest、verify-backup、verify-report。scan 和 plan 都生成只读活动范围计划，不是全目录或 SQLite 内容扫描。没有 `--section` 参数。`--add-missing` 为缺少入口的 Profile 复制既有默认 Tabro 注册。

全目录审计、数据库只读计数、网关重载、CLI 和真实 Agent 检查是本次独立执行证据，保存在忽略目录中。

## 映射

### 结构化比较保护敏感值和非目标配置

YAML 配置仅变更已知 MCP 注册与环境键，完整比较预期语义树；重复键、值冲突及意外差异会阻断写入。保留注释、BOM、换行和连接值。

JSON/JSONL 递归更新名称，但 token、credential、password、ID、ref、hash 等字段不作正文替换。YAML 资源重新解析并比较，Markdown frontmatter 重新解析。中文紧接品牌及 `octopus_cdp_only` 可匹配；Latin 人名不作产品名替换。

真实 Windows 路径、Native Host 身份、扩展能力 ID 和第三方产品保留。子文件先改名，再改父目录，路径引用同步映射；本次独立链接检查验证改动闭包。

## 数据

### 两批 manifest 和外部备份形成恢复链

Manifest 保存 root、historyPolicy、entries、renames、tokens、exceptions、scan_scope、discovery_errors 和 add_missing。entry 包含 source、target、relative、before、after、stage、kind；摘要使用 SHA-256，预览仅打印路径。

备份位于 Hermes 根外，包含 original、hashes.json、manifest.json、journal.json，被改名目录另保存完整副本。保留普通文件元数据，不宣称完整 Windows ACL 或全系统快照；历史数据库未改写。

本次第一批 plan-v3/backup 更新 144 个文件；follow-up-plan/follow-up-backup 补齐五个文件，一条记忆属于重复写入，共 148 个不同文件。

## 提交

### 摘要和路径门禁阻止覆盖并发编辑

解析绝对目标并确认留在指定根内，拒绝 symlink/junction、重名目标、暂存或原文摘要冲突。同目录临时文件原子替换，逐步记录 journal；失败后逆向恢复已执行项。出现后续编辑时停止覆盖。

正常回滚要求当前内容仍等于该批 after 摘要。先回滚补漏批次，再回滚第一批。Hermes 后续的插件或版本戳变更需要审查合并，不能修改摘要或强制覆盖来绕过保护。

## 验证

### 真实执行器验证两套 Broker 但不冒充旧聊天证据

十四个 CLI 检查逐个比较十八个工具名。独立真实 Hermes Agent 经工具搜索、schema 描述和工具执行器调用 `mcp__tabro__get_browser_context`；解析结果包装后核对 complete、无 problem、Broker ready。没有请求模型、发布内容或接管工作区。

十二个网关在空闲检查后按 Profile 逐个重启，最终新 PID 均 running；未用 --all，也未给已有 Agent 发消息。旧聊天原文保留，不宣称每个旧聊天已经实测下一轮。

十三项隔离测试覆盖往返、故障注入、并发修改、后续编辑、冲突、路径、身份、历史、敏感字段、BOM/CRLF、中文及标识符。两批真实应用快照另在隔离副本恢复 148 个文件摘要；真实根未用于回滚演练。
