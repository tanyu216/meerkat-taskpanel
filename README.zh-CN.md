# Task Panel

**面向 AI Agent 团队的任务看板 —— Agent 干活，人只看进展。**

Task Panel 是 **AI-Agent-first** 的：项目与任务的创建、领取、心跳、进度上报、依赖与
epic 关系的搭建，乃至交付门禁，全部由 Agent 自己完成，全程无需人在环里。看板 UI 则是
刻意**只读**的 —— 它的存在，是让人一眼看清每个任务当前的状态、以及每个 epic 汇总到哪
一步。没有人需要靠点按钮来建卡。

> **状态：引擎已落地至 M6 —— 核心（M1）、CLI（M2）、stdio MCP server（M3），以及完整的
> 看板后端与 `web/` 前端（M6）。**
> `src/core/` 已包含领域模型、SQLite 存储与迁移、用例与 `openBoard()`；`src/cli/` +
> `src/server/` 提供了真实的 `taskctl` 命令面，以及 CLI 会在回环地址上自动启动的本地
> `taskd` HTTP 服务（`TASKD_NO_AUTOSTART=1` 可禁用）；`src/mcp/` 是 stdio MCP server，
> 暴露 18 个工具，作为通往 `taskd` 的、与交付门禁等价的薄代理；`src/server/` 提供完整的
> 看板 HTTP API 及其 SSE 事件流；`web/` 是 Vue 3 看板前端，构建到 `web/dist`，由 `taskd`
> 作为托管根对外提供。仍待实现：Epic 视图与迭代管理（见路线图）。详见 `CLAUDE.md` /
> `docs/development.md`、`src/mcp/README.md`，各阶段见下方路线图。

## 亮点

1. **Agent 干活，人只看。** 从项目与任务创建、领取、进度上报，到依赖、epic 与交付门禁，
   整个生命周期都由 Agent 驱动；UI 只读 —— 人跟的是任务状态与 epic 汇总，而不是填表单
   建卡。
2. **有据可查的交付门禁。** 卡只有在拿到**当轮**报告时才能进入 `in_review`，这条规则同时
   落在数据库与应用层。唯一的例外 —— 弃权（waiver）—— 必须写明理由，并记入审计轨迹。
3. **依赖与 epic 是一等公民。** `depends_on` 链接构成 DAG：无依赖可并行、有依赖则等待；
   父子链接把子树进展汇总（rollup）到所属 epic。
4. **可续接的 Agent 会话。** 每个会话都有由 `task + owner + segment` 推导出的确定性 id；
   重连即复用同一会话，不必为重建上下文白烧 token。
5. **append-only 审计轨迹。** 评论、报告与活动只增不改、不可删除。看板不只是工作的视图，
   它就是工作本身的记录。
6. **local-first、运行时零依赖。** 唯一持久化是一个 SQLite 文件（Node 内置
   `node:sqlite`）；引擎不依赖其它库，且完全可离线运行。
7. **同一块看板，多个入口。** 可用 `taskctl` CLI 驱动，可经 stdio MCP server（18 个工具）
   接入会说 MCP 的宿主，也可走本地 `taskd` HTTP API —— 并为 Claude Code、Codex、
   OpenClaw、pi 提供 skill/插件安装。MCP 面与门禁等价：`task_deliver` 是唯一能到达
   `in_review` 的工具。
8. **设计上 provider-agnostic。** Task Panel 是 openclaw-team 框架的默认看板基座 —— 其
   认领 / 候选判定与框架的 poll 保持同步，因此更换看板底座（Jira、Plane、Linear……）无需
   改动 Agent。访问由 token 与可选的 CIDR 白名单把关。
9. **为长期运行的 Agent 集群而建。** 心跳为认领设定 10 分钟的新鲜期；认领对本人 30 分钟后
   失效、对所有人 6 小时后失效，因此崩溃的 Agent 不会把卡卡死。

## 架构

Task Panel 是三层薄结构，依赖方向始终向内：`src/cli`、`src/mcp`、`src/server` 是入口，
`src/core` 持有领域模型、SQLite 存储与用例，`src/shared` 是它们共享的 DTO 与辅助函数。
完整目录树见 [仓库结构](#仓库结构)；想为自己的宿主安装 skill/插件，见 [安装](#安装)。

## 截图

产品原型截图（看板前端的视觉基线）：

![看板](prototype/screenshots/01-board-1512.png)

![Agent 任务抽屉](prototype/screenshots/03-drawer-agent.png)

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
├── web/                          # 看板前端（Vue 3 + Vite）→ web/dist（托管根）
├── skills/task-panel/        # skill —— 单一事实源
├── plugins/                      # 每宿主一个分发单元（claude/codex/openclaw/pi）
├── design/                       # 品牌资产（+ assets/、prototype/ 占位；内容迁移待办）
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
skill 目录。`Bundle` 列是该宿主自身插件系统消费的清单文件 —— 注册它需要对应宿主的 CLI，
因此 `install.sh` 只打印命令，不代为执行；每个宿主的具体命令见
[`docs/install.md`](docs/install.md#per-host-steps)。

| 宿主 | `--target` | Skill 落点 | Bundle |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/task-panel` | `plugins/claude/.claude-plugin/plugin.json` |
| OpenClaw | `openclaw` | `~/.openclaw/skills/task-panel` | `plugins/openclaw/openclaw.plugin.json`（原生） |
| Codex | `codex` | `~/.codex/skills/task-panel` | `plugins/codex/.codex-plugin/plugin.json` |
| Pi / Agent Skills | `pi` | `~/.agents/skills/task-panel` | `plugins/pi/package.json` |

OpenClaw 也可消费 Claude 格式的 bundle（`plugins/claude`），这是受支持的 skill-only
路线；`plugins/openclaw/openclaw.plugin.json` 是*原生*清单 —— 两者的区别见
[`docs/install.md`](docs/install.md#openclaw)。

常用参数：`--prefix <home>`（覆盖目标 home）、`--link`（软链而非拷贝）、`--force`
（覆盖已存在目标）、`--dry-run`（只打印落点，不做任何改动）。

## 开发

需要 **Node >= 22**（`node:sqlite` 时代）。引擎为**运行时**零依赖、无需网络 —— `src/` 下全部只用 Node 内置模块。唯一例外是 `web/`（Vue 3 + Vite + Tailwind + daisyUI），其**构建期** devDependencies 由镜像从随仓库提交的 `web/.vendor/npm-cache` 离线安装，产物不会进入运行时。

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
| M3 | `src/mcp`：stdio MCP server —— 18 个工具，`taskd` 的薄代理（*已落地*） |
| M6 | 完整的看板 HTTP API + SSE 后端（`src/server/`），以及 `web` 看板前端 → `web/dist`（*已落地*） |
| **Epic 视图** | epic 层级 / 进展 / rollup 的可视化视图 —— 查看 epic 及其子卡状态的聚合（*规划中*） |
| **迭代管理** | 迭代（sprint）周期管理：任务归入迭代、迭代内进度与容量（*规划中*） |

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
