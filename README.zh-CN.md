# omp-unified-exec

[English](README.md) | 简体中文

为 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）提供长时间运行的终端
会话，并在 Tern 里带一个终端 HUD。宿主的 `bash` 负责短的一次性命令；长命令、交互程序（REPL、TUI、`ssh`、`sudo`）、并发计算和开发期 daemon 交给 `exec_command`，它把每条命令放进一个 PTY 会话，由模型通过写入和轮询来驱动，而不是一次阻塞到底的调用。会话在多轮对话之间持续运行，没有命令截止时间，人也可以在 Tern 里查看它们、向它们输入。

本仓库 fork 自 [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec)，后者是 codex `unified_exec` 的 Pi 移植。原有工具（`exec_command`、`write_stdin`、`set_on_exit`、`kill_session`、`list_sessions`）保留其会话模型；fork 让每个会话都在 PTY 中运行，把短命令留给宿主的 `bash`，并为 omp 增加终端读取/截图和 `monitor`。fork 的全部改动、每项改动的原因，以及 omp/Tern 升级后如何重新验证，见 [fork-features/README.zh-CN.md](fork-features/README.zh-CN.md)。

## 安装

```bash
omp install https://github.com/oh-my-omp/omp-unified-exec
```

请先卸载已有的 `pi-unified-exec`（`omp plugin uninstall pi-unified-exec`）：两者注册的是同一组工具。本 fork 不向 npm 发布任何内容。

当 PATH 中存在 `tern` 时，omp 也会把附带的 Tern 插件正常安装为副本。更新时执行同一安装命令并加上 `--force`：

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

Tern 更新会在这条命令成功返回前完成，无需单独执行 Tern 命令，也不使用开发链接。

本包在 Pi 上照常加载（使用 Pi 的渲染器，没有 HUD）。每个会话都在 PTY 中运行：Bun 1.4+ 下使用 Bun 原生的 `Bun.Terminal`（omp 是编译后的 Bun 可执行文件），Node 下使用可选依赖 `@homebridge/node-pty-prebuilt-multiarch`。两者都没有时，`exec_command` 在调用时报错并给出加载原因，会话开始时显示一条警告；宿主的 `bash` 照常可用。

## 功能

- **会话，而不是调用。** `exec_command` 在 PTY 中启动进程，在等待窗口内返回已有输出和一个 `session_id`；之后的轮次里，`write_stdin` 把字节原样写给它（文本、`\x03` Ctrl-C、方向键），或轮询它。取消调用永远不会杀掉进程。没有命令截止时间，退出的进程也不会被重启。
- **输出就是终端上看到的内容。** 每个会话都经过无头终端模拟器。运行中的结果返回当前屏幕、自上次调用以来滚出的未见历史与光标位置，而不是叠加每次重绘；退出结果只返回最终活动屏，其余保留行通过 `terminal_url` 读取。模拟器会像真实终端一样回应光标位置、设备属性与默认颜色查询，因此等待回应或选择配色的程序表现与真实终端一致。
- **输出有上限，完整内容可找回。** 模型看到的每个结果都从尾部截取，最多 50 KiB / 2000 行，并去掉终端控制序列；每个会话的完整原始输出都写入 `log_path`。
- **可选的完成唤醒。** `on_exit: "wake"` 让后台进程在无人观察时退出后唤醒一次 agent；`set_on_exit` 可以取消。
- **等待匹配输出。** `monitor` 不消费输出地观察已有会话，在匹配批次或结束时唤醒模型；默认最多成功返回十次匹配消息。
- **omp 原生呈现。** `exec_command`、`write_stdin` 和 `kill_session` 用 omp 自己的 bash 卡片渲染（命令行、输出、退出码标签、错误配色），在 ANSI TUI 和 Tern 里都是如此。
- **Tern 里的终端 HUD。** 不用调用工具，就能查看、回滚、输入并结束模型的会话。

<a id="tern-hud"></a>

## Tern 终端 HUD

当 omp 在 Tern 里原生渲染、并且存在会话时：

