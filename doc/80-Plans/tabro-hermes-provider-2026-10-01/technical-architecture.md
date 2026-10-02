# Tabro 的 Hermes Provider 技术架构

日期：2026-10-01。状态：草案；新增路径与接口均为拟实现内容。

## 现状

### 当前安装器能准备运行环境，但 Hermes 注册仍是另一步

`tools/install-local.ps1` 构建产物、注册 Native Host、生成 Hermes 注册命令，可选择启动 Broker 并配置受管 Profile。`tools/register-hermes-profiles.ps1` 再写入各 Hermes Profile 的 MCP 配置。`tools/update-local.ps1` 已有校验、稳定路径和失败回退能力。这些步骤尚未合成完整的一键接入入口。

当前扩展具备启动连接与重连机制，受管 Profile 生命周期支持加载扩展。安装 Tabro 不等于立即修改用户所有 Chrome Profile：受管身份走自动引导，现有身份走手动加载后注册的路径。

### 现有 BrowserProvider 接口不能直接表达 Tabro 的 MCP 执行模型

本地 Hermes 接入点：

| 文件 | 已验证行为 | Tabro 所需补充 |
| --- | --- | --- |
| `agent/browser_provider.py` | 创建会话返回 `cdp_url` 等元数据 | MCP 工具后端不应伪造一个直接 CDP 地址 |
| `agent/provider_base.py` | 提供菜单名称、说明、环境变量元数据 | 安装与工具后端类型的公开声明 |
| `hermes_cli/tools_config_providers.py` | 从插件 Registry 收集菜单项并写选择配置 | MCP 后端选择、工具集合与状态集成 |
| `hermes_cli/tools_config_post_setup.py` | 安装回调使用固定键的内部映射 | 外部插件的通用安装与 readiness 扩展点 |
| `hermes_cli/agent_plugins.py` | Portable 插件可贡献 MCP 和 Skills | 不自动保证加入 Browser Automation 菜单 |

不能只加菜单字符串，也不能注册一个假的 CDP Provider 然后绕过 Broker。必须让菜单选择真正启用 Tabro 工具，并继续遵守 Profile、Workspace、票据和所有权语义。

## 组成

### 插件包负责接入，Broker 和 Chrome 扩展继续负责执行

建议先以独立 Portable 插件封装已有 MCP 路径，后续必要时增加原生 Python 集成层。Portable 与原生格式遵循各自的 Hermes 契约，不能自行假设两种格式可以混装并同时加载。

```text
Tabro 的拟新增文件
├─ integrations/hermes/portable/
│  ├─ plugin.json                  插件身份与说明
│  ├─ mcp.json                     声明 tabro stdio 服务
│  ├─ launch.mjs                   找到安装记录，检查 Broker，再启动适配器
│  └─ skills/tabro-browser/SKILL.md 使用十八工具与多 Profile 的说明
├─ tools/setup-hermes.ps1          Windows 安装入口
├─ tools/setup-hermes-linux.sh     Linux 安装入口
├─ tools/setup-hermes-macos.sh     macOS 安装入口
├─ tools/setup-hermes.mjs          三个平台共用的安装编排核心
├─ tools/tabro-install-state.ts    安装记录、锁、结果和回退边界
├─ tests/real-world/hermes-one-click.test.ts
├─ tests/real-world/hermes-plugin-package.test.ts
├─ tests/real-world/hermes-provider-qualification.test.ts
└─ integrations/hermes/README.md   发布与兼容性说明
```

上述文件本轮不创建实现。独立发布仓库可由这些源文件构建，不能将 Broker 数据或浏览器身份放进插件安装树。

插件包含元数据、MCP 声明、稳定启动入口和 Skill。发布包或安装器另行提供 Broker、适配器、Native Host、Chrome 扩展和所需 Node 运行环境。公开包仅引用令牌文件，不能嵌入令牌。

### Plugin 必须携带 Windows、Linux 和 macOS 的安装入口

独立发布包建议组成如下，所有新增文件仍为计划。三个系统入口只做平台探测、准备合格 Node 和调用共用核心，安装状态、Hermes 接入、版本检查与回退保持同一套语义：

