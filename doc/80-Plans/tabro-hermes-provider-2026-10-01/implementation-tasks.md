# Tabro 的 Hermes Provider 执行 TODO

日期：2026-10-01。状态：共享动态 Broker 已先行实现；Plugin 和跨平台步骤仍待执行。下列未勾选的新增命令和测试不能当作现成能力运行。功能与故障测试使用隔离目录、测试注册表和本地页面；M 阶段应用后在目标 Hermes Profile 执行真实只读验证，必要时在安全空闲点重新加载该 Gateway，不向真实社交账号或聊天发布内容。

## 运行统一

### U0 本机 Demo 与普通 MCP 已共用一个动态端口 Broker

- [x] Broker 两端默认端口 0，发布带实例和进程身份的运行记录；适配器与 Native Host 动态发现。
- [x] 备份合并两份 SQLite，保留十四个端点、三个受管 Profile 和原 Chrome 数据目录。
- [x] 十四份 Hermes 配置与 Codex 改用同一运行记录；在空闲点恢复十二个原常驻 Gateway。
- [x] Demo 准备与恢复入口复用共享 Broker；十八工具发现、登录文件保留和重复启动检查通过。

Plugin 接管从这一共享状态继续。原两套固定端口仅保留在历史快照与回退备份，不作为后续迁移分组。

## 本机迁移

### M1 复用现有运行环境的 Plugin 必须先通过真实 Hermes 契约校验

- [ ] 制作 `integrations/hermes/portable/plugin.json`、`mcp.json`、`launch.mjs`、平台启动包装器和 `skills/tabro-browser/SKILL.md`；新增 `tests/real-world/hermes-plugin-package.test.ts`。

技术：复用现有 Node、适配器、Broker、Native Host 和 Chrome 扩展，保持 server key `tabro` 与十八工具名称；公共包不携带机器硬编码路径、令牌或用户数据。Windows 启动包装器从安装记录读取绝对 Node 路径，满足 Portable 命令校验，日志写 stderr。依赖：现有 v2 接入已可用，不依赖完整 A0–A5。交付：可供本机安装的独立插件目录及本地 Git 安装源、固定提交摘要；不推送外部仓库。

验证：`hermes plugins doctor <构建后插件目录> --ci`、`pnpm exec vitest run tests/real-world/hermes-plugin-package.test.ts`。隔离环境覆盖路径空格、Node 不在 PATH、缺定位记录、旧适配器协议不匹配、错误认证、stderr/stdio 透传和进程退出；发现工具集合必须精确相同。命令中的目录在 M1 实现后才能替换为实际路径。

### M2 迁移助手必须保留十四个 Profile 的不同连接语义并提供回退

- [ ] 新增 `tools/migrate-hermes-plugin.py` 与 `tests/migrations/test_hermes_plugin.py`，实现 plan、apply、verify、rollback 和每 Profile 的事务日志。

技术：逐份解析目标配置，定位 Hermes 实际插件 ID 与 `${PLUGIN_DATA}`，保存原 `command/args/env` 的有效语义、Demo trace 设置及安装定位，备份旧 MCP 项与插件状态；私有记录只引用令牌文件。预检插件启用不会覆盖内置工具，不扩大能力授权。写前核对摘要/配置语义，回退只恢复本次项，不覆盖其他插件更新。依赖：M1。交付：只读十四 Profile 计划和隔离副本的应用/逆向恢复证据。

验证：`python -m unittest discover -s tests/migrations -p test_hermes_plugin.py`；覆盖共享运行记录和旧固定 URL 导入、源码与编译适配器差异、损坏 YAML、重复键、令牌值禁止公开、并发修改、安装中断、启用失败、重复运行和回退后文件语义一致。运行现有迁移测试回归，确认 Octopus→Tabro 改名不受影响。

### M3 tabro-1 必须证明工具实际来自插件而不是被旧配置遮蔽

- [ ] 为 `tabro-1` 安装固定本地 Git 包但暂不启用，准备 Demo 接入记录；预检通过后仅迁移其旧 `mcp_servers.tabro`，启用实际插件 ID。

