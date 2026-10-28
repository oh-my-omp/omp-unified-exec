# omp-unified-exec fork

[English](README.md) | 简体中文

本仓库是 [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec) 面向 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）的 fork。omp 在 2026 年初从 Pi 分叉，通过一个只覆盖 Pi 部分新 API 的兼容层加载 Pi 包，所以上游的新版本可能在 omp 上无法加载。

安装：`omp install https://github.com/oh-my-omp/omp-unified-exec`。请先卸载已有的 `pi-unified-exec`（`omp plugin uninstall pi-unified-exec`）：两者都注册 `exec_command` 和其他 unified-exec 工具。

## 定制

| 改动 | 文件 | 原因 | 上游 |
|---|---|---|---|
| 包名 `omp-unified-exec` | `package.json`（`name`、`repository`、`homepage`） | omp 以包名命名插件 | 仅 fork |
| 仅使用环境变量的界面 i18n（`OMOMP_LANG`，然后是 locale 环境变量回退） | `src/i18n.ts`、`src/index.ts`、`fork-features/omp-presentation.ts`、`fork-features/tern-terminal-hud.ts`、`fork-features/terminal-notice.ts`、两个 README | 这个 Pi 兼容 fork 不能依赖启动时的 `omomp-lang` 扩展或 `omomp` 文件；所有面向人的插件界面都遵循启动环境，同时保持模型/协议文本稳定 | 仅 fork |
| 为 fork 重写的中英文 README：Tern 录屏演示、omp 安装、Tern 终端 HUD、omp 呈现、fork 结构；移除上游的 npm、徽章和维护公告 | `README.md`、`README.zh-CN.md`、`docs/assets/demo.{gif,mp4}`、`docs/assets/demo-lazygit.{gif,mp4}` | fork 的行为和安装方式已经偏离上游 README（npm 包、仅 Pi 的呈现），继续沿用会误导 omp 用户 | 仅 fork |
| 只支持 omp：非 omp 宿主在扩展 factory 阶段、激活之前被拒绝 | `fork-features/omp-presentation.ts`、`src/index.ts`、`tests/omp-presentation.test.ts`；`package.json` 的 `omp.extensions` | `ExtensionAPI.arktype` 用于识别 omp。具名导出 `activate` 是直接测试工具核心的接缝，不是另一个受支持的宿主入口。 | 仅 fork |
| 仅 Bun 的原生 PTY 后端与测试运行器 | `src/pty.ts`、`fork-features/omp-presentation.ts`、`tests/pty-load.test.ts`、`tests/bun-pty-runtime.mjs`、`package.json`、`.github/workflows/ci.yml` | omp 是编译后的 Bun 可执行文件。每个会话都使用 `Bun.Terminal`（Bun 1.4+），在 Linux/macOS 上提供 `openpty`，在 Windows 上提供 ConPTY。factory 在加载 omp 模块或激活前要求 `Bun.spawn` 和 `Bun.Terminal`；Bun 原生测试运行器在三平台运行完整套件，并运行源码/编译版 runtime fixture。 | 仅 fork |
| omp 呈现：exec_command、write_stdin 和 kill_session 通过 omp 的 bash 渲染器渲染；其他工具使用 omp 的默认卡片 | `fork-features/omp-presentation.ts`、`fork-features/omp-tools.d.ts`、`tests/omp-presentation.test.ts`；`src/index.ts` 中的 `withHostPresentation`；`package.json` `files` 和 `tsconfig.json` 中的 `fork-features` | omp 负责 `renderCall`/`renderResult` 和 Tern 的 `describeCall`/`describeResult`。仅用于显示的适配器和输入预览辅助函数都位于 `omp-presentation.ts`；bash 渲染器来自 `@oh-my-pi/pi-tui/tools` 的 `toolRenderers.bash`，缺少这项契约时让插件加载失败。 | 仅 fork |
| Tern 终端 HUD：omp 自己的运行中计数药丸里的一个终端分段（终端图标和已存储的会话数量），排在 agents 和 jobs 分段之后；点击打开 Terminals 视图，仿照 omp 的 Background jobs 视图（会话作为左侧列表，带图标、标题和已运行时间；选中会话的状态行（含 Kill 和 Open）、命令、facts 和彩色输出；运行中/存储中汇总和 Close）；Open 显示一个按 omp Console 框架显示、以会话标题为题头的全 pane 终端页，键入的按键发送给会话 | `fork-features/tern-terminal-hud.ts`、`fork-features/tern-plugin-removal.ts`、`fork-features/omp-tools.d.ts`、`tests/tern-terminal-hud.test.ts`、`tests/tern-plugin-removal.test.ts`、`tests/fixtures/tern-cli.mjs`；`src/terminal-screen.ts` 中的 `TerminalScreen.styledScreen`/`onChange`，`src/session.ts` 中的 `ExecSession.styledScreen`/`onScreenChange`/`exitedAt`，`src/session-store.ts` 中的 `SessionStore.subscribe`；`src/index.ts` 中的 `activate` 把存储和基于 `terminateSessionById` 的 kill 交给 `withHostPresentation` | 工具结果只显示该次调用返回时的会话屏幕（[#17](https://github.com/oh-my-omp/omp-unified-exec/issues/17)）。omp 没有加药丸分段的 API（[#76](https://github.com/oh-my-omp/omp-unified-exec/issues/76)）：HUD 在每个进程里包装一次 `InteractiveMode.prototype.describeHudPills`（`Symbol.for` 注册表持有当前激活的装饰函数），为每个 interactive mode 追加一个分段组件作为药丸的最后一个子节点；omp 没有药丸时创建并显示它，从不修改 omp 缓存的行。装饰函数恰好在交互会话原生渲染时注册；存有会话时分段出现，包括命令已返回但尚未回收的会话，存储或退出变化会请求 omp 的 TUI 重新渲染。胶囊、分隔线以及 Reader、Spine、Console 的几何布局都由 Tern 负责。视图和终端页是声明 omp 自己 role 的自定义 overlay（[#77](https://github.com/oh-my-omp/omp-unified-exec/issues/77)）：视图的 `nativeOverlay` 为 `omp.overlay.jobs`（lg、居中、标题 Terminals），内部使用 jobs 面板的 `omp.jobs.*` role 树；`full` 终端页使用 `omp.overlay.console`。两者都由 Tern 的自带样式绘制，不需要插件；选择、按键、Open 和 Kill 仍由组件负责，终端页显示来自保留历史和当前屏幕的彩色、可滚动 `ansi`（[#19](https://github.com/oh-my-omp/omp-unified-exec/issues/19)）。被 await 的 omp 工厂会移除早期版本安装的 `omp-unified-exec` Tern 插件（`plugin remove`，Tern 回答它是链接时改用 `unlink`，再以 `plugin list` 确认）；没有 Tern 时跳过，Tern 失败时让加载失败。只有终端页的键入和视图/终端页的 Kill 会作用于会话；模型可见的结果仍是纯文本。 | 仅 fork |
| 进程内唯一的终端资源与 `read term://` | `fork-features/terminal-resource.ts`、`fork-features/terminal-url.ts`、`src/terminal-screen.ts`、`src/session.ts`、`src/session-store.ts`、`src/tool-result.ts`、`src/script-result.ts`、`src/index.ts`；在 `omp-presentation.ts` 初始化 | omp 的 `@oh-my-pi/pi-coding-agent/internal-urls` 提供进程级单例 `InternalUrlRouter.instance().register(handler)`。唯一的 `term` 处理器读取 `Symbol.for` 共享索引，带 UUID 后缀的键隔离不同激活与重载。物理行投影不消费输出；会话在输出关闭且解析完毕时冻结。冻结的行与活动屏样式单元格副本保留到进程结束；关闭时只丢弃自身尚未冻结的活动资源。 | 仅 fork |
| 经 `read term://…/screen.png` 读取终端截图 | `fork-features/terminal-image.ts`、`fork-features/terminal-url.ts`、`fork-features/omp-tools.d.ts` | 宿主 `@oh-my-pi/pi-natives` 根导出的 `rasterizeSvg(Uint8Array, maxWidthPx, maxHeightPx)` 使用系统字体栅格化 SVG，无需安装脚本。file 型 scheme 的 `locate()` 把私有 PNG 交给生产 `read`；文本路径返回 null，仍正常 resolve。只有模拟器复制的单元格进入 SVG。Live 外观/光标和 Frozen 外观/无光标共用 K1 投影。 | 仅 fork |
| 后续输出 monitor、多次后续唤醒与一次性的未返回提醒 | `fork-features/monitor-subscription.ts`、`src/completion.ts`、`src/session.ts`、`src/terminal-screen.ts`、`src/index.ts`、`src/script-result.ts`、`tests/monitor.test.ts` | 源头建立不消费输出的后续观察边界；完成协调器拥有实际订阅，并合并 End 与普通唤醒。每个订阅还拥有一个提醒：`remind_after_ms`（默认 20 分钟）内没有送达匹配或 End 时，经同一条串行投递（End 先于匹配，匹配先于提醒）发送一条引用当前屏幕的 `monitor_silent` 通知。匹配、End 和提醒都是终端通知，交给唯一的通知投递器，由它负责合并与重试。 | 仅 fork |
| 对每个运行中会话的等待输入提醒，有没有 monitor 都一样 | `fork-features/input-wait.ts`、`src/session.ts`（`watchInputWait`、`collect` 挂接计数）、`src/terminal-screen.ts`（`inputProbe`、`unseen`）、`src/completion.ts`（`alertInputWait`）、`src/index.ts`、`tests/input-wait.test.ts` | 没有终端协议表示程序在等输入：debconf 的问题（如 `apt upgrade` 时的 sshd_config）到 PTY 上只是 whiptail 的绘制，经 ssh 时本机进程状态也不提供信息。安静 5 秒后，对没有被工具结果展示过的屏幕匹配对话框按钮、光标处提示和分页器提示；每一屏只以一条 `input_wait` 终端通知提醒一次，投递器对每个会话只保留最新一屏，屏幕不再是当前且未展示时就丢弃。 | 仅 fork |
| 必填的 `exec_command` 标题、终端生命周期与唯一的终端通知通道：后台终端命令返回后，异常返回立即提醒；返回或最近一次读取 30 分钟后，从未读过的发读取提醒，读过的发即将回收提醒并给 5 分钟反悔期；反悔期内未再读就回收，结束其进程组剩下的进程并移出存储；每条后续消息（唤醒、monitor、等待输入、生命周期）都是一个 `TerminalNotice`，合并成一条 `unified-exec-notice` 消息 | `fork-features/terminal-notice.ts`、`fork-features/terminal-lifecycle.ts`、`fork-features/terminal-resource.ts`（`noteTerminalRead`、`detachTerminalReader`）、`fork-features/terminal-url.ts`、`fork-features/monitor-subscription.ts`、`fork-features/input-wait.ts`、`fork-features/tern-terminal-hud.ts`；`src/index.ts`、`src/completion.ts`、`src/session.ts`（`title`、`onShellExit`、`onTerminalRead`、`signalProcessGroup`）、`src/pty.ts`（`onProcessExit`、`signalGroup`）、`src/script-result.ts`；`tests/terminal-lifecycle.test.ts` | 上游只在第一次观察到退出的 `write_stdin`/`list_sessions` 时清除已退出会话，此外从不清除，所以经 `term://`（fork 的读取方式）读过的终端会一直留到 64 个会话的 LRU，其后台任务也一直运行。生命周期从 `session_id` 起管理每个后台终端直到回收：shell 退出是即时的 PTY 事件（Bun 的 `onExit` 早于终端关闭）；读取来自交付内容之后的 `term://` 处理器，以及在 `tool_execution_end` 定稿的工具结果；每分钟一次的检查驱动 TTL（时钟可经 `activate` 的 `lifecycleClock` 注入）。回收在终端关闭后仍向进程组发信号，因为 macOS 上终端随 shell 一起关闭，组内其他进程却继续运行。模型或人的 kill 是正常结束，并算作读过。各来源各用一个 customType 无法合并，所以通知 ADT 给所有来源同一个格式化器（会话 id、标题、简短原因）和同一个投递器（250 ms 合并，在工具结束、运行结束和每分钟检查时重试，丢弃过时通知）。 | 仅 fork |
| 仅 PTY 的 `exec_command`：每个会话都在 PTY 中运行；删除管道后端、`tty` 参数/结果字段、内存原始输出保留、管道 monitor 解码，以及移除宿主 `bash` 的参数 | `src/pty.ts`、`src/session.ts`、`src/collect.ts`、`src/long-wait.ts`、`src/output-safety.ts`、`src/index.ts`、`src/shell.ts`、`src/tool-result.ts`、`src/script-result.ts`、`src/terminal-screen.ts`、`fork-features/monitor-subscription.ts`、`fork-features/terminal-resource.ts`、`fork-features/tern-terminal-hud.ts`、`fork-features/omp-presentation.ts` | 管道会话无限保持 stdin 打开，与宿主 `bash` 重复，却缺少其审批、direnv、Git Guard、自动后台与输出整形（[#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)）。PTY 把每次读取限制为渲染后的屏幕状态，及时刷新交互输出，并把 Ctrl-C 交给前台进程组。短命令留给宿主 `bash`；写入不追加内容，PowerShell 使用 `-NoProfile -NoLogo -Command`，缺少 PTY 后端时明确报错，退出的进程不会重启。 | 仅 fork |
| Shell 选择跟随宿主：显式 `shell`，然后是 omp 实时的 `shellPath`，然后是 `SHELL`，最后是平台默认值；结果、流式更新、kill 结果和会话列表写明实际启动的可执行文件 | `fork-features/omp-presentation.ts`（`loadOmpShellPath`，由 `withHostPresentation` 传给 `activate`）、`fork-features/omp-tools.d.ts`；`src/shell.ts` 中的 `resolveDefaultShell`；`src/index.ts` 中 `runExecCommand` 的 shell 解析和 `activate`；`src/session.ts` 中的 `ExecSession.shell`；`src/tool-result.ts` 和 `src/script-result.ts` 中的 `shell`；`tests/shell.test.ts`、`tests/e2e.test.ts` | 上游在 POSIX 上固定使用 `bash`，在 Windows 上自行探测，所以 omp 配置的 shell 或登录 shell 可能与实际执行命令的 shell 不同，而结果也不说明用的是哪个（[#63](https://github.com/oh-my-omp/omp-unified-exec/issues/63)）。`shellPath` 归 omp 所有：`@oh-my-pi/pi-coding-agent/config/registry` 提供 `lookup("shellPath").get(host.pi.settings)`。通过准入的 factory 与其他 omp 模块一起加载它；每个新进程都通过该 getter 读取有效设置，从不使用激活时的副本。注册表形状改变时让插件加载失败。shell 解析先于 argv 构造，失败后绝不换用优先级更低的 shell。`ExecSession.shell` 读取 `command[0]`，所以后续结果沿用实际启动的可执行文件。命令文本不做转换：cmd 和 PowerShell 保留各自的 argv；其他 shell 一律使用 `-c`。 | 仅 fork |
| 命令审批与宿主会话绑定（[#29](https://github.com/oh-my-omp/omp-unified-exec/issues/29)） | `fork-features/command-approval.ts`、`fork-features/session-binding.ts`、`fork-features/omp-presentation.ts`、`fork-features/omp-tools.d.ts`、`src/index.ts`、`tests/command-approval.test.ts` | `exec_command` 在执行之前用内置 bash 的决定逻辑检查原始 `cmd`。第一次 `session_start` 经 `AgentRegistry.global().get(ctx.agent.id)?.session` 取得会话并核对 `sessionManager` 身份；switch/branch 只复核身份。每次审批读取实际会话的实时 settings，不用全局 settings 或 cwd。Unbound 不读 settings，返回裸 `exec`，不禁用执行。其他工具保留宿主默认审批。 | 仅 fork |
| 经 `exec_command` 执行的 `gh` 变更命令在 PTY 启动前使 omp 的 `issue://` / `pr://` 视图缓存失效（[#32](https://github.com/oh-my-omp/omp-unified-exec/issues/32)） | `fork-features/omp-presentation.ts`（`loadGithubCacheInvalidation`）、`fork-features/omp-tools.d.ts`；`src/index.ts` 中的 `runExecCommand` 与 `activate` | 交互式 `gh` 变更命令（merge 确认、comment 编辑器）需要终端，因此走 `exec_command`，宿主 bash 的失效从来看不到它们。factory 导入 omp 的 `tools/gh-cache-invalidation.invalidateGithubCacheForBashCommand`，在 spawn 之前以原始 `cmd` 调用，与 `BashTool.execute` 相同；检测逻辑与 SQLite 缓存都归宿主所有。omp 升级后重新验证该导出仍存在，且经 `exec_command` 的 `gh issue close` 使下一次 `issue://` 读取重新获取。 | 仅 fork |
| 仅输入的 `write_stdin`；空轮询及其截止时间/配置路径已删除（[#44](https://github.com/oh-my-omp/omp-unified-exec/issues/44)） | `src/index.ts`、`src/completion.ts`、`src/long-wait.ts`、`src/format-time.ts`、`src/tool-result.ts`、`src/script-result.ts`、`fork-features/omp-presentation.ts`；删除 `src/time.ts` | 状态与内容用 `term://` 读取，事件与完成用 monitor 等待；写入要求解码后非空，否则返回类型化 `empty_poll_removed`，不消费观察。完成唤醒指向各终端读取地址；输入附着窗口与仅在人明确要求时启用 wake 的策略不变。 | 仅 fork |
| 删除上游的 IV/DC 设计文档（`docs/DC-0001-agentic-workspace.md`、`docs/IV-0001-long-wait-and-wake-control.md`、`docs/IV-0002-output-lifecycle-and-rendering.md`） | `docs/`、`README.md`、`README.zh-CN.md`、`docs/DEV.md` | 它们承载的是上游的设计与文档制度，已与 fork 严重脱节。fork 的可观察契约在 README 中，与上游的差异和重新验证方法在本文件中，不变量在代码与测试中。 | 仅 fork |
| 为 fork 重写 `AGENTS.md`：本仓库的 changelog、双语文档、提交、定制与验证规则。上游改动前先读 IV/DC 文档的规则、Pi codemode 重新验证要求、pi-mono 克隆指引和前沿模型列表都已去掉 | `AGENTS.md` | 上游的文件指导的是一个 Pi 包的工作，其代码和文档已被 fork 删除；其模型列表列的是已被取代、本仓库也没有任何地方使用的模型。 | 仅 fork |
| 会话日志名带上所属 omp 的 pid（`pi-unified-exec-<pid>-<sid>-<hex>.log`）；最后写入超过七天、且写入方确认已不存在的日志被替换为标准 gzip `<log>.gz`，从不删除 | `fork-features/log-archive.ts`、`fork-features/omp-presentation.ts`（`scheduleLogArchive`）、`src/session.ts`、`tests/log-archive.test.ts` | 上游让所有原始日志永远以未压缩形式保留。写入方不存在指：本进程已关闭该日志流（一份跨重载保留的进程级打开日志流记录），文件名中的 pid 已不存在，或日志最后写入于本次开机之前。仅凭 mtime 无法证明别的进程没有仍持有某个空闲会话的 fd，而在写入方仍存活时 unlink 会丢失其后续输出。gzip 先写入私有的 `wx` 临时文件，用 `link` 发布（从不覆盖已有归档），只有源文件的 device、inode、大小与 mtime 都未变时才 unlink 源文件。omp 在加载时扫描一次，之后由不阻止进程退出的定时器每天扫描一次。 | 仅 fork |
| 运行进行期间通知只等待，运行结束时合并送达；“完成的工作”判定门对主 agent 的最终回复做一次判定（`auto`：OMP 的 judge 角色，否则 `@smol`，否则 omp-todo-more 的各状态项数），工作已完成时静默回收全部已返回终端并丢弃其通知；omomp 的 `omp-unified-exec` 段设置 `stop`（`off`/`auto`/`judge`/`llm`/`todo`）以及带占位符的 `judgePrompt` 和 `noticeTemplate` | `fork-features/stop-config.ts`、`fork-features/stop-gate.ts`、`fork-features/terminal-notice.ts`（`NoticeDispatcher` 的运行阶段、`NoticeGate`、`isLifecycleNotice`、通知模板）、`fork-features/terminal-lifecycle.ts`（`collectReturned`）、`fork-features/omp-presentation.ts`（`loadStopHost`）、`fork-features/omp-tools.d.ts`、`fork-features/session-binding.ts`；`src/index.ts`（`agent_start`、`agent_end`、`session_stop`）；`tests/stop-gate.test.ts`、`tests/current-api.test.ts` | 在会话 `01a17846` 中，一次 90 分钟运行期间以 `followUp` 发出的通知停在 omp 的后续消息队列里（扩展无法修改该队列），最终答复之后每条各自触发一轮（约 60 轮回答 “Nothing to do here.”），之后每隔几分钟还有生命周期提醒。上游的 `agent_settled` 刷新点在 omp 中不存在。投递器从 `agent_start` 起暂存通知，直到一次 omp 不再继续（或等待后台工作）的 `agent_end`，再发出一条消息。在 `session_stop` 给出最终回复后的第一次发送之前判定一次，并用世代号隔离：每次 `agent_start`、switch 和 branch 都会推进世代，因此跨过了所属停止的判定结果不产生任何作用。回收仍归生命周期（`collectReturned`：静默，仍被占用的终端保持原状态），所以被回收的终端之后不会再有提醒。判定器在 factory 加载时载入 omp 的 `judgment`（`resolveJudge`、`journalJudgmentUsage`、`sharedJudgmentCache`、`kindOf`）、`config/model-resolver.resolveRoleChain`、`config/model-roles.roleCandidatePool`、`@oh-my-pi/pi-ai.completeSimple` 与 `getAgentDir`；todo 判定读取 omp-todo-more 的 `omp-todo-more:read` 回复中的 `counts`。 | 仅 fork |
| 六个 PTY 工具面向模型的文本：每条规则只写一次，写在工具描述或该参数自己的注释里；删除 `promptSnippet` 与 `promptGuidelines`；`exec_command` 描述的前 200 个字符写明与 `bash` 的分工、没有命令截止时间、返回 `session_id` 还是 `exit_code`（[#88](https://github.com/oh-my-omp/omp-unified-exec/issues/88)） | `src/index.ts` | omp 把插件设备内联进 system prompt 时，只取描述的前 200 个字符并在此截断，参数 schema 连同注释整段内联；它从不读取 `promptSnippet` 或 `promptGuidelines`。旧的 `exec_command` 描述截断在半个词上，决定怎样调用它的事实全在截断点之后；描述与参数注释之间重复的规则在每次请求里都要计费。 | 仅 fork |

已有工具名与仍保留的环境变量（`PI_UNIFIED_EXEC_*`）保持原名。只用于已删除路径的模块直接移除，不保留兼容 shim。

## 仓库状态

- `Publish to npm` 和 `Interaction limit reminder` 已用 `gh workflow disable` 禁用：fork 不向 npm 发布任何内容，提醒跟踪的是上游自己的互动限制。这是仓库状态，所以把 workflow 文件同步回来也不会重新启用它们。
- `Sync upstream`（`.github/workflows/sync-upstream.yml`）每天通过以 `CI` 为门禁的 PR 把 `upstream/main` 合并进 `main`。
- `Release`（`.github/workflows/release.yml`）为每次推送到 `main` 生成新的 patch 版本：`fork-features/release-version.ts` 升级 `package.json` 和 `package-lock.json` 的两个版本字段，把 `Changelog.md` 顶部的 `## Unreleased` 改名为 `## X.Y.Z - YYYY-MM-DD`，并在其上新开一个空的 `## Unreleased`；随后由 bot 向 `main` 提交 `chore: release X.Y.Z`。版本号不再手动修改。短时间内连续推送可能共用一个版本；`Changelog.md` 的第一节不是 `## Unreleased` 时，运行失败。

## 预期的同步冲突

`name` 紧挨着 `version` 那一行，git 把相邻行的修改视为冲突。上游每次发布都会改 `version`，所以它的同步会以待审 PR 的形式到来。解决方法：保留 `"name": "omp-unified-exec"`，`package.json` 与 `package-lock.json` 中保留 fork 自己的 `version`；合并进入 `main` 后由 `Release` 升级。

本仓库的 `exec_command` 只用 PTY（[#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)）：管道后端（`spawnPipes`、codex 首尾缓冲区的移植、`collectOutputUntilDeadline`、流式 `OutputTextSanitizer` 和管道 monitor 解码）、`tty` 参数与结果字段，以及移除宿主 `bash` 的参数都已删除，PowerShell 以 `-NoProfile -NoLogo -Command` 运行。上游对这些代码的改动会以 modify/delete 或内容冲突的形式到来。解决方法：保留删除，只把对 PTY 会话仍然成立的事实（shell 选择、信号、Windows 进程树、结果字段）搬进 PTY 代码；不要恢复管道路径、`tty` 参数、该参数或只为管道存在的 PowerShell 参数。

插件宿主与 PTY 后端都只用 Bun；上游对 Node PTY 后端的改动保留删除，不恢复该路径。

上游 v0.13 的 steer gate（`src/steer-gate.ts`、`wait_status: "interrupted_by_steer"`、`PI_UNIFIED_EXEC_STEER_INTERRUPT`；上游 `d393051`、`f5e5d96`、`1baa416`）不采用，以 `ours` 策略合并（[PR #1](https://github.com/oh-my-omp/omp-unified-exec/pull/1)）。本 fork 面向 omp，其扩展上下文没有 steering 信号。空轮询、`yield_until` 与对应环境变量上限已删除，改用 `read term://` 和 `monitor`（[#44](https://github.com/oh-my-omp/omp-unified-exec/issues/44)）。上游对这些路径或 steer 等待的改动会以 modify/delete 或内容冲突的形式到来，保留删除，不恢复参数、配置和等待辅助代码。

omp 没有 `agent_settled` 事件，因此 fork 在运行真正结束的 `agent_end` 刷新通知，在 `session_stop` 记录最终回复。上游对其 `agent_settled` 处理器或 `src/index.ts` 中 `flushPending` 调用点的修改会以内容冲突的形式到来；保留 `agent_start` / `agent_end` / `session_stop` 处理器和投递器的运行阶段，只移植对它们仍成立的事实。

本仓库的 shell 选择跟随宿主（[#63](https://github.com/oh-my-omp/omp-unified-exec/issues/63)）：上游的 `resolveDefaultShell` 在 POSIX 上返回 `bash`，其 `shell` 参数说明也这样写，spawn 选项还记录原始 `shell` 参数。上游对这些地方的改动会在 `src/shell.ts`、`src/index.ts` 和 `src/session.ts` 中以内容冲突的形式到来。解决方法：保留优先级（显式 `shell`、omp `shellPath`、`SHELL`、平台默认值）、在 `buildShellCommand` 之前解析，以及 `ExecSession.shell` 取 `command[0]`；上游对 Windows Git Bash/PowerShell 探测的修复只搬进平台默认值分支，选中的 shell 失败后也绝不增加回退。

六个 PTY 工具面向模型的文本归 fork 所有（[#88](https://github.com/oh-my-omp/omp-unified-exec/issues/88)）。上游对 `src/index.ts` 中这些工具的 `description`、参数注释、`promptSnippet` 或 `promptGuidelines` 的改动会以内容冲突的形式到来。解决方法：保留 fork 的文本，只并入在这里仍然成立的事实，且每条只写一次：参数独有的类型、默认值、范围与互斥约束写进该参数的注释，其余写进描述；不恢复 `promptSnippet` 和 `promptGuidelines`。`exec_command` 描述的前 200 个字符必须继续写明与 `bash` 的分工、没有命令截止时间、返回 `session_id` 还是 `exit_code`，并在完整的词处结束。

`README.md` 和 `README.zh-CN.md` 归 fork 所有。同步改动到 README 时，保留 fork 的版本，只把在这里仍然成立的上游事实（工具参数、限制、语义）写进两个文件中 fork 对应的章节；两者保持逐节互译，`fork-features/README.md` 和 `fork-features/README.zh-CN.md` 也一样。

上游的 IV/DC 设计文档已删除。上游对 `docs/IV-*` 或 `docs/DC-*` 的改动会以 modify/delete 冲突的形式到来。解决方法：保留删除，只把在这里仍然成立的事实写进 README 或本文件，不恢复这些文档或指向它们的链接。

`AGENTS.md` 归 fork 所有。上游对它的改动会以内容冲突的形式到来。解决方法：保留 fork 的文件，只搬入适用于本仓库的规则；不恢复先读 IV/DC 文档的规则、Pi codemode 重新验证要求、pi-mono 克隆指引或前沿模型列表。

会话日志的命名与归档归 fork 所有。上游对 `ExecSession`（`src/session.ts`）中日志路径的改动会以内容冲突的形式到来。解决方法：保留 `fork-features/log-archive.ts` 中的 `sessionLogName` 与 `trackOpenLog`，只搬入上游关于写日志的事实。

omp 升级后，要重新验证 `@oh-my-pi/pi-coding-agent/internal-urls`：
`InternalUrlRouter.instance().register(handler)` 必须与生产 `read` 共用路由；
`getHandler("term")` 必须返回同一个可变对象，每次请求读取其 spec 与方法。
最终处理器使用 `{backing: "file", selectors: "lines", immutable: false}`：
`locate()` 仅为 `/screen.png` 返回文件路径，文本路径返回 null。
通过真实 `read` 验证全部保留行、`/screen`、`tmux` 内的裸读取（须与 `/screen` 相同）、正负页码、head/tail、
未知键与越界错误；确认子 agent 的同号键不混淆，退出、终止、LRU 后仍可读，
两次重载后旧 URL 仍可读，既不消费观察状态也不重新注册。
重新验证根导出 `@oh-my-pi/pi-natives.rasterizeSvg`：PNG 字节、系统字体中文、
调色板/RGB 与属性、16,777,216 像素限制，以及真实 `read` 的 image 块。
同一 Live 会话切换明暗主题，检查 Frozen 外观不变、Live 描边光标与 Frozen
无光标，以及并发读取的私有 PNG 路径。
成功截图与日志一样依赖系统临时文件清理，因为宿主只接收路径，没有读取完成回调。
升级已运行的仅文本处理器需要重启一次 omp；最终版本之间的重载不需要。

通过真实 RPC 与交互宿主重新验证通知投递：每条 `unified-exec-notice` 必须排入一条
后续消息，无须额外用户提示就触发模型轮次。验证 monitor 的默认/自定义上限、合并、
过多提示、最后部分行、人工/模型终止、End/wake 合并、渲染后的提示符
与重绘，以及 ANSI/Tern 的默认工具卡片和消息样式保持一致。
用较短的 `remind_after_ms` 时，安静的 monitor 必须自行发出恰好一条 `monitor_silent` 通知，
送达的匹配必须重新开始计时。没有任何 monitor 时，真实的 whiptail/debconf 对话框（在 Debian 容器里经
`exec_command` 对改过的文件运行 `ucf --debconf-ok`）和 apt 的 `[Y/n]` 提示必须各排入一条触发轮次的
`input_wait` 通知；挂着的调用正在展示提示时则一条都没有。对生命周期，真实的 `read term://` 读取已返回的终端
必须把它标为已读（`list_sessions` 的 `lifecycle.read`），空闲的 agent 必须被即将回收通知和回收通知唤醒，
且这些终端的后台任务之后都已结束。

omp 升级后要重新验证判定门。`agent_end` 必须仍带 `willContinue` 和 `awaitingAsyncWork`，`session_stop` 必须仍在主 agent 最终停止时触发并带 `last_assistant_message`；`loadStopHost` 载入的函数必须存在且形状符合 `stop-gate.ts` 的解析；绑定的 AgentSession 必须仍暴露 `settings`、`modelRegistry.resolver`、`sessionId`、`sessionManager` 和 `agent.metadataForProvider`/`telemetry`。在真实 omp 中准备一个已返回、未读的后台终端：完成任务的最终答复不能触发任何通知轮次，并使该终端从 `list_sessions` 消失；留有未完成工作的答复必须送达一条合并的通知；长工具调用期间产生的通知只能在运行结束后到达；`stop: off` 必须丢弃生命周期通知而保留 monitor 通知；`judge`、`llm` 与 `todo` 在显式选择时都必须各自作出判定。

omp 升级后要重新验证 shell 桥接：`@oh-my-pi/pi-coding-agent/config/registry` 必须仍然导出 `lookup`，`lookup("shellPath").get(host.pi.settings)` 必须仍以字符串或 undefined 返回 omp 的有效设置。通过真实的交互式 omp 验证：`shellPath` overlay 优先于 `SHELL`，显式 `shell` 优先于两者；不存在的显式 `shell` 必须返回 `spawn … ENOENT` 且没有输出，而不是改用其他 shell（omp 自己会在启动时、扩展加载之前拒绝不存在的 `shellPath`）；之后的输入写入、kill 和列表必须沿用会话的 shell；默认 `workdir` 必须仍然跟随 omp 的 cwd。

omp 升级后要重新验证这些工具文本所依赖的设备文档呈现：在 `tools.xdevDocs: inline` 下，真实 `omp --mode rpc` 的 `get_state` system prompt 中，`## exec_command` 段的描述必须仍在 200 个字符处截断（`src/tools/xdev.ts` 的 `XDEV_EXTERNAL_DESCRIPTION_CAP`），截断前是结束 `session_id`/`exit_code` 那句话的完整词；`### Schema` 下的参数注释必须仍然完整内联；omp 必须仍然不读取 `promptSnippet`/`promptGuidelines`。上限一变，就要重写这段开头。

命令审批移植自
[`can1357/oh-my-pi@57b56631ee009098a78d9badf91afc3a48eef32e`](https://github.com/can1357/oh-my-pi/blob/57b56631ee009098a78d9badf91afc3a48eef32e/packages/coding-agent/src/tools/bash.ts)
的 `packages/coding-agent/src/tools/bash.ts`（内部规则辅助函数、
`BashTool.approval` / `formatApprovalDetails`）。差异是参数名 `cmd`、
显式的绑定会话 settings、注入的宿主辅助函数和带类型的边界解析；
保留规则顺序以及全部 compound/critical 分支。
POSIX shell 判据复制自 `packages/utils/src/procmgr.ts`。
factory 加载根导出 `AgentRegistry` / `CRITICAL_BASH_PATTERNS`、
`exec/settings` 的 `cfgBashPatterns` / `cfgBashAllowCompoundCommands`、
`tools/shell-tokenize` 的 `tokenizeShellSegments` /
`extractLiteralAndChainSegments`，以及 `tools/approval` 的 `truncateForPrompt`。
缺少导出就拒绝插件加载；同步审批不做 import。

omp 升级后，先对照当前内置函数检查移植，再在真实 omp 中分别关闭与开启复合审批，
逐项比较有序 first-match、整链限制、全部段 allow、deny/prompt/critical 优先级和显示截断。
重新验证内部会话接口：注册表在 `session_start` 前完成注册、`ctx.agent.id`、
精确的 `sessionManager` 身份、实时 `session.settings` 和 `getShellConfig().shell`；
switch/branch 必须沿用同一会话而不查注册表。创建带不同 settings overlay 的真实子 agent，
以及使用私有注册表的 Unbound 子会话，确认 pending/Unbound 不读 settings 且返回裸 `exec`。
确认宿主工具代理和本插件的呈现 spread 保留 `approval` 与 `formatApprovalDetails`，
deny 不启动进程，真实 TUI 确认框显示危险原因与 `Command: …`。
只有审批使用此绑定；PTY shell 选择保持已有宿主桥接。

跟随宿主的 shell 选择同样是要长期保留的 fork 定制。

包改名、fork README、仅 omp 的宿主准入、原生 Bun PTY 后端、仅 PTY 的 `exec_command`、omp 呈现和 Tern 终端 HUD 是要长期保留的 fork 定制。omp 升级后要重新验证 omp 呈现：`toolRenderers.bash` 必须仍然暴露 `renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`，并接受 `{command, cwd}` 参数和 `{exitCode, wallTimeMs, async}` details。也要重新验证 Tern HUD：`@oh-my-pi/pi-tui/native/state` 必须仍然导出 `isNativeRendering`/`onNativeRenderingChange`；`@oh-my-pi/pi-coding-agent/modes/interactive-mode` 必须仍然导出 `InteractiveMode`，其原型的 `describeHudPills` 返回一个 `omp.hud` 行，里面最多一个 `omp.hud.pill` 行（为空时 `hidden`），实例仍有 `ui.requestRender`；omp 的 dock 必须仍在每个原生帧描述这一行，把节点子数组里的组件就地描述（不包额外元素）并把事件路由给该组件的 `handleNativeEvent`；Tern 必须仍在同一药丸里相邻的 `omp.hud.seg` 之间画分隔线。自定义 overlay 的 `nativeOverlay` role 和标题必须仍能到达 Tern 的 overlay 外框，`select`/`activate`/`action` 事件和 `handleInput` 按键仍到达组件，视图的 action id（`unified-exec.terminal.open`、`kill`、`close`、`back`）不能是 Tern 自己的 action（0.9.5 自行处理 `open`、`copy` 和 `zoom`，没有 `href`/`path` 的按钮发 `open` 时点击无效）；Tern 必须仍把 Background jobs 布局限定在 `.sf-overlay[data-role='omp.overlay.jobs']` 之下，使用 `omp.jobs.*` 内部 role（split、master、detail、status、state、age、id、command、facts、out、label、output、nooutput、summary、empty），且不在这些 role 上绑定行为，并把 `omp.overlay.console` 画成全 pane overlay。在 Tern 中，`full` overlay 的 `ansi` 必须仍能在 `grow` 和小数 `max.h` 下填满操作栏之外的高度，并在自身内部滚动；role 为 `omp.jobs.output` 的 `ansi` 必须保留颜色，并在 `max.h: "16lines"` 内跟随最新行。omp 升级后，包安装校验必须仍 await 扩展工厂并传播它的拒绝；为移除旧插件，Tern 的 `plugin list --json`（`plugins[].id`）、`remove ID --json`、确切的 `is linked; use unlink` 回答和 `unlink ID --json` 必须保持其契约，每条命令的超时是 75 秒，覆盖 Tern 60 秒的重载等待。在真实的 Tern 窗口里检查它（`tern --control`；插件只在窗口里加载，不在 `tern serve` 里），使用所有者的设置、隔离的 `TERN_CONFIG_DIR` 和 `TERN_DAEMON_SOCKET`，带一个运行中的轮次、一个后台 agent 和一个后台 bash job，尺寸为 1100×850 和 700px 宽，在 Reader、Spine 和 Console 中切换亮色和暗色外观（`palette "Dark appearance"`；`theme dark NAME` 只选暗色主题），分别在无 Tern 插件和装有 omp-todo-more 扩展与 Tern 插件两种配置下。终端分段必须是 omp 唯一 `omp.hud.pill` 里最后一个 `omp.hud.seg`，高度和字体与 agents、jobs 分段相同，左侧画出 Tern 的分段分隔线（Tern 在某些亚像素交界位置不画这条 1px 线，原生交界也一样；先把交界 x 坐标与只有原生分段时对照，再判断是否是分段的问题），且没有第二个 `omp.hud` 行。Terminals 视图的卡片、左侧列表和详情宽度与布局必须与同一窗口里原生的 Background jobs 视图一致，并能通过点击和 ↑/↓ 选择会话。Kill 和 `x` 必须只在确认退出后结束选中的运行中会话；Open / Enter 必须以会话的完整宽度显示全 pane 终端页，模型观察之后保留的历史仍可滚动，键入能到达运行中的 `cat`。Esc / Back 必须回到视图；Close 和 Esc 必须让进程继续运行，输入框保持可用。移除最后一个会话会让分段消失；再启动一个会话会立即重新出现。装有旧插件的 Tern 配置在加载后不再列出 `omp-unified-exec`。
