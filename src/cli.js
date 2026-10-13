#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 命令：
 *   collect   执行一次采集（默认只采变化的文件）
 *   serve     起查询服务，带周期自动采集
 *   stats     打印索引库概览
 *   sessions  列出会话
 *   sources   列出已注册的数据源
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { collect } from './collector.js';
import { createApiServer } from './server.js';
import { listSources } from './adapters/index.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flags = parseFlags(args.slice(1));

// 项目根 = 本文件所在 src/ 的上一级。
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * 索引库刻意默认放在**项目内**的 .index/，而不是用户主目录。
 * 否则 `npm run collect` 一省略 --db，就会在主目录悄悄再建一个库，
 * 两个库各自演化成两个事实来源 —— 那比一个库都没有更糟。
 * 要换位置就显式传 --db，或用 AGENT_OBSERVATORY_HOME 指定。
 */
const defaultDb = join(
  process.env.AGENT_OBSERVATORY_HOME || join(PROJECT_ROOT, '.index'),
  'index.sqlite',
);
const dbPath = flags.db || defaultDb;

if (command === 'help' || flags.help) {
  printHelp();
  process.exit(0);
}

if (command === 'sources') {
  for (const s of listSources()) console.log(`${s.source.padEnd(16)} ${s.label}`);
  process.exit(0);
}

const store = openDb(dbPath);

switch (command) {
  case 'collect': {
    const summary = collect(store, { source: flags.source, force: Boolean(flags.force) });
    console.log(`索引库: ${dbPath}`);
    for (const s of summary.sources) {
      console.log(
        `  ${s.label.padEnd(16)} 主会话 +${s.main}  代理 +${s.agents}  用时 ${s.elapsedMs}ms`,
      );
    }
    console.log(
      `文件: 扫描 ${summary.filesSeen}，采入 ${summary.filesIngested}，跳过未变 ${summary.filesSkipped}，空会话已清理 ${summary.filesEmpty}`,
    );
    if (summary.errors.length) {
      console.log(`错误 ${summary.errors.length} 条（不影响其余文件）：`);
      for (const e of summary.errors.slice(0, 10)) console.log(`  - ${e.path ?? e.source}: ${e.message}`);
    }
    printStats(store);
    break;
  }

  case 'stats':
    console.log(`索引库: ${dbPath}`);
    printStats(store);
    break;

  case 'sessions': {
    const rows = store.listSessions({
      source: flags.source,
      limit: Number(flags.limit ?? 20),
      kind: flags.kind,
    });
    for (const r of rows) {
      const when = r.last_event_at ? new Date(r.last_event_at).toLocaleString('zh-CN') : '未知';
      const models = r.primary_model ?? '未记录';
      console.log(
        `${r.activity.padEnd(8)} ${String(r.message_count).padStart(5)}条 ${String(r.tool_call_count).padStart(4)}工具  ${when}  [${r.session_kind}] ${models}  ${r.title ?? '(无标题)'}`,
      );
    }
    console.log(`共 ${rows.length} 条（--limit 调整）`);
    break;
  }

  case 'serve': {
    const port = Number(flags.port ?? 7788);
    const interval = flags.interval === undefined ? 5000 : Number(flags.interval);
    const server = createApiServer(store, {
      collectIntervalMs: interval,
      log: (...m) => console.log('[server]', ...m),
    });
    server.runCollect({ source: flags.source });
    server.startAutoCollect();
    server.listen(port, '127.0.0.1', () => {
      console.log(`查询服务已启动: http://127.0.0.1:${port}`);
      console.log(`  索引库: ${dbPath}`);
      console.log(`  自动采集间隔: ${interval}ms（--interval 0 关闭）`);
      console.log('  Ctrl+C 停止');
    });
    const shutdown = () => {
      server.stopAutoCollect();
      server.close(() => { store.close(); process.exit(0); });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    break;
  }

  default:
    console.error(`未知命令: ${command}\n`);
    printHelp();
    process.exitCode = 1;
    store.close();
}

function printStats(s) {
  const stats = s.stats();
  console.log(
    `会话 ${stats.sessions}（主 ${stats.mainSessions} / 代理 ${stats.subagentSessions}）  ` +
    `消息 ${stats.messages}  工具调用 ${stats.toolCalls}  派生关系 ${stats.agentEdges}  项目 ${stats.projects}`,
  );
  if (stats.sources.length) {
    console.log('按数据源:');
    for (const src of stats.sources) console.log(`  ${src.source}: ${src.sessions} 个会话`);
  }
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function printHelp() {
  console.log(`agent-observatory —— 多源 Agent 观测平台的索引层

用法:
  node src/cli.js <命令> [选项]

命令:
  collect     执行一次采集
  serve       启动查询服务（REST + SSE），并周期性自动采集
  stats       打印索引库概览
  sessions    列出会话
  sources     列出已注册的数据源

选项:
  --db <路径>        索引库位置（默认 ~/.agent-observatory/index.sqlite）
  --source <名>      只处理某个数据源
  --force            忽略文件指纹，强制重采
  --limit <n>        sessions 命令的条数（默认 20）
  --kind <main|subagent|workflow>
  --port <n>         serve 端口（默认 7788）
  --interval <ms>    自动采集间隔（默认 5000，0 关闭）

示例:
  node src/cli.js collect
  node src/cli.js sessions --limit 10
  node src/cli.js serve --port 7788
`);
}