技术：复用共享动态 Broker、统一令牌文件、可选 Demo trace 和独立运行身份，记录原启用状态；在新 Hermes 进程验证来源。依赖：M2。交付：一个试点 Profile 的真实接管或可验证回退。无需创建新 Chrome 身份、删除 Cookie 或重装扩展。

验证：`hermes -p tabro-1 plugins install <本地Git来源> --ref <固定40位提交> --no-enable`；`hermes -p tabro-1 plugins enable <实际插件ID>`；`hermes -p tabro-1 plugins doctor <实际插件ID> --ci`；`hermes -p tabro-1 mcp test tabro`。再在真实新 Agent 中发现精确十八工具并执行只读 `get_browser_context`，确认旧 MCP 项不在、插件声明为生效来源。检查 Broker PID/数据根与其他十三 Profile 的接入未改变。失败恢复试点并停止扩展。

### M4 试点通过后其他 Profile 必须逐个切换并验证运行身份

- [ ] 先迁移 default、tabro-2，再迁移其他十一个 Profile；每个保存旧接入、安装来源、插件状态、校验结果与回退记录。

技术：逐目标接管同一 `TABRO_RUNTIME_FILE`，保留启动入口和会话身份语义，不重复创建 Broker。运行中的 Gateway 在安全空闲点逐个 reload 或重启，不启动原本停止的 Gateway，不向聊天发送测试消息。依赖：M3。交付：十四 Profile 由 Plugin 接管的状态清单，失败目标可独立恢复。

验证：每目标运行 `hermes -p <profile> plugins list --plain`、`hermes -p <profile> mcp test tabro`，新进程核对实际插件来源与十八工具；两名独立 Agent 对同一共享 Broker 的只读查询证明会话区分。其他模型、消息渠道、插件、定时任务配置的语义必须保持，Chrome 数据不写入插件树。任一目标失败即暂停批量迁移，不用强制配置覆盖继续。

### M5 公共 Skill 必须可被业务流程发现且卸载能够恢复旧接入

- [ ] 更新 `integrations/hermes/README.md` 和本机迁移记录；验证命名空间下的 `tabro-browser` 可发现，在试点验证依赖它的业务 Skill 查找方式。

技术：保留现有业务 Skill；本轮不批量重写四十二份安装。公共 Skill 集中工具使用和状态处理，后续按业务逐项收敛重复说明。插件停用/卸载时可恢复旧 MCP 配置，Broker、Chrome 登录数据和 Native Host 保留。依赖：M4。交付：迁移报告、正确的 Skill 引用方式和回退命令。

验证：在隔离副本验证停用/卸载/恢复旧 MCP 项后仍发现十八工具，Profile 引用和身份不变；公共 Skill 查找失败需修复后才报告完成。Windows 本机证据单列，Linux/macOS 和全新机器安装继续按 A/B 阶段完成，不能据此标记三平台已支持。

### 本机迁移通过后才能报告已经安装并切换为 Plugin

- [ ] M 阶段：包与迁移测试通过；十四份目标配置不再含旧同名 MCP 项；实际插件启用并提供十八工具；共享动态发现与独立会话身份保留；回退演练通过。未通过的目标明确列出，不以已安装包替代实际接管结果。

## 安装

### A0 跨平台运行层必须消除 Native Host 与 Profile 管理的 Windows 依赖

- [ ] 平台化 `apps/native-host/`、`apps/broker/src/profiles/chrome-launcher.ts` 和 `runtime-config.ts`；补 Unix Native Host 构建或可执行包装器、权限与进程控制。

技术：先决定 Unix Host 实现路线；保留 Native Messaging 和 Broker 协议，独立处理 Chrome 路径、启动参数、进程出生时间与身份、目录权限和退出。依赖：现有运行合同。交付：Windows x64、Linux x64、macOS arm64/x64 的实际运行产物；支持矩阵按实测填写。

