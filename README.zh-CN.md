# opencode-monitor-task

> OpenCode V2 插件 · Qwen Code 风格的 `monitor` 工具集
> 让 agent 自主启动后台监听命令，阶段性输出**自动唤醒** agent 继续工作——把"阻塞等待"变成事件驱动协作。

**[English](./README.md)**

## 为什么做这个

OpenCode 原生的后台命令只在**整个命令结束**时通知 agent 一次。长时间任务（训练脚本、构建监控、日志观察）执行**中间**的阶段性标志（如 `epoch 3 done`、`stage 1 finish`）无法唤醒 agent，模型要么阻塞干等，要么靠轮询浪费 token。

Qwen Code 的内置 `monitor` 工具解决了这个问题：命令输出按行流式回传，**每个非空行变成一条通知，自动 re-invoke 会话**——事件驱动，非轮询。本项目把同等体验带到 OpenCode V2，并加上**正则过滤唤醒**的差异化能力。

## 用户故事

1. 你："跑这个 3 小时的训练脚本，每 10 个 epoch 和 loss 新低时检查一次。"
2. agent 调用 `monitor(command="python train.py 2>&1", pattern="epoch \\d+0/|NEW BEST|ERROR")` → 秒回监控 id
3. agent 告知"监控已启动"，转入空闲
4. 命中行到达 → `<task-notification>` 唤醒 agent → 自主决策（继续等 / 报警 / 调参 / 停止）
5. 命令退出 → 最终通知（含 exit code）→ agent 收尾汇报

## 实测数据

| 场景 | 结果 |
|---|---|
| 通知注入延迟 | 1–8 ms |
| 高噪训练日志 + 正则过滤 | 28 行扫描仅 4 行唤醒（过滤率 85.7%） |
| `coalesce_ms` 错误风暴合并 | 30 行 ERROR → **1** 条通知 |
| 60 epoch 训练模拟 | 61 行扫描 → 11 次唤醒（82% 过滤），0 丢弃 |
| 并发上限 | 每会话第 17 个并发监控被明确拒绝 |
| 孤儿进程 | 全部测试 0 孤儿（进程组级清理 + 宿主退出守卫） |

## 安装

要求 OpenCode V2（`opencode --version` 为 v2.0.11 或更新）。

### 全局安装（推荐）

一条命令装完，所有项目可用。直接从 GitHub 安装——仓库公开后即可用：

```sh
opencode plugin add github:mingdedi/opencode-monitor-task
```

或从 npm 安装（发布后）：

```sh
opencode plugin add opencode-monitor-task
```

包安装会通过 package `exports` **同时自动发现两个入口**——server 侧 `src/index.ts`（工具）与 TUI 侧 `src/tui.ts`（侧边栏面板），面板无需任何额外步骤。验证与管理：

```sh
opencode plugin list     # 插件 id 应出现在列表中
opencode plugin update   # 拉取更新（未固定版本的 npm/git 目标）
opencode plugin remove opencode-monitor-task
```

若插件未立即出现，执行 `opencode service restart`（或重启 TUI）。

### 仅项目级安装

在项目的 `opencode.json(c)` 的 `plugins` 数组中加入包名：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-monitor-task"]
}
```

### 从源码安装（开源前 / 开发）

```sh
git clone https://github.com/mingdedi/opencode-monitor-task.git
cd opencode-monitor-task
./scripts/install-local.sh --global-full   # 推荐：完整插件装全局（发布布局），所有项目可用
```

本仓库内开发的布局（两条命令）：

```sh
./scripts/install-local.sh            # server 入口 → 项目级 .opencode/plugins/
./scripts/install-local.sh --global   # TUI 入口 → 全局目录（TUI 只扫全局目录）
```

`--global-full` 把双入口 shim + `package.json` + `src/` 装进 `~/.config/opencode/plugins/` 并移除项目级副本——server 两个目录都扫，残留副本会加载两个 server 实例。完整全局安装存在时默认模式会拒绝执行。修改 `src/` 后重跑对应命令即触发热重载（未生效则 `opencode service restart`）。

`--link` 把全局安装替换为**指向仓库根的单个软链接**（仓库根本身就是完整插件布局）。改 `src/` 即时生效——`touch` 入口文件即触发热重载，无需重装。当 `~/.config/opencode` 本身是 git 仓库时特别有用：只跟踪一个 symlink 条目而不是 20+ 个复制文件，重装不再弄脏其 git status。随时可用 `./scripts/install-local.sh --global-full` 切回复制模式（脚本会先 unlink 软链接）。

> ⚠️ V2.0.x（实测至 2.0.11）会静默忽略 `plugins` 配置数组里的**本地路径条目**（`"plugins": ["."]`、绝对路径、`file://`）——`opencode plugin list` 显示空 ID。请改用 `opencode plugin add`、`.opencode/plugins/` 自动发现目录，或升级 OpenCode。