```text
tabro-hermes-plugin/
├─ plugin.json
├─ mcp.json
├─ launch.mjs
├─ launch.ps1                     可选：从安装记录找到 Node 的绝对路径
├─ scripts/
│  ├─ setup-hermes.ps1             下载、安装、接入、验收的统一入口
│  ├─ setup-hermes-linux.sh        Linux 的 Bash 入口
│  ├─ setup-hermes-macos.sh        macOS 的 Bash 入口
│  ├─ setup-hermes.mjs             Node 就绪后执行共用安装编排
│  ├─ platform/                   Native Host 注册、权限与进程控制的系统适配
│  └─ update-local.ps1             复用 Windows 发行版安装与更新能力
├─ release-channel.json           固定合格版本与包校验信息
└─ skills/tabro-browser/SKILL.md
```

Plugin 中的脚本和元数据是可更新的程序文件。Broker 二进制/JavaScript、Native Host 和扩展可作为独立发行包下载到稳定安装目录；数据库、令牌、日志和 Chrome Profile 数据始终放在持久数据目录。Plugin 不携带用户登录数据、API 密钥或预生成令牌。

`launch.ps1` 若使用，只负责读取安装记录并调用绝对路径的 Node，不运行安装任务。`mcp.json` 引用插件内启动脚本或 `launch.mjs`；MCP 启动时不依赖用户的当前工作目录。

## 跨平台安装

### 三个系统入口必须调用同一安装核心并选择正确的平台产物

Windows 使用 PowerShell，Linux 和 macOS 使用 Bash；不要求 Linux/macOS 用户先安装 PowerShell。共用核心在 Node 准备后负责下载校验、安装记录、安装互斥、Hermes 接入、健康检查和回退，平台适配负责 Native Host 注册、目录权限、Chrome 发现与进程控制。Windows 可以继续复用 `update-local.ps1`，Unix 实现必须补齐相同的完整性校验与回退合同。

bootstrap 的内部调用示意如下，变量由入口解析；脚本尚未实现，不能当作现成安装命令。Hermes Plugin 安装仍需先执行 `plugins install ... --no-enable`，显式调用下面对应入口，成功后写接入记录、启用并验证。Hermes 不会自动执行这些 `.ps1` 或 `.sh` 文件。

```powershell
pwsh -NoProfile -File "$pluginRoot\scripts\setup-hermes.ps1"
```

```bash
# Linux
bash "$plugin_root/scripts/setup-hermes-linux.sh"
# macOS
bash "$plugin_root/scripts/setup-hermes-macos.sh"
```

每个入口按同一顺序执行：识别 OS/CPU 与目标 Hermes Profile → 检查或准备固定 Node 与已验证 Chrome → 下载对应平台包并校验 → 安装运行程序 → 注册 Native Host → 准备受管 Profile → 启动或复用 Broker → 保存接入记录并启用 Plugin → 新会话验证十八工具与浏览器连接。安装步骤不需要用户手动编辑 YAML，尚未连接浏览器时明确返回等待状态。

### 注册、权限和后台启动必须分别适配三种系统

下表为新安装的建议默认路径，不自动移动旧安装。Linux 尊重 XDG 目录变量；Hermes 插件目录和数据目录由实际 Hermes Profile 解析，不能硬编码为当前 Windows 路径。

| 系统 | 运行程序与数据位置 | 系统动作 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Tabro` 下分开保存程序与数据 | 当前用户 Native Messaging 注册表；ACL；隐藏启动 Broker；Windows Chrome 路径与进程身份检查 |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/tabro` 保存程序与身份；`${XDG_STATE_HOME:-$HOME/.local/state}/tabro` 保存日志等状态 | 写用户级 Native Messaging manifest，设置可执行权限和私有目录；探测图形桌面与 Chrome；按需后台启动 Broker |
| macOS | `~/Library/Application Support/Tabro` 保存程序与身份；`~/Library/Logs/Tabro` 保存日志 | 写用户级 Native Messaging manifest；使用合格的签名/分发方案并验证系统允许启动；定位应用包内 Chrome 可执行文件；按需后台启动 Broker |