验证：目标原生系统验证消息分片、长度边界、断线重连和 stdout 纯协议；Chrome 的真实 Host 查找目录、扩展自动加载、两个独立身份的启动/关闭/重开与 PID 复用不误杀。Linux 无图形会话、错误架构、macOS 系统阻止执行和不合格 Chrome 必须给出准确失败/等待状态。

### A1 固定发行产物必须先覆盖当前十八工具契约

- [ ] 修改 `tools/stage-release.ts`、`tools/package-release.ps1`、`tools/update-local.ps1`，新增 Unix 打包入口和平台产物清单，发布 Windows、Linux、macOS 的合格包；复用哈希校验和回退，不依赖用户从源码构建。

技术：固定版本、产物清单和平台架构；补 Node 缺失时的官方运行环境准备及不同平台原生依赖。依赖：A0 和既有构建与更新流程。交付：各平台完整离线包、macOS 分发与签名方案，以及首次安装前置检测。

验证：`pnpm build`、`pnpm package:release`；在新测试中运行 `pnpm exec vitest run tests/real-world/hermes-one-click.test.ts -t release`。篡改包、版本不匹配、缺 Node 和不支持平台必须可解释地失败。

### A2 一个安装入口必须组合既有安装与注册流程

- [ ] 新增 `tools/setup-hermes.ps1`、`tools/setup-hermes-linux.sh`、`tools/setup-hermes-macos.sh`、`tools/setup-hermes.mjs` 和 `tools/tabro-install-state.ts`；修改既有 Windows 脚本的可复用入口，补 Unix 系统适配。

技术：三个薄入口准备 Node 后调用同一核心；安装级锁、步骤记录、结构化结果、保留旧安装；支持受管与手动扩展路径；显示 Hermes 配置范围并处理不同 Broker 的既有项。Unix 注册用户级 manifest，不要求 PowerShell 或全局 sudo；尊重 XDG 与 macOS 目录约定，隔离 Broker 后台日志和 MCP stdio。依赖：A1。交付：每个系统一次运行完成准备、启动、注册和探测，失败回退本次修改。

验证：`pnpm exec vitest run tests/real-world/hermes-one-click.test.ts -t install`；在三个系统覆盖路径空格、非 ASCII、只读目录、中断、重复运行、并发、现有 7331/13618 配置混用，确认不改现有 Chrome 数据；Linux 的非默认 XDG 路径、无 systemd、macOS 从 Hermes 启动时的 PATH 缺失均需验证。

### A3 多个适配器同时启动必须复用同一个健康 Broker

- [ ] 在 `integrations/hermes/portable/launch.mjs` 与稳定安装启动器中新增有界启动检查；补 `tests/real-world/hermes-one-click.test.ts`。

技术：复用安装记录，版本与协议核对，进程身份检查，启动互斥；不在 MCP 握手时下载依赖。依赖：A2。交付：两会话共享 Broker，但各有独立会话证据。

验证：`pnpm exec vitest run tests/real-world/hermes-one-click.test.ts -t broker`；同时启动六个入口、占用端口、杀死启动中的服务、旧版本响应、超时，stdout 必须没有诊断文本。

### A4 完整安装必须通过本地双 Profile 执行验收

- [ ] 新增 `tests/real-world/hermes-provider-qualification.test.ts`，复用受管 Profile 安装测试和现有本地 Demo。

技术：创建两个测试 Chrome 身份，自动连接扩展，发现工具，分配工作区，完成本地页面动作；手动路径验证等待与连接状态。依赖：A3。交付：可重复安装录屏和机器可读结果。

验证：`pnpm exec vitest run tests/real-world/hermes-provider-qualification.test.ts`；关闭重开保持身份；故意断开一个扩展应报告对应 Profile 状态，不操作另一个身份。不会向 X 发布内容。

### A5 三个平台必须在原生系统完成安装与升级资格验证

- [ ] 新增 `tests/real-world/hermes-platform-installation.test.ts`，配置各目标平台构建与实机/VM 验收，产出 OS、CPU、Chrome、Node 与 Hermes 版本矩阵。

技术：验证 Windows x64、Linux x64、macOS arm64/x64；Linux 使用真实图形会话，macOS 验证系统执行许可；从已验证旧安装升级，保留登录数据、扩展身份和回退。依赖：A4。交付：三套安装录屏、机器可读结果和准确支持列表。