## 侧边栏面板（TUI）

插件的第二个入口（`src/tui.ts`）在 TUI 侧边栏渲染实时监控面板（`<leader>b` 切换显示），视野限定为**当前 session**：

```
 MONITORS · 2 running · 1 done
 ● mon_ab12 12m
   python train.py 2>&1
   scan 61 · sent 11 · hit 11 · pid 4242
 ✔ mon_cd34 exit code 0
   +1 running in 1 other session
   +5 running across all workspaces
```

- **session 级视野**：面板只显示当前 session 的监控明细。当前 session 经来源链解析：TUI 上下文（可用时）→ 心跳文件的 `active_session_id`（本工作区内最近执行过任意工具的 session）→ 无（折叠）。切换 session 后下一次 500ms 轮询自动跟随。
- **两级摘要**：`+N running in M other sessions` 汇总本工作区其余 session；其他工作区有活跃任务时追加 `+N running across all workspaces`。其他 session 的终态不做摘要。
- **状态**：`◐ starting`（进程拉起中）→ `● running` → `✔ completed` / `✘ failed` / `■ stopped`；运行中的行显示实时 pid
- **终态 TTL**：每个 session 最多保留最近 1 条终态记录（completed/failed/stopped 任一）；任务结束 5 分钟后自动消失
- **插件存活**：每个插件实例每 5s 向自己的 `state_heartbeat_<pid>.json` 写心跳；无新鲜心跳时面板显示 `MONITORS · plugin offline`——区分"没有监控"与"插件没在跑"
- **共存**：面板以叠加方式认领 `sidebar.content` 槽位——其他侧边栏插件（如 statusline）不受影响；无监控时空态折叠不占行

**架构**：server 插件与 TUI 插件运行在**隔离的运行时**（V2 无插件间事件通道），通过 `~/.local/share/opencode/monitor-task/` 下的一组原子写文件桥接（尊重 `$XDG_DATA_HOME`）：每 session 一个 `state_<hash>.json`（sessionID 全局唯一，并发项目/实例互不覆盖）+ 每实例一个心跳文件，TUI 侧 500ms 轮询。

**安装** —— 包方式安装（`opencode plugin add` 或 `plugins` 数组）及 `install-local.sh --global-full` 都会自动发现 TUI 入口，无需额外步骤。仅项目级开发布局需要：v2.0.11 的 TUI 只扫全局目录（`~/.config/opencode/plugins/`，不扫项目级目录），因此正常安装后再执行：

```sh
./scripts/install-local.sh --global   # 只装 TUI 入口（tui.ts + src），不会重复装 server 侧
```

重启 TUI 后，`/tmp/opencode-monitor-tui.log` 应出现 `claimed sidebar.content`。

## 工具

### `monitor` — 启动后台监控

| 参数 | 类型 / 范围 | 默认 | 说明 |
|---|---|---|---|
| `command` | string，必填 | — | 要执行的 shell 命令。尾部 `&` 自动移除；非末尾孤立 `&` 拒绝（`&&` 允许；fd 重定向如 `2>&1` 及引号内的 `&` 不受影响）。`$(...)`、反引号、`<(...)`、`>(...)` 直接拒绝。 |
| `description` | string ≤ 80 字符 | — | 展示在每条通知里的简短说明。 |
| `max_events` | int (0, 10000] | 1000 | 通知数达到上限即停止。越界值拒绝而非截断。 |
| `idle_timeout_ms` | int (0, 600000] | 300000 | 命令无输出超过该时长即停止。 |
| `directory` | 绝对路径 | 工作区根 | 命令工作目录；必须解析到项目工作区内。默认值从插件实例的工作区（`ctx.location`）解析——即使在共享 OpenCode 服务（其自身 cwd 为 `$HOME`）下也正确。 |
| `pattern` | 正则 | — | 仅命中行唤醒；未命中行计入 `lines_scanned`。非法正则带引擎错误拒绝。 |
| `wake_mode` | `all` \| `pattern` | 隐式 | 有 `pattern` 时为 `pattern`，否则 `all`。`all`+pattern 只统计不过滤。 |
| `delivery` | `queue` \| `steer` | `queue` | 会话正忙时的投递方式。生命周期通知恒为 `queue`。 |
| `coalesce_ms` | int [0, 60000] | 0（关闭） | 窗口内到达的多条唤醒行合并为一条通知（前 10 行、每行 200 字符）。 |