Unix manifest 的 `path` 必须是可执行 Host 的绝对路径。Google Chrome 默认用户目录下，Linux 的注册位置为 `~/.config/google-chrome/NativeMessagingHosts/`，macOS 为 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。这些是标准默认位置，不能假设受管 `--user-data-dir` 自动查找同一目录；受管模式必须按浏览器实际查找目录配置并实测。Chrome for Testing、Chromium 和不同 Channel 的路径需要分别发现与验收。[Chrome 官方 Native Messaging 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。

第一版不强制安装系统服务：由安装入口和日常启动器按需复用或启动 Broker，重启后下一次使用恢复。若提供开机常驻，再单独适配用户级 systemd、launchd 和 Windows 启动方式，且不能假设所有 Linux 都有 systemd。Unix 日志和 stdin/stdout 必须与 Hermes MCP 管道隔离；不能用裸 PID 判断实例或误杀同名 Chrome。

### Native Host 与受管 Profile 的 Windows 依赖必须迁移后才能宣称跨平台可用

当前 `apps/native-host/src/relay-native-host.cpp` 依赖 `windows.h`、WinHTTP；`apps/broker/src/profiles/runtime-config.ts` 对非 win32 直接拒绝，`chrome-launcher.ts` 使用 CIM、`whoami.exe` 和 `icacls.exe`。必须提供 Unix 可运行的 Native Host，以及平台化的权限、Chrome 启停与进程身份核验，保留连接协议、扩展身份和十八工具合同。

Native Host 的 Unix 实现可采用已准备的固定 Node 配合可执行包装器，或可移植的预编译二进制；实现前确定路线并验证消息长度前缀、分片、断连、stdout 纯协议与 Chrome 自动启动。每个平台还必须验证 Chrome 的扩展加载能力，不能直接复制 Windows 的已验证精确版本或假设任意 Chrome 支持相同启动参数。

目标发行矩阵先覆盖 Windows x64、Linux x64、macOS arm64/x64；Linux arm64 待 Chrome 可用性和构建验证后再决定，WSL 不等同于原生 Linux 桌面支持。Linux 缺图形会话可完成基础安装并给出明确状态，不能通过受管浏览器全链路验收；无头模式属于独立后续能力。每个平台包必须包含其可运行的 Native Host、依赖和运行环境，并进行原生系统上的双 Profile、双 Agent、关闭重开、更新回退验证。

## PowerShell 安装

### 一键入口必须显式执行安装步骤，不能假设 Hermes 自动运行包内脚本

本地源码 `hermes_cli/plugins_cmd_install.py` 负责插件包安装、依赖声明处理和启用流程；Portable 包由 `agent_plugins.py` 发现 MCP 与 Skills。存在 `scripts/setup-hermes.ps1` 本身不会触发 Tabro 的系统安装。未来菜单必须接入明确的安装回调；上游接口完成前由 Tabro bootstrap 统一调用下列阶段。

以下命令是安装器内部调用形态，不是已经发布的一键命令。`$pluginRepository`、`$pluginRoot`、`$installRoot`、`$version` 等由统一入口解析和校验，不使用当前机器的硬编码仓库路径。

| 顺序 | 系统动作 | PowerShell 层面的实现 |
| --- | --- | --- |
| 1 | 安装但暂不启用 Plugin | `hermes -p $targetProfile plugins install $pluginRepository --no-enable`，校验实际安装目录与插件名；bootstrap 使用固定发行来源 |
| 2 | 检查执行环境 | `Get-Command pwsh, hermes`；定位合格 Node 与 Chrome，检测既有安装、端口和目标 Hermes Profile；缺 Node 时准备固定官方运行环境 |
| 3 | 下载并安装 Tabro 运行包 | 包内 setup 调用 `update-local.ps1`，传固定版本或本地包与校验文件、安装目录、Node 路径和端口；校验、展开、稳定启动路径与回退由 updater 负责 |
| 4 | 配置 Native Host 和受管 Profile | updater 写 Native Messaging manifest 和当前用户注册表，`-EnableManagedProfiles` 调用受管配置流程，记录 Chrome 路径、扩展路径、Profile 根目录与 relay 地址 |
| 5 | 启动或复用 Broker | 后台 `Start-Process -WindowStyle Hidden`；等待 HTTP health，并核对版本、协议、数据根目录；Broker 首次启动生成数据库和本地令牌文件 |
| 6 | 保存 Plugin 的接入记录并启用 | 写入目标 Profile 的插件数据定位记录，再执行 `hermes -p $targetProfile plugins enable $actualPluginName`；没有可用接入记录时不宣称 ready |
| 7 | 让新 MCP 入口生效并验证工具 | 新 Hermes 会话或受支持的 MCP reload；`hermes -p $targetProfile mcp test tabro` 验证工具发现和 schema，另核对插件提供的 Skill |
| 8 | 验证浏览器连接或明确等待 | 安装阶段只准备 Profile 能力；有授权测试身份时打开测试 Profile 验证扩展。正常使用时 Agent 调用创建/打开工具，Chrome 自动加载扩展连接；现有 Profile 由用户手动加载扩展 |

上表步骤 3 的调用示意（现有 updater 参数，但包与新目录必须事先准备）：

```powershell
& $updateScript -Version $version -PackagePath $packagePath `
  -ChecksumPath $checksumPath -InstallRoot $installRoot `
  -NodePath $nodeExecutable -McpPort $mcpPort -RelayPort $relayPort `
  -EnableManagedProfiles
```

当前 updater 已执行 manifest 注册、受管配置和 Broker 启动；统一入口不可重复执行这些副作用。未来补齐 Node 准备、安装互斥、接入记录、Plugin 启用和全链路验收。当前受管配置脚本检查精确的已验证 Chrome 版本，不能把它解释为已经支持任意 Chrome。

### Portable Plugin 已经提供 MCP 声明时不应再重复写同名 MCP 配置

新 Plugin 路径：启用 `mcp.json` 提供的 `tabro` 即可，安装器写的是接入定位记录。旧直接 MCP 路径：调用现有 `register-hermes-profiles.ps1` 写 `mcp_servers.tabro`。两条路径按迁移策略择一生效，不能无条件同时执行；现有同名配置会遮蔽插件提供的入口。

安装完成后的每次启动只走 `Hermes → Plugin 的 launch → stdio 适配器 → Broker`，不重复下载、安装和注册。关闭 Agent 会话不等于删除 Broker 数据或 Chrome 登录状态。

## 流程

### 一个安装入口完成下载、启动、接入与验收

```text
当前阶段：用户运行 Tabro 安装入口
未来阶段：用户在 Hermes setup 选择 Tabro
                    |
                    v
检查平台、Hermes、Node、Chrome 和现有安装
                    |
下载固定版本并校验 / 使用本地合格包
                    |
安装到稳定路径，注册 Native Host，准备受管 Profile
                    |
启动或复用健康 Broker，核对版本和协议
                    |
安装并启用插件 / 配置 MCP，处理既有 tabro 注册冲突
                    |
建立新会话或执行受支持的 MCP reload，发现十八工具
                    |
可控 Profile 建立连接，执行本地页面冒烟任务
```

无可用 Profile 时输出“工具接入完成，等待浏览器连接”，不能宣称完整可用。手动安装者选择扩展目录、保存对应 relay 配置，等待 Broker 自动登记。受管身份在 Agent 创建或打开时自动加载扩展。

### Broker 按需启动必须在多个 Agent 同时启动时只产生一个有效实例

安装器负责首次启动。新会话启动器只在本地运行产物已准备好时启动或复用 Broker，不在 stdio 握手中执行长期下载或构建。使用安装级锁、启动截止时间、版本和协议探测；端口被无关进程占用时失败并给出修复信息，不能误认成 Broker。

所有诊断写 stderr，stdout 留给 MCP。启动器沿用宿主会话证据；缺失时独立 Agent 必须各有适配器进程。共享 Broker 不能导致共享无区分的所有者身份。

### 动态端口分配必须同步实际地址而不能只将配置端口改为零

用户最新决定覆盖双 Broker 部署。Broker 和常驻入口默认两端为 0，由系统分配端口；Demo 入口复用同一 Broker，只启动演示站。Broker 原子发布实例 ID、PID、MCP/relay URL 和数据库路径；适配器读取共享记录并校验 health 实例，Native Host 从其可执行文件旁读取 relay 记录。Chrome 启动引导使用绑定后的真实 relay 地址。

Plugin 新安装可采用动态端口，但须在成功绑定后原子发布实际 MCP 与 relay URL、进程身份、版本和数据根的运行记录。各 Profile 的持久定位指向稳定安装/运行记录，不能长期缓存一次启动的随机端口；适配器启动前读取并验证当前记录，扩展引导配置也同步 relay URL。已运行扩展如何发现 Broker 重启后的新 relay 地址必须独立验证，不能假设改一份文件就自动重连。Chrome 私有管理 CDP 的 `--remote-debugging-port=0` 属于另一条已有动态端口机制。

本机插件迁移复用 `.relay-data/runtime.json`，不保留 7331/13618 的固定地址分组。已验证动态监听、运行记录校验、适配器重启重连与 Native Host 动态发现；更广泛的 PID 复用和三平台发行资格仍需后续验收。

### 安装记录与浏览器身份必须保存在可更新插件之外

稳定目录保存发行版、启动器、扩展和持久数据，Profile 保留独立 Chrome 数据目录。Hermes 每个 Profile 的可写插件数据仅保存该 Profile 的接入定位记录；全机 Broker 状态由稳定 Tabro 数据根目录拥有。

新安装可使用 Tabro 命名的目录；检测到旧安装时复用既有目录和配对身份，不自动移动旧浏览器数据。Node 已有时验证版本；没有时由安装器复用合格 Hermes 运行环境或安装官方固定版本，并验证下载。三平台均为交付目标；当前 Windows 实现不代表 macOS、Linux 或 WSL 已经可用。

拟新增 TypeScript 记录契约：

```typescript
interface HermesInstallRequest {
  platform: 'windows-x64' | 'linux-x64' | 'macos-arm64' | 'macos-x64';
  version: string;
  installRoot: string;
  hermesRoot: string;
  profileScope: 'current' | 'all-existing';
  selectedProfile?: string;
  browserMode: 'managed' | 'manual';
}
interface TabroInstallRecord {
  schemaVersion: 1;
  version: string;
  installRoot: string;
  dataRoot: string;
  brokerUrl: string;
  tokenFile: string;
  adapterLauncher: string;
  extensionPath: string;
}
interface HermesInstallResult {
  status: 'ready' | 'awaiting-browser' | 'failed';
  changedProfiles: string[];
  preservedProfiles: string[];
  recordPath: string;
  recoveryHint?: string;
}
```

`current` 与 `all-existing` 的最终默认范围属于后续安装 UX 决策，本计划不替换现有全 Profile 注册约定。执行前显示范围，保存既有配置；不同 Broker URL 的既有注册不能被一个批量命令无条件覆盖。

### 插件 MCP 与手写 MCP 配置必须避免重复和遮蔽

Hermes 当前在同名 MCP 冲突时优先采用 `config.yaml` 项。因此安装器需要识别已有 `mcp_servers.tabro`，核对地址与版本，保留可用项或提供明确的接管路径，不能安装插件后误称其入口已经生效。更新回退只恢复本次修改，并检查文件是否已被其他进程修改。

### 已有健康的 Tabro 接入应直接复用而不重复安装运行组件

Plugin 包本身仍需安装以提供 Skill 和接入管理能力，但安装器先检测再决定是否下载运行包。存在任意 MCP 或只有 `tabro` 配置名称都不证明 Tabro 可用：应核对目标 Hermes Profile 的实际生效配置、适配器与 Broker 版本、认证是否有效、十八工具的名称与 schema，以及本地组件定位记录。发现配置时不能先启动第二个 Broker，再检查冲突。

| 检测结果 | 安装器动作 | 对已有配置与数据的影响 |
| --- | --- | --- |
| 现有 Tabro 接入正常且兼容 | 安装 Plugin 元数据与 Skill，记录 existing 接入来源；跳过运行包下载、重复 Native Host 注册和扩展替换 | 保留当前有效 `config.yaml` MCP 项；插件同名项被遮蔽时不报告为已接管，工具只来自一个有效入口 |
| 合格本地组件齐全但 Broker 停止 | 核验进程、目录和配置后启动已有 Broker，再验证 MCP | 复用原数据与端口，不重装；来源不明确时先报告而非误启服务 |
| 组件缺失、损坏或版本不兼容 | 明确列出需要修复或升级的组件，按用户选定策略执行必要变更 | 保留 Chrome 身份、Cookie、配对信息和可回退配置；不自动更新仍被其他 Hermes Profile 使用的共享 Broker |
| 没有 Tabro 接入，或只有其他产品 MCP | 运行对应平台的完整安装流程 | 新建 Tabro 安装记录与目标接入，不覆盖其他 MCP |

默认保留正常的既有注册即可让 Plugin Skill 使用现有工具；安装 Plugin 不要求立即迁移到插件提供的 MCP。用户已要求先统一两套运行环境，十四个 Profile 现在共同读取动态 Broker 记录。后续由 Plugin 管理入口时备份目标配置、接管该共享记录、迁移同名项，并在新会话验证实际来源；Plugin 不再次合并数据库或搬移浏览器数据。

浏览器窗口已关闭与 MCP 已坏是两种状态。配置与工具探测通过但无浏览器连接时，返回“接入已复用，等待浏览器”，任务开始后打开既有受管 Profile 即可，不因窗口关闭重装扩展或创建新身份。菜单与插件启动时只做廉价检测；有副作用的修复、安装或迁移走明确安装入口。

### 插件接管后各 Hermes Profile 只保留启用状态和连接定位而不复制启动命令

新接入模式中，stdio `command`、`args` 与通用启动环境声明归插件包 `mcp.json`，Hermes 发现已启用插件后在运行时合并这些声明，不要求复制进每个 Profile 的 `config.yaml`。各 Profile 仍有自身的插件启用状态和可写 `${PLUGIN_DATA}`；Tabro 拟议的定位记录保留 共享运行记录、令牌文件路径和安装记录路径，各 Profile 复用同一 Broker，但不存明文令牌。

`launch.mjs` 读取当前 Profile 的定位记录再调用适配器，公共启动逻辑只维护在插件中。这不会把不同 Agent 的 stdio 通道或所有权身份合并；独立 Agent 仍需可区分的运行身份。Broker 与 Chrome Profile 的持久数据继续在插件树之外。

保留旧接入时，`mcp_servers.tabro.command/args` 仍存在，并且当前 Hermes 的同名原生配置优先，实际工具仍由旧入口提供。选择 Plugin 接管时才备份并移除目标 Profile 的该项，由插件声明成为有效来源；不能同时保留旧同名项又声称已切换到 Plugin。上述 Tabro 定位与迁移逻辑尚未实现，Hermes 的插件发现和同名配置优先级已由本地源码核对。

## 本机迁移

### 复用现有安装的迁移包必须先于完整发行安装器验证

本机迁移采用最小 Portable 包：`plugin.json`、`mcp.json`、`launch.mjs`、必要的平台启动包装器和 `skills/tabro-browser/SKILL.md`。使用实际合格 Node 和现有适配器，不下载或重建 Broker、Native Host、扩展。发布包仍包含三平台 setup 入口，但平台运行未验收时明确标记，不让本机迁移依赖它们已经可用。

启动声明必须满足 Hermes Portable 的命令约束：裸可执行名称或 `./` 插件内可执行入口，不能把本机 `C:\Program Files\nodejs\node.exe` 硬编码进公开 `mcp.json`。平台包装器从私有定位记录取得 Node 绝对路径，并按参数数组调用；包装器用 `exec` 或继承标准流的子进程保持 stdio 纯协议、退出和信号语义。PATH 缺失和路径空格在隔离验收中覆盖；不靠修改 Hermes 核心绕过契约。

新迁移助手拟为 `tools/migrate-hermes-plugin.py`，支持只读计划、应用、验证与回退。读取原 `mcp_servers.tabro`，保留统一后的 `command/args`、共享运行记录与令牌文件路径、运行身份和 Demo trace 等非秘密配置语义，写入当前 Profile 的 `${PLUGIN_DATA}` 定位记录。若存在直接令牌值，停止公开输出并采用私有存储策略，不能复制到 Plugin 包；正常本机配置已使用令牌文件。

迁移顺序是：保存快照与摘要 → 准备定位记录 → 安装未启用的合格 Plugin → 验证启动器读取与旧接入同一 Broker → 仅移除目标 Profile 的旧同名 MCP 项 → 启用实际插件 ID → 新进程验证实际来源及十八工具。运行中的会话可能仍缓存旧工具，因此切换不能只依赖 `plugins list`；目标 Gateway 在安全空闲点单独重新加载或重启，已有历史聊天不作为新入口的自动证明。

Hermes 的 `plugins install` 接受 Git 来源（包括带安全提示的本地 `file://` Git 仓库），不能将任意源码子目录路径当作已支持的安装源。开发时构建独立临时 Git 包并固定提交，使用 CLI 的 `--ref` 安装；发布时换为合格仓库和固定提交。插件实际 ID、命名空间和 `${PLUGIN_DATA}` 目录由验证结果取得，不猜测其一定就是 `tabro`。本轮不创建或推送发布仓库。

试点为 `tabro-1`，复用共享动态 Broker；通过后迁移 default、tabro-2，再逐个迁移其余十一个 Profile。某个目标失败时恢复该 Profile 原 MCP 项与原插件启用状态，停止扩大范围；成功目标不强制回滚。回退比较当前摘要或配置语义，拒绝覆盖并发更改，不恢复整份过时配置覆盖其他插件。

## 菜单

### 菜单接入需要一个支持 MCP 工具集合的通用浏览器后端扩展点

向 Hermes 提议：浏览器后端除了 `CDP session`，还能声明 `MCP toolset`；公开提供菜单元数据、安装动作、状态检查、选择持久化和对应工具集合启用能力。命名与 Python 接口由上游协商，本计划不把拟议字段当作已存在 API。

选择 Tabro 后启用其规范十八工具和 Skill；原有 `browser_*` 工具的选择路由必须明确，避免 Agent 仍走 Browser Use。不重新实现十八个 Python 同名工具，不给 Agent 绕过 Broker 的裸调试端口。若上游只允许 CDP Provider，则保持独立 MCP 插件，继续讨论通用接口；不能伪造符合接口的成功结果。

状态至少区分：未安装、安装中、等待浏览器、可用、异常；`active` 只表示被选中，不能替代健康与连接检查。插件发现和菜单刷新仅做廉价本地检查，不执行下载、创建 Profile 或启动 Chrome。

## 上游

### 上游沟通分开讨论独立插件、通用接口和默认发现

按当前[贡献指南](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md#third-party-product-integrations-ship-as-a-standalone-plugin)，第三方集成在独立仓库维护。先提供可安装插件和可重复演示，再提交通用接口需求；默认菜单中未安装选项的发现方式、目录准入和更新责任单独沟通。不能承诺对方一定预置 Tabro。

建议发送内容：

> We maintain Tabro, a local MCP browser backend for persistent Chrome profiles and agent-owned tab-group workspaces. We plan to ship it as a standalone Hermes plugin. The existing CDP-session provider interface does not represent an MCP tool backend. Would you support a generic Browser Automation setup extension for MCP backends, including selection, installation, readiness, and toolset activation? We can contribute a small implementation and tests while keeping Tabro runtime maintenance in our repository. We would also like to discuss an optional discovery entry once the integration is qualified.

这是待发送草稿，本轮未发布 Issue、PR 或社区消息。沟通材料附：一键安装录屏、双身份本地 Demo、双 Agent 隔离证据、支持平台、卸载与回退说明、兼容版本矩阵。先搜索已有 Issue 与 PR，避免重复提案。

依据：[官方插件文档](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/)、[官方 BrowserProvider 源码](https://github.com/NousResearch/hermes-agent/blob/main/agent/browser_provider.py)；本地源码核对版本见计划 README。