- **计数按钮。** 一个终端图标加存储中的会话数，单独一行放在 omp 计数器正上方。整行、药丸和分段使用 Tern 原生 HUD 样式，跟随 Reader、Spine、Console 和配色主题。没有外层隐藏按钮；最后一个会话被移除后，计数按钮自动卸载。
- **Terminals 面板。** 点击计数按钮打开一个仿照 omp Agents 面板的面板：每个会话一行，带状态点、尺寸、PID 和运行时长；选中会话的命令、状态、目录、PID、尺寸、启动时间、可点击的日志路径和最新几行输出作为预览。↑/↓ 或点击选择会话，`x` / Kill 按 `kill_session` 的方式结束它，Esc / Close 关闭面板。
- **终端页。** Enter / Open 把会话打开成一个仿照 omp Console 的全屏页：显示保留的历史和当前屏幕，带颜色、按会话自身宽度显示，跟随新输出，并可向上回滚。键入的按键会发给会话（与 `write_stdin` 的写法相同，模型能看到效果）；Esc / Back 返回面板；Kill 结束会话。

HUD 直接读取会话，不保存任何副本。它只在 omp 原生渲染时存在，因此 omp 的 ANSI TUI 不会多出一行。工具结果仍是纯文本；显式 `read term://…/screen.png` 请求返回图像。

**Tern 插件。** omp 扩展无法往 omp 的计数器那一行里加东西，所以本包附带一个只含 CSS 的 Tern 插件（`fork-features/tern-plugin/`）。它把共享的 `belowEditor` widget 容器移到 omp 计数器上方，清除容器的间距、背景和阴影，避免与原生 HUD 边距重复叠加。同一容器中的其他 widget 也共享这个位置和重置；插件不重设药丸外观或 omp 的输入框，并让面板的输出预览使用等宽字体。

omp 等待扩展 factory 完成，因此插件在包安装校验（包括 `install --force`）和普通扩展加载期间同步。它向 Tern 查询插件目录及 catalog；只有三个文件完全一致的正常副本，且版本、样式表和 ready 状态都匹配时，才不改动。缺失或旧文件通过 `tern plugin install <包内目录> --force` 更新。已确认的旧 `.path` 注册由 Tern 自己的 unlink 和正常副本安装自动迁移，不创建开发链接。

CLI 继承 omp 的环境，由 Tern 决定目标目录并负责重新加载。daemon 未运行时，Tern 安装副本供下次启动使用。没有 `tern` 可执行文件不影响非 Tern 使用；如果 Tern 存在但同步失败，包校验或普通扩展加载会失败并报告命令诊断，不延迟到 session-start 重试，也不显示成功 toast。如果 omp 随后保存包配置失败，已经完成的外部 Tern 更新不会一起回滚。没有插件时，计数按钮显示在输入框下方。

设计、决策和 Tern 实测记录：
[docs/IV-0002-output-lifecycle-and-rendering.md](docs/IV-0002-output-lifecycle-and-rendering.md)。

## 工具

### `exec_command`