立即返回监控记录（`mon_...` id、状态、计数器）。

### `monitor_stop` — 停止监控

向命令进程组发 SIGTERM，逐步升级到 SIGKILL。参数为 `monitor_id`。

### `monitor_list` — 查看全部监控

运行中与已结束（保留上限 200），含状态、计数器（`events_sent` / `events_dropped` / `lines_scanned` / `lines_matched`）、配置回显、退出信息。

## 行为保证

- **节流** — 令牌桶：突发 5 条 + 每秒 1 条；超限行丢弃（计数，不缓存）
- **生命周期** — `starting`（进程拉起中，计入并发上限）→ `running` → 终态；记录携带实时 `pid`
- **自动停止** — 三条件任一：`max_events` 达标 / `idle_timeout_ms` 超时 / 命令退出。退出映射：exit 0 → `completed`；非零 → `failed: Exit code N`；信号 → `failed: Killed by signal SIGxxx`
- **输出处理** — stdout+stderr 合流、去 ANSI、去空行、按 `\n`/`\r`/`\r\n` 分行（兼容进度条输出）、64KB 无换行软换行、单行截断 2000 字符
- **并发** — 每会话最多 16 个运行中的监控
- **清理** — 停止时进程组级击杀；宿主退出（`exit`/`SIGTERM`/`SIGINT`）守卫，零孤儿

## 安全提示

监控输出会流入模型上下文。**不要用本工具监控外部可写入的流**（如公网可投稿的频道），除非你信任模型会忽略输出中嵌入的指令。通知信封已转义 `</task-notification>` 伪造。使用 `pattern` 过滤可显著缩小注入面——同时节省 token。

### 多用户主机上的日志与状态文件

插件会在运行 OpenCode 的机器上写入两个诊断日志和一组面板状态文件：

- **服务端日志** — `$TMPDIR/opencode/opencode-monitor-task.log`（通常在 `/tmp` 下）：记录**每条被监控命令的全文**、会话上下文探测信息（默认关闭，需设 `OPENCODE_MONITOR_TASK_DEBUG=1` 开启）与通知片段。可用环境变量 `OPENCODE_MONITOR_TASK_LOG_FILE` 重定向。
- **TUI 日志** — `$TMPDIR/opencode-monitor-tui.log`：TUI 上下文探测（同一开关，默认关闭）与会话视图诊断，位置同类，无重定向变量。
- **面板状态** — `${XDG_DATA_HOME:-~/.local/share}/opencode/monitor-task/`：每会话一个 `state_*.json`，内含命令全文、工作区路径与 session id。文件是临时的：已结束会话的文件约 5 分钟后删除，失去心跳的文件约 10 分钟后回收。

单用户机器上它们与 `$TMPDIR`、`~/.local` 下的其他文件一样私密。但在**多用户共享主机**上，这两个位置的默认权限对所有本地账号可读——被监控命令中的一切内容，包括内嵌的凭据（token、密码、带 key 的 URL），都会暴露给同机其他用户。建议：(a) 不要把密钥写进被监控命令行；(b) 用 `OPENCODE_MONITOR_TASK_LOG_FILE` 把服务端日志指向家目录下的受保护路径；(c) 对 `~/.local` 施加严格的 umask 或 ACL。

## 开发

```sh
npm install
npm test          # 108 个单元测试，<2s
npm run typecheck
./scripts/install-local.sh   # 同步 src/ 到 .opencode/plugins/ 并触发热重载
```

测试文件与场景脚本的说明见 [test/README.md](./test/README.md)。

## 许可证

[MIT](./LICENSE)
