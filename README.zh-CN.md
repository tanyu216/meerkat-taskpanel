# Task Panel

**面向 AI Agent 团队的任务看板。**

一个 local-first 的任务看板，为「AI Agent + 人」混合团队设计：Agent 认领任务（claim）、
发送心跳（heartbeat）、上报进度（progress）、沿依赖树汇总结果（rollup），人类则在同一个
看板上观察同一份状态。

> **状态：核心（M1）与 CLI（M2）已落地。**
> `src/core/` 已包含领域模型、SQLite 存储与迁移、用例与 `openBoard()`；`src/cli/` +
> `src/server/` 提供了真实的 `taskctl` 命令面，以及 CLI 会在回环地址上自动启动的最小
> 本地 `taskd` HTTP 服务（`TASKD_NO_AUTOSTART=1` 可禁用）。仍待实现：看板前端（`web/`）、
> 完整 MCP server（`src/mcp/`）与完整的 HTTP/SSE 看板后端。详见 `CLAUDE.md` /
> `docs/development.md`，各阶段见下方路线图。

## 仓库结构

```text
task-panel/
├── README.md / README.zh-CN.md   # 文档（默认英文，中文镜像）
├── LICENSE / PRIVACY.md
├── package.json                  # 工作区根 + bin(taskctl) + scripts
├── install.sh                    # 安装分发器：--target claude|openclaw|codex|pi|all
├── .claude-plugin/               # Claude marketplace 清单
├── src/                          # 工程源码
│   ├── core/                     #   领域模型 / SQLite 仓储 / 状态机 / 不变量
│   ├── cli/                      #   taskctl（CLI 出口）
│   ├── mcp/                      #   MCP server（stdio）
│   ├── server/                   #   本地 HTTP API + SSE
│   └── shared/                   #   共享 DTO / 常量
├── web/                          # 看板前端（React + Vite）→ dist/web
├── skills/task-panel/        # skill —— 单一事实源
├── plugins/                      # 每宿主一个分发单元（claude/codex/openclaw/pi）
├── design/                       # 产品设计物（PRD / DESIGN / BLOCKS / prototype / assets）
├── scripts/                      # 构建 / 安装 / 同步 / 校验
├── test/                         # 契约 + 冒烟测试
├── docs/                         # 使用与开发文档
└── dist/                         # 构建产物（gitignored）
```

## 安装

```bash
bash install.sh --target claude|openclaw|codex|pi|all
```

默认 target 为 `all`。分发器转发到 `scripts/install/<host>.sh`，把 skill 安装到各宿主的
skill 目录：

| 宿主 | 落点 |
|---|---|
| `claude` | `~/.claude/skills/task-panel` |
| `openclaw` | `~/.openclaw/skills/task-panel` |
| `codex` | `~/.codex/skills/task-panel` |
| `pi` | `~/.agents/skills/task-panel` |

常用参数：`--prefix <home>`（覆盖目标 home）、`--link`（软链而非拷贝）、`--force`
（覆盖已存在目标）、`--dry-run`（只打印落点，不做任何改动）。

## 开发

需要 **Node >= 22**（`node:sqlite` 时代）。无需网络、无依赖 —— 全部只用 Node 内置模块。

```bash
node --test                          # 运行冒烟 / 契约测试
node scripts/sync-skills.mjs         # skills/ → plugins/<host>/skills
node scripts/sync-skills.mjs --check # 校验各宿主 skill 副本是否同步
node scripts/verify/manifests.mjs    # 校验插件清单
node scripts/verify/skill.mjs        # 校验 SKILL.md frontmatter
node scripts/build.mjs               # 产出 dist/
```

或一次跑完：

```bash
npm run check
```

## 路线图

| 阶段 | 内容 |
|---|---|
| **M0** | 脚手架：目录骨架、清单、同步 / 校验脚本、测试（*已落地*） |
| M1 | `src/core`：领域模型、SQLite 仓储、状态机、不变量（*已落地*） |
| M2 | `taskctl` 命令面，对齐 `task-interface v1`；最小本地 `taskd`（*已落地*） |
| M3 | `src/mcp`：stdio MCP server |
| M6 | `src/server` + `web`：本地 HTTP API、SSE 与 React 看板 |

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
