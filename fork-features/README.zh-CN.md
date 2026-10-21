# omp-unified-exec fork

[English](README.md) | 简体中文

本仓库是 [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec) 面向 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）的 fork。omp 在 2026 年初从 Pi 分叉，通过一个只覆盖 Pi 部分新 API 的兼容层加载 Pi 包，所以上游的新版本可能在 omp 上无法加载。

安装：`omp install https://github.com/oh-my-omp/omp-unified-exec`。请先卸载已有的 `pi-unified-exec`（`omp plugin uninstall pi-unified-exec`）：两者都注册 `exec_command` 和其他 unified-exec 工具。

## 定制

| 改动 | 文件 | 原因 | 上游 |
|---|---|---|---|
| 包名 `omp-unified-exec` | `package.json`（`name`、`repository`、`homepage`） | omp 以包名命名插件 | 仅 fork |
| 为 fork 重写的中英文 README：omp 安装、Tern 终端 HUD、omp 呈现、fork 结构；移除上游的 npm、徽章和维护公告 | `README.md`、`README.zh-CN.md` | fork 的行为和安装方式已经偏离上游 README（npm 包、仅 Pi 的呈现），继续沿用会误导 omp 用户 | 仅 fork |
| 紧凑 codemode 修复：从模块命名空间读取 `createCodemodeExtension`，宿主没有它时保持关闭 | `src/codemode-render.ts`、`tests/codemode-render.test.ts` | 从 0.12.1 起，具名导入 Pi 的 codemode 工厂在没有 codemode 的 omp 上链接失败，导致整个包无法通过插件校验 | 仅 fork |
| 原生 Bun PTY 后端，Node 下延迟回退 | `src/pty.ts`、`tests/bun-pty-runtime.mjs`、`.github/workflows/ci.yml` | omp 是 `bun build --compile` 生成的可执行文件，并阻止依赖的生命周期脚本，所以 Node ABI 预编译包无法可靠地提供 PTY。Bun 1.4 的 `Bun.Terminal` 在 Linux/macOS 上提供 `openpty`，在 Windows 上提供 ConPTY；普通 Node 宿主保留钉住版本的 @homebridge 后端。 | 仅 fork |
| omp 呈现：exec_command、write_stdin 和 kill_session 通过 omp 的 bash 渲染器渲染；其他工具使用 omp 的默认卡片 | `fork-features/omp-presentation.ts`、`fork-features/omp-tools.d.ts`、`tests/omp-presentation.test.ts`；`src/index.ts` 中的 `withHostPresentation`；`src/render.ts` 导出的 `base64ByteLength`/`stringifyChars`；`package.json` `files` 和 `tsconfig.json` 中的 `fork-features` | omp 以 `renderCall(args, options, theme)` / `renderResult(result, options, theme, args)` 调用扩展渲染器，Tern 读取 `describeCall`/`describeResult`；Pi 的渲染器每次重绘都会抛错，omp 于是显示原始的模型信封。omp 由它注入的 `ExtensionAPI.arktype` 识别；bash 渲染器来自 `@oh-my-pi/pi-tui/tools` 的 `toolRenderers.bash`，缺少这项契约时 omp 让插件加载失败。Pi 上的激活方式不变。 | 仅 fork |
| Tern 终端 HUD：一个原生的运行中工作计数器（终端图标和已存储的会话数量），独占一行，位于 omp 计数器上方；点击打开 Terminals sheet，仿照 omp 的 Agents sheet（会话列表带状态点和 Size / PID / Time 列，选中会话的信息、日志链接和最新输出行作为预览，Kill、Close、Open）；Open 显示一个仿照 omp Console 的全 pane 终端页，键入的按键发送给会话 | `fork-features/tern-terminal-hud.ts`、`fork-features/tern-plugin/`、`fork-features/tern-plugin-install.ts`、`fork-features/omp-tools.d.ts`、`tests/tern-terminal-hud.test.ts`、`tests/tern-plugin-install.test.ts`；`src/terminal-screen.ts` 中的 `TerminalScreen.styledScreen`/`onChange`，`src/session.ts` 中的 `ExecSession.styledScreen`/`onScreenChange`，`src/session-store.ts` 中的 `SessionStore.subscribe`；`src/index.ts` 中的 `activate` 把存储和基于 `terminateSessionById` 的 kill 交给 `withHostPresentation`；`package.json` `files` 中的 `fork-features/tern-plugin` | 工具结果只显示该次调用返回时的会话屏幕（[#17](https://github.com/oh-my-omp/omp-unified-exec/issues/17)）。widget 通过 `ctx.ui.setWidget`（`belowEditor`）挂载，恰好在原生渲染生效且存有会话时存在，包括已自然退出但尚未移除的会话；没有外层关闭动作，也没有隐藏的生命周期。它的行使用 `omp.hud`，带 `omp.hud.pill` / `omp.hud.seg`，所以外观以及 Reader、Spine、Console 的几何布局都由 Tern 负责。纯 CSS 插件把共享的 belowEditor 容器移到 omp 计数器上方，并清除它的 margin、padding、背景和阴影；同处的其他 widget 共享这一位置和重置。它还把预览的 `code` 输出（`unified-exec.terminals.tail`）设为等宽字体。被 await 的 omp 工厂在安装/强制校验和普通加载时同步一份正常的 Tern 副本；它校验全部三个文件和 ready 目录，通过 Tern 的 CLI 自动迁移已确认的旧 `.path` 链接，可用的 Tern 无法同步时让加载失败。不再有会话开始时的安装或开发链接。没有该插件时，pill 位于输入框下方。sheet 响应 `nativeSheet` 并使用模态 `picker`；终端页声明 `full` `nativeOverlay`，显示来自保留历史和当前屏幕的彩色、可滚动 `ansi`（[#19](https://github.com/oh-my-omp/omp-unified-exec/issues/19)）。只有终端页的键入和 sheet/终端页的 Kill 会作用于会话；模型可见的结果仍是纯文本。 | 仅 fork |
| 进程内唯一的终端资源与 `read term://` | `fork-features/terminal-resource.ts`、`fork-features/terminal-url.ts`、`src/terminal-screen.ts`、`src/session.ts`、`src/session-store.ts`、`src/tool-result.ts`、`src/script-result.ts`、`src/index.ts`；在 `omp-presentation.ts` 初始化 | omp 的 `@oh-my-pi/pi-coding-agent/internal-urls` 提供进程级单例 `InternalUrlRouter.instance().register(handler)`。唯一的 `term` 处理器读取 `Symbol.for` 共享索引，带 UUID 后缀的键隔离不同激活与重载。物理行投影不消费输出；会话在输出关闭且解析完毕时冻结。冻结的行与活动屏样式单元格副本保留到进程结束；关闭时只丢弃自身尚未冻结的活动资源。 | 仅 fork |
| 经 `read term://…/screen.png` 读取终端截图 | `fork-features/terminal-image.ts`、`fork-features/terminal-url.ts`、`fork-features/omp-tools.d.ts` | 宿主 `@oh-my-pi/pi-natives` 根导出的 `rasterizeSvg(Uint8Array, maxWidthPx, maxHeightPx)` 使用系统字体栅格化 SVG，无需安装脚本。file 型 scheme 的 `locate()` 把私有 PNG 交给生产 `read`；文本路径返回 null，仍正常 resolve。只有模拟器复制的单元格进入 SVG。Live 外观/光标和 Frozen 外观/无光标共用 K1 投影。 | 仅 fork |
| 后续输出 monitor 与多次后续唤醒 | `fork-features/monitor-subscription.ts`、`src/completion.ts`、`src/session.ts`、`src/terminal-screen.ts`、`src/index.ts`、`src/script-result.ts`、`tests/monitor.test.ts` | 源头建立不消费输出的后续观察边界；完成协调器拥有实际订阅，并合并 End 与普通唤醒。现有 `pi.sendMessage` 接口以 `display:true`、`triggerTurn:true`、`deliverAs:"followUp"` 投递 `unified-exec-monitor`；工具和消息都沿用宿主默认呈现。 | 仅 fork |
| 仅 PTY 的 `exec_command`：每个会话都在 PTY 中运行；删除管道后端、`tty` 参数与结果字段、1 MiB 内存保留及其省略标记、管道 monitor 解码，以及移除宿主 `bash` 的参数。宿主的 `bash` 保持激活，负责短的一次性命令；`write_stdin` 原样写入字节；PowerShell 以 `-NoProfile -NoLogo -Command` 运行 | `src/pty.ts`、`src/session.ts`、`src/collect.ts`、`src/long-wait.ts`、`src/output-safety.ts`、`src/index.ts`、`src/shell.ts`、`src/tool-result.ts`、`src/script-result.ts`、`src/render.ts`、`src/terminal-screen.ts`、`fork-features/monitor-subscription.ts`、`fork-features/terminal-resource.ts`、`fork-features/tern-terminal-hud.ts`、`fork-features/omp-presentation.ts` | 非 PTY 会话是一个 stdin 永远见不到 EOF 的 shell：读 stdin 的程序（`cat`、`head`、无参数的 `python`、PowerShell `-Command`）会一直等待，而且这种模式与宿主 `bash` 重复，却缺少宿主的审批、direnv、Git Guard、自动后台与输出整形（[#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)）。PTY 把输出折叠为固定大小的屏幕，每次读取都有上界，因此不需要命令截止时间；程序按行刷新，monitor 能及时匹配；`\x03` 经行规程作用于前台进程组。没有 PTY 后端时，`exec_command` 在调用时报错并给出加载原因。退出的进程不会被重启。 | 仅 fork |

环境变量（`PI_UNIFIED_EXEC_*`）和原有工具名保持不变，源码结构除已删除的管道后端外沿用上游路径，所以导入其余 `src/*` 模块的其他 omp 插件在路径从 `node_modules/pi-unified-exec` 变为 `node_modules/omp-unified-exec` 后仍能工作。

## 仓库状态

- `Publish to npm` 和 `Interaction limit reminder` 已用 `gh workflow disable` 禁用：fork 不向 npm 发布任何内容，提醒跟踪的是上游自己的互动限制。这是仓库状态，所以把 workflow 文件同步回来也不会重新启用它们。
- `Sync upstream`（`.github/workflows/sync-upstream.yml`）每天通过以 `CI` 为门禁的 PR 把 `upstream/main` 合并进 `main`。

## 预期的同步冲突

`name` 紧挨着 `version` 那一行，git 把相邻行的修改视为冲突。上游每次发布都会改 `version`，所以它的同步会以待审 PR 的形式到来。解决方法：保留 `"name": "omp-unified-exec"`，采用上游的 `version`。

本仓库的 `exec_command` 只用 PTY（[#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)）：管道后端（`spawnPipes`、codex 首尾缓冲区的移植、`collectOutputUntilDeadline`、流式 `OutputTextSanitizer` 和管道 monitor 解码）、`tty` 参数与结果字段，以及移除宿主 `bash` 的参数都已删除，PowerShell 以 `-NoProfile -NoLogo -Command` 运行。上游对这些代码的改动会以 modify/delete 或内容冲突的形式到来。解决方法：保留删除，只把对 PTY 会话仍然成立的事实（shell 选择、信号、Windows 进程树、结果字段）搬进 PTY 代码；不要恢复管道路径、`tty` 参数、该参数或只为管道存在的 PowerShell 参数。

上游 v0.13 的 steer gate（`src/steer-gate.ts`、`wait_status: "interrupted_by_steer"`、`PI_UNIFIED_EXEC_STEER_INTERRUPT`；上游 `d393051`、`f5e5d96`、`1baa416`）不采用，以 `ours` 策略合并（[PR #1](https://github.com/oh-my-omp/omp-unified-exec/pull/1)）。它监听 Pi 的 `input` 事件来提前结束附着等待，主要针对空 `write_stdin` 轮询；本 fork 面向 omp，其扩展上下文没有 steering 信号，空轮询由 `read term://` 与 `monitor` 取代（[#44](https://github.com/oh-my-omp/omp-unified-exec/issues/44)）。上游对 steer gate 的改动会以 modify/delete 冲突的形式到来，保留删除。

`README.md` 和 `README.zh-CN.md` 归 fork 所有。同步改动到 README 时，保留 fork 的版本，只把在这里仍然成立的上游事实（工具参数、限制、语义）写进两个文件中 fork 对应的章节；两者保持逐节互译，`fork-features/README.md` 和 `fork-features/README.zh-CN.md` 也一样。

omp 升级后，要重新验证 `@oh-my-pi/pi-coding-agent/internal-urls`：
`InternalUrlRouter.instance().register(handler)` 必须与生产 `read` 共用路由；
`getHandler("term")` 必须返回同一个可变对象，每次请求读取其 spec 与方法。
最终处理器使用 `{backing: "file", selectors: "lines", immutable: false}`：
`locate()` 仅为 `/screen.png` 返回文件路径，文本路径返回 null。
通过真实 `read` 验证全部保留行、`/screen`、正负页码、head/tail、
未知键与越界错误；确认子 agent 的同号键不混淆，退出、终止、LRU 后仍可读，
两次重载后旧 URL 仍可读，既不消费观察状态也不重新注册。
重新验证根导出 `@oh-my-pi/pi-natives.rasterizeSvg`：PNG 字节、系统字体中文、
调色板/RGB 与属性、16,777,216 像素限制，以及真实 `read` 的 image 块。
同一 Live 会话切换明暗主题，检查 Frozen 外观不变、Live 描边光标与 Frozen
无光标，以及并发读取的私有 PNG 路径。
成功截图与日志一样依赖系统临时文件清理，因为宿主只接收路径，没有读取完成回调。
升级已运行的仅文本处理器需要重启一次 omp；最终版本之间的重载不需要。

通过真实 RPC 与交互宿主重新验证 monitor 投递：每次成功返回必须排入一条
后续消息，无须额外用户提示就触发模型轮次。验证默认/自定义上限、合并、
过多提示、最后部分行、人工/模型终止、End/wake 合并、渲染后的提示符
与重绘，以及 ANSI/Tern 的默认工具卡片和消息样式保持一致。


包改名、fork README、codemode 宿主保护、原生 Bun PTY 后端、仅 PTY 的 `exec_command`、omp 呈现和 Tern 终端 HUD 是要长期保留的 fork 定制。omp 升级后要重新验证 omp 呈现：`toolRenderers.bash` 必须仍然暴露 `renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`，并接受 `{command, cwd}` 参数和 `{exitCode, wallTimeMs, async}` details。也要重新验证 Tern HUD：`@oh-my-pi/pi-tui/native/state` 必须仍然导出 `isNativeRendering`/`onNativeRenderingChange`；widget 组件的 `describe` 必须仍能到达 Tern，`belowEditor` widget 必须仍然没有间隔，pill 的 `open` 动作必须仍能到达 widget 的 `handleNativeEvent`；响应 `nativeSheet` 的自定义 overlay 组件必须仍被挂载为它的 `picker` sheet，并收到 `select`/`activate`/`action` 事件；带 `full` `nativeOverlay` 的自定义 overlay 必须仍被画成全 pane sheet，且其 `handleInput` 收到键入；omp 的计数器必须仍使用 `omp.hud` / `omp.hud.pill` / `omp.hud.seg`。omp 或 Tern 升级后，Tern 插件的选择器必须仍然成立：共享的 `belowEditor` 容器是 dock 的最后一个 `.sf-col.gap-none` 子元素，空容器保持零尺寸且从不选中编辑器，原生 HUD 规则在 Reader、Spine 和 Console 中都匹配嵌套的终端行。`code` 节点的 role 必须仍能到达带 `.sf-code-lines` 的元素。在 Tern 中，`full` sheet 的 `ansi` 必须仍能在 `grow` 和小数 `max.h` 下填满操作栏之外的高度，并在自身内部滚动。omp 升级后，包安装校验必须仍在物化包资源之后 await 扩展工厂，并在报告成功前传播它的拒绝。普通加载使用同一个初始化函数；`session_start` 没有安装 IO。只通过 `omp plugin install URL --force` 重新验证缺失/过时的副本、同版本的资源更新、完全一致的未变副本和旧的 `.path` 注册，并在任何会话之前检查 Tern 的副本。Tern 的 `plugin dir --json`、`list --json`（`id`、`version`、`css`、`status`）、`install DIR --force --json`（`id`、`version`、绝对路径 `dir`）和 `unlink ID --json` 必须保持其契约。unlink 之前必须有精确的已链接目标冲突，加上匹配的规范注册和新的目录；无关的失败绝不能删除注册。每条命令的超时是 75 秒，覆盖 Tern 60 秒的重载等待。没有守护进程时，副本仍须安装，供下次启动使用。缺少 Tern 时跳过初始化；Tern 可用但失败时，拒绝安装校验和普通加载。在真实的 Tern 窗口里检查它（`tern --control`；插件只在窗口里加载，不在 `tern serve` 里），使用所有者的设置，带一个运行中的轮次、todos 和一个后台 agent，尺寸为 1280×800 和 700px 宽，在 Reader、Spine 和 Console 中，并在同一个活动会话里切换亮色和暗色主题。比较两个计数器的行和 pill 矩形（右边缘相差不超过 1px）、字体、高度、圆角、边框和悬停效果；在 pane 聚焦和未聚焦时检查 Spine。没有会话或其他 widget 时，每个输入框、计量条和活动/todo 矩形都必须与无插件运行时一致，空容器不占高度。有会话时，终端计数器只有图标和数量，没有外层 ✕、额外的底部间距或 Spine 容器底板。Terminals sheet 必须像 Agents sheet 一样打开，并能通过点击和 ↑/↓ 选择会话。Kill 和 `x` 必须只在确认退出后结束选中的运行中会话；Open / Enter 必须以会话的完整宽度显示全 pane 终端页，模型观察之后保留的历史仍可滚动，键入能到达运行中的 `cat`。Esc / Back 必须回到 sheet；Close 和 Esc 必须让进程继续运行，输入框保持可用。移除最后一个会话会卸载计数器；再启动一个会话会立即重新挂载它。