在一个持久的 PTY 会话里运行命令。用于长命令、交互程序（REPL、TUI、`ssh`、`sudo`）、并发计算和开发期 daemon；短的一次性命令用宿主的 `bash`。没有命令截止时间，退出的进程也不会被重启。用 `write_stdin` 轮询、`monitor` 和 `read term://…` 观察会话；输出是渲染后的终端屏幕（见[终端输出](#terminal-output)）。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cmd` | string | — | Shell 命令。必填。 |
| `workdir` | string | 当前轮次的 cwd | 工作目录。 |
| `shell` | string | `bash` | Shell 程序。Windows 上找得到 `bash` 就用它，否则用 `powershell`。`cmd` / `powershell` / `pwsh` 会带上各自对应的参数。 |
| `cols` | number | `120` | PTY 宽度。限制在 [20, 500]。 |
| `rows` | number | `80` | PTY 高度。限制在 [5, 300]。 |
| `yield_time_ms` | number | `10_000` | 本次调用保持连接、等待输出的时长（不是命令的生命期），限制在 [250, 30_000]。 |
| `on_exit` | `"none"` \| `"wake"` | `"none"` | 无人观察时进程退出的处理策略。`"wake"`：发一条后续提示唤醒 agent——仅在人明确希望自动恢复时使用。之后可用 `set_on_exit` 修改。 |

响应体（运行中、输出较短、未截断时）：

```
[still running]                     (or [exited])
session_id: 1                       (mutually exclusive with exit_code)
exit_code: 0                        (mutually exclusive with session_id)
signal: SIGTERM                     (optional, if killed)
log_path: /tmp/pi-unified-exec-1-5cc5e104.log
terminal_url: term://1-9f2c1a7e-…
cwd: /home/you/project
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
output_bytes_total: 148            (cumulative bytes since spawn — compare across polls to detect stalls)
terminal: normal screen 120x80, cursor row 4 col 5
history_lines: 2                   (running, optional: lines scrolled off above the screen since the last call)
---
<history lines not yet reported>
<the full current screen, trailing blank rows removed>
```

输出超过上限（50 KiB / 2000 行）时，末尾会附上一行说明：

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/pi-unified-exec-1-5cc5e104.log]
```

<a id="terminal-output"></a>

#### 终端输出

每个会话把子进程写出的每个字节按顺序送进一个尺寸为会话 `cols`×`rows` 的无头终端模拟器（[`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)），每次结果报告的是这个终端显示的内容，而不是原始输出流。因此每次读取都受屏幕尺寸约束；原始输出流只写入 `log_path`。

- **运行中历史加屏幕。** 先给出自上次调用以来从顶部滚出、且尚未报告过的行，再给出完整的当前屏幕。回车刷新的进度条和重绘只显示最终状态。
- **运行中屏幕未变。** 屏幕、光标和历史都没变化时，结果带 `screen_changed: false` 和 `(no output)`。
- **退出只返回一屏。** 每一种退出结果（包括短命令和确认终止）都返回冻结的最终活动屏，即使屏幕没有变化。`terminal_url` 保留在结果根层；`terminal.retained_rows`、`terminal.rows` 与 `terminal.history_may_be_truncated` 描述正常屏的保留投影，最终元数据不含 `screen_changed` 或 `history_lines`。结果仍受 50 KiB / 2000 行上限约束；通过 URL 的 `/screen` 读取完整屏幕，通过 `/page/N` 读取更早的保留行。
- **全屏程序**（备用屏幕，比如 `top`、编辑器）报告为 `terminal: alternate screen …`；退出后恢复普通屏幕。
- **工具结果只有纯文本和光标。** exec/write/kill 文本里没有颜色；Tern 的终端页和显式 `read term://…/screen.png` 会显示颜色。
- **终端查询会被回应**，回应写到子进程的输入上：光标位置、设备属性，以及默认前景色/背景色（OSC 10/11）。在 omp 上颜色跟随 omp 的主题（浅色或深色，在 Tern 里跟随 Tern 的外观）；在 Pi 上为深色。
- 两次调用之间的历史受单元格预算限制（`TERMINAL_HISTORY_CELLS` 除以 `cols` 得到行数）。在被报告之前就超出预算的行会使结果带上 `history_may_be_truncated: true`；这些行只存在于日志中。

#### 在 omp 中读取保留终端

结果与 `list_sessions` 带有进程内唯一的 `terminal_url`，例如
`term://3-9f2c1a7e-…`。正常屏的保留历史与屏幕可以独立于结果消费来读取：

| 读取路径 | 内容 |
|---|---|
| `term://<key>` | 全部保留的正常屏物理行，去掉行尾空格与末尾空行。 |
| `term://<key>/screen` | 当前活动屏，包括正在使用的备用屏。 |
| `term://<key>/screen.png` | 完整活动网格的图像，带单元格颜色与属性。 |
| `term://<key>/page/2` | 保留行的第二页，每页是会话的 `rows` 行。 |
| `term://<key>/page/-1` | 最后一页；负页码从末尾计数。 |
| `term://<key>:raw:1-2` / `term://<key>:raw:-3` | 使用 `read` 现有的 head/tail 选择器，raw 模式不附上下文行。 |

