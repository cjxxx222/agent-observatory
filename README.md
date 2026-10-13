# agent-observatory

把本机 5 个 AI Agent 的本地会话统一索引成一层可查询的数据，并提供多源看板与任务完成桌面提醒。

只用 Node 内置能力，**零第三方依赖**（`node:sqlite` / `node:http` / `node:zlib`）。

---

## 它解决什么问题

本机同时跑着 5 个 Agent，它们的会话存在**完全不同的地方、格式互不兼容**：

| Agent | 存在哪 | 长什么样 |
|---|---|---|
| Claude Code | `~/.claude/projects/<项目>/` | 一行一条的 JSONL + `agent-*.meta.json` |
| DeepSeek Harness | `~/.dsh/sessions/<cwd>/<id>/` | **多帧拼接**的 zstd 压缩 JSONL |
| WorkBuddy | `~/.workbuddy/` | SQLite + 对话日志 |
| Codex | `$CODEX_HOME/state_5.sqlite` + `sessions/**.jsonl` | SQLite 元数据 + rollout JSONL |
| Trae CN | `%APPDATA%\Trae CN\User\workspaceStorage\` | VS Code 的 `state.vscdb`（KV 存储） |

结果是没有一个地方能回答：**我现在有几个 Agent 在跑、各自在做什么、谁是谁派生的子代理。**

---

## 三条设计原则（这些是能对着代码核的）

**1. 统一会话模型，适配器只负责翻译**
`src/model.js` 定义唯一的实体：会话 / 消息 / 派生边。上层（查询服务、看板、提醒）只认这套模型，不关心数据来自哪个 Agent。新增一个源 = 新增一个适配器，不动上层。

**2. 字段缺失一律 `null`，绝不用 `0` 冒充「未知」**
例如 Codex 的 `threads.tokens_used` 是「输入+输出」合并的单一数值。把它硬塞进 `tokensIn` 或 `tokensOut` 任一侧，都是**编造一个不存在的分布**——所以留空。界面上显示「未知」，而不是「0 成本 / 0 token」。

**3. 派生关系必须标注可信度**（`linkMethod`）
「A 派生了 B」有五种来源，可信度完全不同：

| linkMethod | 含义 |
|---|---|
| `tool_use_id` | 由 meta 里的 toolUseId 精确回指父会话中被调用的那次工具调用 |
| `spawn_edge_table` | 源自己的派生关系表（Codex `thread_spawn_edges`） |
| `session_meta_parent_thread_id` | 子会话身份页里写的父线程 |
| `parent_session_field` | 会话记录里的 parentSession 字段（DSH） |
| `host_directory` | **只能确定归属目录**，找不到精确的发起记录 |
| `recovered_from_session` | 边此前丢失、由索引库里的父指针兜底补回的 |

关系图上必须区分这些。**把目录推断画成精确调用链，就是在骗人。**

---

## 各源到底能读到什么（`contentScope`）

这一栏是为了让看板能分辨「这个 Agent 没有工具调用」和「这个源读不到工具调用」。

| 源 | contentScope | 说明 |
|---|---|---|
| Claude Code | `full` | 用户提问 + 模型回复 + 工具调用齐全 |
| DeepSeek Harness | `full` | 同上 |
| WorkBuddy | `full` | 同上 |
| Codex | `full` / `metadata-only` | 有 rollout 正文时 `full`；只有元数据时退化为 `metadata-only` |
| Trae CN | `user-prompts` | **只有你自己的提问**——模型回复与工具调用在云端，本地不存在 |

---

## 目录结构

```
src/
  model.js              统一会话模型 + 活跃度/时间等公共换算
  db.js                 SQLite 索引层（建表、重建判定、幂等写入）
  collector.js          采集调度：两趟（先主会话、再子代理）+ 收尾对账
  adapters/
    index.js            适配器注册表 + 各源数据根目录
    claude-code.js      ┐
    dsh.js              │ 每个适配器只做一件事：
    workbuddy.js        │ 把某个源的文件翻译成统一模型
    codex.js            │
    trae-cn.js          ┘
  probes/processes.js   进程探针：直接问操作系统「这个 Agent 现在活着吗」
  notify.js             任务完成判定（静默判定 + 同父归组 + 单轮上限）与 Windows 通知
  server.js             REST + SSE 查询服务
  cli.js                命令行入口
  web/                  极简看板（原生 HTML/CSS/JS）
tests/                  node:test，零依赖
  fixtures/             真实 Codex rollout（已脱敏）作为 golden fixture