验证：各平台运行 `pnpm exec vitest run tests/real-world/hermes-platform-installation.test.ts` 和 qualification 测试；Node 缺失、断网、包校验失败、取消、并发、重启后重新使用、六适配器复用同一 Broker、双 Agent 隔离与双 Profile 任务均通过。不能用 Windows 上的 shell 静态检查替代 Linux/macOS 实际执行。

## 插件

### B1 独立插件必须携带 MCP 声明和可发现的 Skill

- [ ] 新增 `integrations/hermes/portable/plugin.json`、`mcp.json`、`skills/tabro-browser/SKILL.md` 与 `tests/real-world/hermes-plugin-package.test.ts`；将三个系统的 setup 入口、共用核心和平台适配打入插件发布包。

技术：按 Hermes 支持的 Portable 契约生成包，公开配置只含文件定位信息；工具仍由规范适配器提供。依赖：A2。交付：独立插件安装包，不重复注册十八个 Python 工具。

验证：`pnpm exec vitest run tests/real-world/hermes-plugin-package.test.ts`；按目标 Hermes CLI 的验证命令加载隔离包，检查插件发现、Skill 名称、MCP schema、无明文凭据和无 shell 字符串命令。

### B2 插件入口与既有 MCP 配置必须明确选择一个有效来源

- [ ] 在 `tools/setup-hermes.ps1`、`integrations/hermes/portable/launch.mjs` 中实现已存在项检测和接管结果。

技术：识别 Hermes 的同名配置优先级；可用旧项保留，接管只修改授权目标，不无条件删除旧配置。依赖：B1。交付：重复安装不产生第二组 Tabro 工具，结果显示实际生效入口。

补充：先核验目标 Profile 的生效配置、认证、Broker/适配器版本、工具 schema 和本地组件，再选择复用、启动已有 Broker、局部修复或全新安装。健康旧项默认保留，Plugin 提供 Skill 与接入管理；仅在明确选择接管时迁移同名配置。输出实际复用来源和跳过步骤，不把被遮蔽的插件 MCP 当作生效。共享 Broker 升级前核对其他依赖它的 Hermes Profile；无浏览器连接返回等待，不能触发重装。

验证：`pnpm exec vitest run tests/real-world/hermes-plugin-package.test.ts -t conflict`；制造不一致 Broker、过时适配器、重复插件和损坏配置，验证失败与恢复路径。

新增验收：健康接入安装 Plugin 后运行包零下载、Native Host 零重复注册、原有效 MCP 不变；Broker 停止只启动旧实例；认证失败不误判为缺安装；Chrome 窗口关闭不重装；只有其他 MCP 则安装 Tabro；旧双 Broker 状态先独立备份合并，Plugin 接管共享记录；接管中断恢复旧配置且不丢身份数据。复用模式与迁移模式均只出现一组有效 Tabro 工具。

### B3 插件更新和卸载必须保留浏览器身份与持久数据

- [ ] 修改 `tools/update-local.ps1`；在 `integrations/hermes/README.md` 定义升级和卸载边界。

技术：稳定启动和扩展路径、版本记录、配置写入校验；插件树无运行数据库和 Chrome 数据。依赖：B2。交付：升级回退说明，卸载接入不等于删除登录数据。

验证：`pnpm exec vitest run tests/real-world/hermes-plugin-package.test.ts -t update`；模拟安装中断、回退、插件替换、配置被并发修改；对 Profile 配对身份和 Cookie 的持久性作真实 Chrome 验证。

### B4 插件发布必须给出准确的平台和 Hermes 兼容范围

- [ ] 新增 `integrations/hermes/README.md`；将合格包发布到独立插件仓库，准备分发命令。

技术：使用已验证的 Hermes 安装、启用与 MCP 刷新方式；未发布前不宣传虚构安装命令。依赖：B3、A5。交付：固定版本、Windows/Linux/macOS 安装步骤、矩阵和 Demo。