读取不会消费输出、推进观察标记或移除会话。页码越界时报告总页数；
未知键返回 `unknown_terminal`。启动失败的会话没有终端资源。

输出关闭且全部已接收字节解析完毕后，会话冻结物理行、活动屏的样式单元格、
尺寸、光标与当时的外观。同一 URL 在短命令结束、自然退出、确认终止或 LRU
移除之后仍可读取，直到 omp 进程结束。冻结资源不会删除；插件关闭时不保证
保留尚未冻结的活动投影。子 agent 与扩展重载后的键互不混淆。

`read term://<key>/screen.png` 使用 omp 的图像管线，不要加 `:img`。
网格每格为 8×16 逻辑像素，使用系统等宽字体，宽字符跨两格。
Live 读取使用宿主当前外观并画出描边光标；Frozen 读取保留冻结时的外观，
不画光标。大型网格按同一比例缩小到原生栅格器的像素上限。
每次图像读取都在系统临时目录创建一个私有 PNG；它只是该时刻的副本，
不是缓存，与会话日志一样由系统清理。
从仅支持文本的终端处理器升级时需要重启一次 omp；之后扩展重载会保留
图像处理器与已有 URL。

### `write_stdin`

驱动或轮询一个已有会话。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 必填。 |
| `chars` | string | `""` | 为空表示纯轮询；非空时先把字节（经转义解码）原样写入、不追加任何内容，再轮询。与 `chars_b64` 互斥。 |
| `chars_b64` | string | `""` | 要写入的 Base64 编码字节，二进制安全。与 `chars` 互斥。 |
| `yield_time_ms` | number | 有输入时 `250`；空轮询 `5_000` | 连接等待窗口，不是进程超时。带输入的调用限制在 [250, 30_000]。空轮询最少 5_000，没有内置上限；毫秒小数部分向下取整。运维显式设置的上限会拒绝更长的相对轮询。与 `yield_until` 互斥。 |
| `yield_until` | string | — | **仅用于空轮询**的绝对 UTC 截止时间，严格的 RFC 3339 UTC 格式（`2026-07-21T18:30:00Z` 或带 `.mmm`；大写 `Z`；必须是真实存在的日期）。**仅在人明确要求**长时间等待时使用。进程退出、调用取消或到达截止时间时返回；已过去的截止时间等同于立即轮询。与 `yield_time_ms` 及输入字节互斥。 |

#### 等待长时间运行的命令

1. 根据预期的任务时长使用有限的 `yield_time_ms`，或使用 `monitor`（不带条件时在输出关闭后唤醒模型）。空轮询默认五秒，没有内置上限。等待到期永远不会杀掉进程。
2. **仅在人明确要求**对**有限、非交互**的命令长时间等待或设定挂钟截止时间时，才用 `yield_until`，并根据 `tool_time_utc` 计算。**绝不要**用于 REPL、`sudo`、`ssh`、密码提示、开发服务器、文件监听或调试器。
3. `on_exit` 默认 `"none"`。只有人明确希望自动恢复时才用 `"wake"`；`set_on_exit(session_id, on_exit: "none")` 可在不杀进程的情况下取消。
4. 被工具结果直接观察到的退出会消耗掉唤醒；到期或取消则保留唤醒。