```

---

## 跑起来

**要求**：Windows；Node **≥ 22.15**（用到 `node:sqlite` 与 zstd 解压）。
> 进程探针与桌面通知目前只实现了 Windows，其他平台会在对应能力上明确返回「不支持」而不是猜一个值。

```bash
npm run collect     # 采集一次
npm run serve       # 起查询服务（默认 http://127.0.0.1:7788，带周期自动采集）
npm run stats       # 打印索引库概览
npm run sources     # 列出已注册的数据源
npm test            # 跑测试
```

常用参数：

```
--db <路径>        索引库位置（默认 <项目>/.index/index.sqlite）
--source <名>      只处理某个数据源
--force            忽略文件指纹，强制重采
--port <n>         serve 端口（默认 7788）
--interval <ms>    自动采集间隔（默认 5000，0 关闭）
--notify <0|1>     Agent 完成任务的桌面提醒（默认开，传 0 关闭）
--limit <n>        sessions 命令的条数（默认 20）
--kind <main|subagent|workflow>
```

环境变量：`CODEX_HOME`、`CLAUDE_CONFIG_DIR`（覆盖对应源的数据根目录）、`AGENT_OBSERVATORY_HOME`（索引库所在目录）。

---

## HTTP 接口

```
GET  /api/health              健康检查
GET  /api/stats               索引库概览
GET  /api/sources             已注册的数据源
GET  /api/sessions            会话列表（source / project / kind / limit / offset）
GET  /api/sessions/:id        单个会话（含派生边与父会话）
GET  /api/sessions/:id/messages   消息（limit / offset / kind / tail）
GET  /api/sessions/:id/tree       派生树
GET  /api/agents              各 Agent 的运行状态（进程探针）
GET  /api/processes           进程明细
GET  /api/tools               工具调用统计
GET  /api/projects            项目列表
GET  /api/search              全文检索（FTS5）
GET  /api/events              SSE：采集进度实时推送
POST /api/collect             立即采集（支持 source / force=1）
```

---

## 任务完成桌面提醒

**判定口径**：会话从「还在冒新事件」变成「连续 90 秒没有新事件」，就认为这一轮结束。

这个口径是**近似**的——它说的是「安静下来了」，**不等于**「Agent 汇报完成了」。Agent 停在等你审批输入时同样会触发。那种时刻本来也值得看一眼，但心里要清楚这个折扣。

配套的几条边界：
- **只对 `contentScope='full'` 的会话提醒**。拿不到 Agent 产出的源（Trae CN、metadata-only）报「完成」是在编。
- **同一父会话下的子代理同批安静 → 只发一条**，正文写「派生了 N 个子代理」（实测一个父下挂了 55 个子代理，逐条弹会瞬间刷屏）。
- **单轮最多 5 条**，超出的折叠成一条如实报数的汇总；组按会话数降序排，保证被砍掉的是信息量最小的那几条。
- 通知点击后用默认浏览器打开看板。

---

## 已知限制（明写，不藏）

- **Codex 在本机当前是 0 会话**。它的历史会话曾正常落盘，但被 Codex++ 删除并备份到 `~/.codex-session-delete/`。解析器已用从该备份取回的真实 rollout（55,624 字节）端到端验证，但在本机看不到它跑起来——需要正常用一轮 Codex 才会产生新的 rollout。
- **Trae CN 拿不到模型回复与工具调用**（在云端），本地只存**每个工作区各自的提问历史**。
- **进程探针与桌面通知只实现了 Windows**；其他平台明确返回「不支持」。
- **桌面提醒的重启行为**：判定状态只活在内存里，重启后重新建立基线——重启时正「安静中、尚未提醒」的会话不会再补提醒。这是刻意取舍：漏掉个别提醒，好过一开服务就把一屏历史会话补弹出来。
- **提醒归组只在同一轮判定内生效**：子代理若分几轮才陆续安静，每轮仍会各发一条。
- DSH 的会话文件是**多帧拼接的 zstd**，不能用「单帧解压」处理——Node 的 `zstdDecompressSync` 遇到多帧**不报错，只解第一帧**，会静默截断。测试 `多帧 zstd：逐帧解压，不静默截断` 锁住了这条。

---

## 测试

```bash
npm test     # 17 例，全绿
```

`tests/fixtures/` 里是一份**真实的 Codex rollout**（已脱敏：路径与正文占位，但保留全部结构、`content_item_kinds` 与字段形状）。用它做 golden fixture，把「作者说对」变成「机器保证对」。

覆盖的关键边界：真实 rollout 解析、注入上下文过滤、多帧 zstd、同 thread 多 rollout 的确定性去重、截断标记、子代理精确边、提醒的归组/上限/回填抑制/端口跟随、丢失派生边的兜底恢复。

---

## 开发方式（如实说明）

本项目在 **AI 辅助下开发**：架构与实现由 AI 协作产出，产品上的取舍由项目所有者拍板确认——例如砍掉交易/量化方向、只对 `contentScope='full'` 的源报「完成」、宁可漏报也不刷屏、Trae CN 只用工位文件 mtime 兜底 `lastEventAt` 而 `startedAt` 保持 `null`。

代码里的注释记录的是**当时为什么这么定、代价是什么**，不是事后补的漂亮话。凡是没有把握的地方，都写成「未知」而不是猜一个值。