验证：在隔离环境运行 `hermes plugins install <已发布仓库> --no-enable`、`hermes plugins list`、`hermes plugins enable <实际插件名>`；重新开始会话后确认十八工具和独立 Agent 身份。

## 菜单

### C1 上游必须先确认 MCP 浏览器后端的通用扩展契约

- [ ] 在计划中维护通用接口提案；目标上游文件为 `agent/browser_provider.py`、`agent/provider_base.py`、`hermes_cli/tools_config_providers.py`、`hermes_cli/tools_config_post_setup.py` 与相关工具路由。

技术：区分 CDP Session Provider 与 MCP Tool Backend，协商选择、安装、readiness、工具集合和配置持久化；不默认新增抽象方法破坏已有插件。依赖：B4 和上游接口讨论。交付：范围清晰的通用提案与测试合同。

验证：在独立 Hermes checkout 搜索相关 Issue/PR；实现后通过 `bash scripts/run_tests.sh <新增接口测试文件>` 验证旧 Provider 插件无需修改仍能工作。

### C2 菜单选中 Tabro 必须真正启用 Tabro 的任务执行路径

- [ ] 在独立开发 checkout 实现上游确认接口、菜单状态和后端工具路由；补目标 Hermes setup 与 browser 路由测试。

技术：选择成功才显示 active；区分安装与浏览器 readiness；明确 Tabro MCP 与原有 browser 工具的关系，避免菜单选择后继续走旧后端。依赖：C1。交付：Tabro 一行和完整安装流程，非仅菜单装饰。

验证：`bash scripts/run_tests.sh <新增setup测试文件> <新增路由测试文件>`；安装失败、离线、等待手动扩展、取消、切换回原 Provider、异常退出、六适配器竞争均验证；真实双 Profile Demo 必须通过。

## 上游

### D1 沟通材料必须证明多身份与工作区是独立价值

- [ ] 准备安装录屏、单 Agent 双身份 Demo、双 Agent 隔离证明和维护责任表；使用技术架构中的英文草稿。

技术：先搜索再发送通用接口需求；独立插件由 Tabro 项目维护，Hermes 只维护通用插件接口。依赖：B4；C1可先沟通，不必先做完整核心实现。交付：待发送 Issue 或社区帖正文。

验证：`gh search issues --repo NousResearch/hermes-agent "MCP browser provider"`、`gh search prs --repo NousResearch/hermes-agent "browser provider plugin"`；检查正文只声称已通过的能力。发送须有用户明确指令。

### D2 默认发现入口必须单独取得上游准入结论

- [ ] 在通用接口和插件合格后申请推荐目录或预置发现选项；记录维护者答复。

技术：未安装也可发现属于目录能力；加入目录、安装后菜单可见、默认启用是三个不同政策。依赖：D1 和上游决策。交付：明确的接受范围，不承诺对方必然合并或默认启用。

验证：在空白 Hermes 配置中运行 setup 的自动化选择测试，确认能看到候选项；选择前不下载，选择后走唯一安装流程，未测试平台不标记可用。

## 验收

### 每个阶段通过其测试后才能进入下一阶段

- [ ] A 阶段：`pnpm typecheck` 与 one-click、qualification、platform-installation 测试在三个目标系统通过；新机器无需手动编辑 YAML。
- [ ] B 阶段：插件安装、启用、冲突、更新与身份保持通过；不存在注册失败缓存仍宣称 ready 的情况。
- [ ] C 阶段：Hermes 旧 Provider 回归与 Tabro 路由通过；菜单和实际执行使用相同后端选择。
- [ ] D 阶段：获得目录或默认发现的明确结论；空白安装验收与结论一致。

## 回退

### 回退接入方式必须保留 Broker 与 Chrome 数据

A 阶段可退回现有两步脚本；B 阶段可停用插件并恢复原 MCP 注册；C 阶段可撤回独立 checkout 的通用菜单改动，继续使用 MCP 插件；D 阶段未被接受时保留独立分发。任何回退均不删除 Chrome Profile、Cookie、配对密钥或 Broker 数据库。