两种空轮询使用同一套基于单调时钟的事件驱动等待。输出保存在会话的终端屏幕里，因此等待不会累积输出；日志始终收到原始输出。流式更新由输出驱动（短轮询每秒最多四次，长等待和绝对等待每 30 秒最多一次），安静时没有心跳。等待期间的缓存预热由宿主负责，与本包无关。原始日志在磁盘上不设上限；归档配额是[后续工作](docs/IV-0002-output-lifecycle-and-rendering.md#output-archive-safety)。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` | 未设置，无上限 | 可选的空相对轮询上限。小于 `5_000` 的值按 `5_000` 处理；无效值会让轮询失败，而不是取消上限。不影响 `yield_until`。 |

#### `chars` 里的控制字节和转义

`chars` 在写入前按 C 风格转义字符串解码。

| 转义 | 结果 |
|---|---|
| `\\n` `\\r` `\\t` `\\b` `\\f` `\\v` | LF CR TAB BS FF VT |
| `\\0` | NUL (0x00) |
| `\\a` | BEL (0x07) |
| `\\e` | ESC (0x1B) |
| `\\xHH`（2 位十六进制） | 单个字节 |
| `\\uHHHH`（4 位十六进制） | Unicode 字符 |
| `\\u{H…H}`（1–6 位十六进制） | Unicode 码点 |
| `\\\\` `\\"` `\\'` | 字面量 `\` `"` `'` |
| 不在上表中的 `\\X` | 原样保留（两个字符） |
| 字符串里的原始字节 | 原样通过 |

```
write_stdin chars="\x03"          → Ctrl-C   (0x03)
write_stdin chars="\x04"          → Ctrl-D   (0x04)
write_stdin chars="\x1b:wq\n"     → ESC + ":wq" + LF     (vim save+quit)
write_stdin chars="\x1b[A"        → ESC + "[A"           (up arrow)
write_stdin chars="C:\\\\temp"    → "C:\\temp"           (must escape \)
write_stdin chars_b64="G3s6wgo="  → exact 5 decoded bytes
```

同时传 `chars` 和 `chars_b64`，或 base64 格式错误，都会拒绝调用。字节原样到达 PTY：不追加任何内容（没有 `\r` 或 `\n`），所以 ESC 和方向键单独发送。终端的行规程把 `\x03`（Ctrl-C）变成发给前台进程组的 SIGINT，把行首的 `\x04`（Ctrl-D）变成规范模式读取程序的文件结束；raw 模式的程序把两者都当作按键读取。提交一行请用 `\r`（回车）：它在所有平台都有效，而 `\n` 在旧版 Windows 控制台里不会执行这一行。

### `set_on_exit`

修改 `on_exit` 策略，**不杀进程**。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 必填。 |
| `on_exit` | `"none"` \| `"wake"` | — | `"none"` 取消待发的唤醒（会话被淘汰后留下的协调器墓碑记录同样适用）。`"wake"` 在会话仍在存储中运行时启用唤醒。 |

状态标记：`disarmed`、`already_none`、`armed`、`already_armed`、`too_late`；未知 id 返回 `found: false`。取消无法撤回已经排队交给宿主的后续提示。

### `on_exit: "wake"`——完成通知

> 终端的完成要么通过一个已定稿的工具结果送达，**要么**触发一条合成的模型提示——绝不会两者都有。

- 在 `write_stdin` 观察期间发生的退出由该调用返回，结果定稿时消耗唤醒。结果以错误或取消定稿时，唤醒仍然有效。
- 到期或被取消的调用保留唤醒；进程之后退出时，恰好发送一条后续提示（`deliverAs: "followUp"`，不会打断正在进行的轮次）。同时发生的多个完成会合并成一条提示。
- 提示只包含有限的元数据（会话 id、退出码/信号、命令、cwd、耗时、日志路径、失败信息）——绝不包含原始输出。
- `kill_session`、`/unified-exec-sessions` 命令、对存活进程的 LRU 淘汰以及 `session_shutdown` 都会取消唤醒；kill 失败则恢复唤醒。自然退出、尚未通知就被淘汰的唤醒会话会保留一条有上限的墓碑记录，唤醒仍会送达。

### `monitor`

订阅已有运行中会话的后续输出，不停止进程，也不消费普通观察。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 已有的运行中会话。 |
| `action` | `"start"` \| `"cancel"` | `"start"` | 建立/替换该会话唯一的订阅，或静默取消。 |
| `condition` | string | 不传 | JavaScript 正则源码（不带 `/` 分隔符）；不传则只在输出关闭时返回。 |
| `max_returns` | number | `10` | 正安全整数，计成功的匹配消息数，不是行数，也不含 End。 |

条件接收新增或改变的渲染逻辑行，包括没有换行的提示符；wrapped 物理行会合并。
每行经过清洗，并截取前 1024 个 UTF-16 code unit。纯光标/样式变化不触发，
也不会重放建立前的输出。

约 250 ms 内的匹配合并成一条 `unified-exec-monitor` 后续消息并唤醒模型。
每条最多展示 16 行、每行最多 1024 字符，带省略数、成功次数/上限及
会话的 `terminal_url` 与 `log_path`。60 秒内匹配超过 20 个时提示收窄条件，
但继续观察；最后一次允许的匹配注明上限，只结束 monitor，不结束进程。

实际输出关闭时发送 End，附尚未返回的匹配和退出码/信号；人工 HUD/slash
与 LRU 终止写明原因。End 合并已启用的普通完成唤醒。模型 `kill_session`、
显式取消、替换、reset 与关闭都静默结束，即使模型 kill 失败也是如此。
已排队交给宿主的后续消息无法撤回。未知/已结束会话、非法正则及非法上限
返回类型化错误。
Windows 上 node-pty 在进程结束后再等 1000 ms 尾部输出，输出关闭与退出约晚 1 s
才报告；因此退出前刚打印的匹配会先作为匹配消息发出，不并入 End。

### `kill_session`

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 必填。 |
| `signal` | string | `"SIGTERM"` | 2 秒后升级为 SIGKILL。`"SIGKILL"` 跳过等待。Windows 上任何信号都会强制结束进程树。 |

信号名会被规范化（`term`、`INT`、`sigkill` 都可以）；未知名称会被拒绝。结果使用与其他工具相同的有上限包装，带 `killed`、`escalated`、请求的/实际的信号和 `running`。kill 失败的会话保留在存储中，并报告 `running: true`。Tern HUD 的 Kill 走同一条路径。

### `list_sessions`

列出存活的会话，并把每个已退出的会话最后报告一次（带 `running: false`、`exit_code`/`signal` 和 `log_path`）后再移除。每条记录带 `wake_armed` 及活动 monitor 的条件/成功次数/上限；响应带 `tool_time_utc`，用于计算 `yield_until` 截止时间。

## 命令

- `/unified-exec-sessions`——在选择器里列出存活会话（已启用唤醒的显示 `[wake]`），不经过模型就能结束选中的会话或全部会话，同样是 SIGTERM → 2 秒 → SIGKILL。

## 呈现

**在 omp 上，**`exec_command`、`write_stdin` 和 `kill_session` 通过 omp 导出的 bash 渲染器渲染，ANSI TUI 和 Tern 都一样：`$ cmd`，可用 omp 的展开快捷键展开的折叠输出，失败时的退出码标签和错误配色，运行中会话显示 `Backgrounded: session N`，最后一行是带日志路径的截断标记。`write_stdin` 和 `kill_session` 以 bash 注释的形式显示所做的动作（`# poll session N`、`# stdin → session N: "…"`、`# kill session N (SIGTERM)`）。`monitor`、`set_on_exit` 和 `list_sessions` 使用 omp 的默认卡片。如果 omp 的 bash 渲染器缺失或接口变了，插件会直接加载失败，而不是显示原始的结果包装。

**在 Pi 上，**原有五个工具都有各自的渲染器，提供命令标题、默认显示五个可视行的输出尾部（用 `app.tools.expand` 展开）、实时计时、`⟳ poll` / `» input` 标题，以及 kill/list 摘要。有进程存活时，底栏显示 `unified-exec: N sessions running`。

两种宿主下，模型可见的内容和持久化的 details 相同。

## Codemode 脚本（Pi）

每个工具都声明了 `outputSchema` 并返回对应的 `structuredContent`，因此 Pi 的 codemode 脚本拿到的是对象：

```js
const r = await tools.exec_command({ cmd: "npm test", yield_time_ms: 30000 });
if (r.running) text(`still running as session ${r.session_id}`);
else text(`exit ${r.exit_code}`);
text(r.output); // print the output, not the whole object
```

结构定义在 `src/script-result.ts`。在 Pi 上，本包还会把折叠状态下的 codemode 结果限制在十个可视行（对所有嵌套工具生效，仅影响显示）；`PI_UNIFIED_EXEC_COMPACT_CODEMODE=0` 可关闭。omp 没有 codemode，所以在 omp 上不生效。

## 常量

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
MIN_EMPTY_YIELD_TIME_MS      = 5_000
DEFAULT_EXEC_YIELD_MS        = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
TERMINAL_HISTORY_CELLS       = 240_000 (history between calls: cells / cols rows, at least one screen)
MAX_SESSIONS                 = 64
LRU_PROTECTED_COUNT          = 8
DEFAULT_MAX_BYTES            = 50 KiB  (model-visible per-call cap)
DEFAULT_MAX_LINES            = 2000
```

## 语义

- **提前退出：**150 毫秒内结束的命令不会进入会话存储；结果带 `exit_code`，没有 `session_id`。
- **在两次调用之间退出**的会话会留在存储里，直到下一次 `write_stdin` 或 `list_sessions` 报告它。
- **启动失败**（shell 或 `workdir` 不存在）在 PTY 启动前检查，以 `failure_message` 报告（`spawn <file> ENOENT: …`）。
- **没有 PTY 后端：**`exec_command` 在调用时报错并给出加载原因。
- **没有截止时间，也不重启：**本包从不因运行太久而结束命令，也从不重启已退出的进程。
- **shell 退出与终端关闭：**会话一直运行到其终端关闭。在 shell 退出后仍存活并持有 PTY 的后代进程（例如 `nohup` 或忽略 SIGHUP 的任务）会让终端保持打开；这类结果会带一条 `note`，说明如何把它分离出去（`setsid cmd >log 2>&1 </dev/null &`），运行中会话小部件会把该会话标为 `terminal held`。
- **终端已关闭**不会让宿主崩溃；写入时报告 `failure_message`。
- **Esc** 中断当前等待，但会话继续运行。
- **关闭**时向每个会话发送 SIGTERM，1 秒后对仍存活的发送 SIGKILL。仍处于 150 ms 启动宽限期内的 `exec_command` 不会拿到 `session_id`：它等关闭结束进程后报告这次退出，因此下一次 `session_start` 之后不会再看到该会话。其余终端已被关闭释放的进行中调用返回空输出，进程状态按实际报告：已退出，或在 SIGKILL 生效前仍在运行。
- **LRU 淘汰**在达到 64 个会话时进行，淘汰最旧的非保护会话，优先选已退出的；最近使用的 8 个永不淘汰。
- **观察**按会话串行执行；流式更新、`read term://`、monitor 与 Tern HUD 不消费普通观察。冻结终端资源的生命周期不受会话存储成员关系限制。
- **日志**放在临时目录（`/tmp` 或 `%TEMP%`），本包从不删除。请用不会执行控制序列的查看器查看原始 PTY 日志，不要用 `cat`。

## 示例

### 开发服务器

```
> exec_command(cmd="npm run dev", yield_time_ms=5000)
[still running]
session_id: 1
---
> Server listening on :3000

> write_stdin(session_id=1, chars="", yield_time_ms=10000)
[still running]
---
  GET /health 200 in 3ms

> kill_session(session_id=1)
```

### 交互式 Python REPL

```
> exec_command(cmd="python3 -q", yield_time_ms=1500)
[still running]
session_id: 1
terminal: normal screen 120x80, cursor row 1 col 5
---
>>>

> write_stdin(session_id=1, chars="print(7*6)\r", yield_time_ms=1000)
[still running]
terminal: normal screen 120x80, cursor row 3 col 5
---
>>> print(7*6)
42
>>>
```

### 带自动恢复的长任务（人要求时）

```
> exec_command(cmd="npm test", yield_time_ms=1000, on_exit="wake")
[still running]
session_id: 2
completion_notification: armed
---
# …the agent ends its turn; when npm test exits, one follow-up prompt resumes it.
> set_on_exit(session_id=2, on_exit="none")   # if the job is abandoned
```

## Windows

每个会话都在 ConPTY 中运行，经由 `Bun.Terminal`（Bun）或 node-pty（Node）。

- **默认 shell：**`bash`，依次查找 `PI_UNIFIED_EXEC_BASH`、PATH 上的 `bash`（排除 System32 里的 WSL 存根）、由 `git.exe` 推导或常见安装位置下的 Git for Windows，最后退回 `powershell` 并提示一次。启动前会把 shell 名解析成绝对路径。
- **PowerShell**（`powershell`，或任何平台上的 `pwsh`）以 `-NoProfile -NoLogo -Command <cmd>` 运行，所以它的交互式提示可以用 `write_stdin` 回答。
- **没有 POSIX 信号：**每次 kill 都是结束整个进程树（`taskkill /T /F`）；被结束的进程报告 `exit_code: 1`，kill 失败会如实报告。
- **Node PTY 预编译包**在安装时下载，不受 npm 摘要校验覆盖；Bun 内置的后端不需要这一下载。

## 目录结构

```
src/
├── index.ts              # tool registration, event handlers
├── session.ts            # ExecSession: spawn, read, write, kill, log stream, state
├── session-store.ts      # SessionStore + LRU eviction
├── collect.ts            # CollectResult: screen, final screen or none
├── long-wait.ts          # event-driven waits (polls, collection, kill) + rate-limited streaming
├── time.ts               # durations, operator limit, strict UTC deadlines
├── format-time.ts        # elapsed / remaining labels
├── completion.ts         # on_exit "wake" coordination (exactly-once)
├── notify.ts             # Notify / Gate / sleep primitives
├── pty.ts                # Bun.Terminal + node-pty backends, spawn preflight, Windows tree-kill
├── shell.ts              # shell selection and argv (Windows-aware)
├── output-safety.ts      # terminal-control stripping
├── terminal-screen.ts    # headless terminal: observations, styled screens, query answers
├── tool-result.ts        # bounded envelopes + model-visible text
├── script-result.ts      # codemode outputSchema / structuredContent
├── render.ts             # Pi renderers for all five tools
├── codemode-render.ts    # Pi codemode preview cap
└── unescape.ts           # C-style escape decoder for `chars`
fork-features/
├── omp-presentation.ts   # omp host detection, bash-renderer delegation, theme appearance
├── omp-tools.d.ts        # types of the omp modules loaded at runtime
├── tern-terminal-hud.ts  # counter pill, Terminals sheet, terminal page
├── terminal-resource.ts  # process-global terminal keys, live/frozen projections
├── terminal-url.ts       # omp `term://` read handler
├── terminal-image.ts     # terminal screenshots (SVG → PNG)
├── monitor-subscription.ts # monitor conditions, batching and follow-ups
├── tern-plugin-install.ts# keeps the Tern plugin installed
├── tern-plugin/          # CSS-only Tern plugin
└── README.md             # fork customizations and requalification
docs/
├── IV-0001-long-wait-and-wake-control.md
├── IV-0002-output-lifecycle-and-rendering.md
├── DC-0001-agentic-workspace.md
└── DEV.md                # upstream's maintainer guide
```

## 测试

```bash
npm install
npm test                                   # strict typecheck + unit/integration suites
EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
npm run test:tui                           # Pi tmux acceptance (skips without tmux)
```

在 Node 下加载不到预编译包时，Node PTY 测试会跳过；Bun 那条命令会用真实的 PTY 会话跑 HUD 生命周期测试。Tern 上的行为在真实的 Tern 窗口里验证，做法见 [fork-features/README.zh-CN.md](fork-features/README.zh-CN.md)。

## 开发与上游

[docs/DEV.md](docs/DEV.md) 是上游的维护者指南（开发流程、测试方法、codex 源码对照）；其中的 npm 发布部分不适用于本 fork，因为 fork 的发布 workflow 已停用。上游改动通过每日的 `Sync upstream` workflow 合入；fork 改动如何与上游隔离、同步冲突如何处理，见 [fork-features/README.zh-CN.md](fork-features/README.zh-CN.md)。

与上游一样采用 [MIT](./LICENSE) 许可。
