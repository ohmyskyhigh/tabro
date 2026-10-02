# Hermes 中的 Tabro 品牌迁移

执行日期：2026-10-01。状态：活动迁移完成；旧聊天未逐一发送验证消息。

## 结果

### 当前配置、四十二份 Skill 安装和记忆已统一为 Tabro

两个批次修改 148 个不同文件（149 次写入），完成 23 处文件或目录改名：14 个配置、127 个 Skill/资源文件、7 个记忆文件。截图 Skill 已改为 `tabro-site-screenshots`；MCP 工具引用、collector、模板、frontmatter、文件路径和链接同步改名。

全部十四个 Profile 使用 `tabro` 注册及 `TABRO_*` 环境键。新增的 `tabro-1/2` 原本没有 MCP 入口，已继承默认 Demo 连接；其他 Profile 的既有目标保留。

### 十四个 Profile 与两套 Broker 的工具检查均已通过

全部 Profile 发现完全一致的十八个预期工具。十二个此前运行的网关通过 Profile 级命令重启，新 PID 和 running 状态均已确认；原本停止的两个网关未启动。

两个真实 Hermes `AIAgent` 验证实例经当前 `tool_search → tool_describe → tool_call` 机制执行只读 Broker 查询，分别访问普通 Broker 和 Demo Broker，返回 complete、无 problem、Broker ready。没有语言模型请求，没有给旧聊天发消息；独立实例不冒充每个历史聊天下一轮的行为证据。

十三项测试通过；两批真实暂存快照在隔离副本逆序恢复全部 148 个原文件摘要；最后活动范围计划为零写入、零改名。

## 边界

### 历史保真分支保留原始记录与兼容身份

历史改写范围未收到选择，执行前已向用户说明采用建议的 `preserve` 分支。日志、聊天、保存的系统提示、备份、curator 流水和 SQLite 历史保留原文；活动 Skill 报告提供 Tabro 版本，原文保存在 Hermes 根外备份。

真实仓库路径、令牌文件路径、Native Host 名称和扩展能力标识保留。EmailOctopus、AgentOctopus、Octopus Deploy、上游作者和 emoji 属于无关命中。活动范围剩余 47 处路径或第三方例外；补漏后重查全目录快照仍有 782 个保留关键词文件，不代表仍注册旧工具。

四十九个当前 SQLite 文件已只读检查，相关 delivery 均为 delivered、异步委派均为 completed。锁定 lease、IPC 和权限拒绝路径单列；Git 内部历史和其他二进制未全文扫描。服务继续生成记录，因此全目录计数不是原子快照。

### Demo 恢复保留 MCP 地址和浏览器数据

停止的 Demo Broker 已使用原数据库、令牌恢复。MCP 仍为 13618；旧 Relay 13619 被 Verge 出站连接占用，恢复脚本增加环境变量覆盖，当前使用 13620，下次受管启动会写入新 Relay 地址。没有重开 Chrome 或验证网站登录页，没有迁移 Cookie、Profile 或扩展身份。

Hermes 后续更新了默认配置的插件字段及 `tabro-1` 版本戳；MCP 语义未变，这些变化被保留。整文件回滚会拒绝覆盖后续编辑。

## 文档

### 执行记录区分已交付功能和验证限制

- [技术设计](./technical-architecture.md)
- [执行 TODO](./implementation-tasks.md)
- [应用记录](../../99-Changelog/2026-10-01-hermes-tabro-migration.md)

私人清单、配置暂存、备份和报告保存在未提交的 `artifacts/hermes-tabro-migration/20261001-001/`。此计划记录本地实施，不修改 canonical MCP 契约，不发布私人配置。
