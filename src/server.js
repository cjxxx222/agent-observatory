/**
 * 查询服务：REST + SSE。
 *
 * 只用 node:http，零依赖。职责边界很窄 —— 读索引库、转发采集进度，
 * 不做任何业务判断（活跃度等派生值在 model.js 里统一算，避免多处口径不一致）。
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { collect } from './collector.js';
import { listSources } from './adapters/index.js';
import { createCompletionWatcher } from './notify.js';
import { listProcesses, summarizeAgents } from './probes/processes.js';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * 极简静态托管。刻意只服务 src/web 下的这几个文件，不做目录遍历 ——
 * 这是个监听 127.0.0.1 的本地工具，但不该因此省掉路径校验。
 */
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(WEB_ROOT, rel));
  // 必须带上分隔符再比较：否则 .../src/web-backup/x 也能通过 .../src/web 的前缀校验。
  if (!target.startsWith(WEB_ROOT + sep) || !existsSync(target)) return false;
  const ext = extname(target);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(target));
  return true;
}

export function createApiServer(store, {
  collectIntervalMs = 5000,
  notify = true,
  port = 7788,
  notifier,
  log = () => {},
} = {}) {
  const sseClients = new Set();
  let timer = null;
  /*
   * 提醒里的跳转地址必须跟着真实监听端口走 —— 写死 7788 的话，
   * 换端口启动后点通知会打开一个空的服务。
   */
  const watcher = notify
    ? createCompletionWatcher({ url: `http://127.0.0.1:${port}`, notifier, log })
    : null;

  const broadcast = (evt) => {
    const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  };

  const runCollect = (opts = {}) => {
    const summary = collect(store, { ...opts, onEvent: broadcast });
    broadcast({ type: 'collect_done', summary });
    // 每轮采集后顺带看一眼「谁安静下来了」—— 手工触发也走这里，口径一致。
    try { watcher?.observe(store); } catch (err) { log('完成提醒判定失败', err.message); }
    return summary;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      // 静态界面。放在 API 之前，避免与 /api/* 的路由判断纠缠。
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (serveStatic(url.pathname, res)) return;
      }

      if (url.pathname === '/api/events') return handleSse(req, res, sseClients);
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
      if (url.pathname === '/api/sources') return json(res, 200, { sources: listSources() });
      /**
       * Agent 总览：把「操作系统层面的进程状态」和「索引层面的会话活动」拼在一起。
       * 两者刻意不合并成单一状态字段 —— 进程活着但半天没说话、和进程根本没起来，
       * 是两件不同的事，看板上必须能分辨。
       */
      if (url.pathname === '/api/agents') {
        return json(res, 200, { agents: await buildAgentOverview(store) });
      }
      if (url.pathname === '/api/processes') {
        const scan = await listProcesses({ force: url.searchParams.get('force') === '1' });
        return json(res, 200, {
          supported: scan.supported,
          reason: scan.reason ?? null,
          agents: summarizeAgents(scan),
        });
      }
      if (url.pathname === '/api/stats') return json(res, 200, store.stats());
      if (url.pathname === '/api/tools') {
        return json(res, 200, { tools: store.toolUsage({ source: q(url, 'source') ?? undefined, limit: num(url, 'limit', 30) }) });
      }
      if (url.pathname === '/api/projects') return json(res, 200, { projects: store.listProjects() });
      if (url.pathname === '/api/search') {
        const query = q(url, 'q');
        if (!query) return json(res, 400, { error: '缺少查询参数 q' });
        return json(res, 200, { query, results: store.search(query, { limit: num(url, 'limit', 50), source: q(url, 'source') ?? undefined }) });
      }
      if (url.pathname === '/api/collect' && req.method === 'POST') {
        const source = q(url, 'source') ?? undefined;
        return json(res, 200, runCollect({ source, force: url.searchParams.get('force') === '1' }));
      }

      // /api/sessions[...]
      if (segments[0] === 'api' && segments[1] === 'sessions') {
        if (segments.length === 2) {
          return json(res, 200, {
            sessions: store.listSessions({
              source: q(url, 'source') ?? undefined,
              projectId: q(url, 'project') ?? undefined,
              kind: q(url, 'kind') ?? undefined,
              limit: num(url, 'limit', 50),
              offset: num(url, 'offset', 0),
            }),
          });
        }
        const id = decodeURIComponent(segments[2]);
        if (segments.length === 3) {
          const session = store.getSession(id);
          return session ? json(res, 200, session) : json(res, 404, { error: '会话不存在', id });
        }
        if (segments[3] === 'messages') {
          const tailRaw = url.searchParams.get('tail');
          return json(res, 200, {
            messages: store.getMessages(id, {
              limit: num(url, 'limit', 200),
              offset: num(url, 'offset', 0),
              kinds: url.searchParams.getAll('kind'),
              tail: tailRaw === null ? null : num(url, 'tail', 20),
            }),
          });
        }
        if (segments[3] === 'tree') {
          const tree = store.sessionTree(id);
          return tree ? json(res, 200, tree) : json(res, 404, { error: '会话不存在', id });
        }
      }

      return json(res, 404, { error: '未知路由', path: url.pathname });
    } catch (err) {
      log('请求处理失败', url.pathname, err.message);
      return json(res, 500, { error: err.message });
    }
  });

  server.startAutoCollect = () => {
    if (timer || !collectIntervalMs) return;
    timer = setInterval(() => {
      try { runCollect(); } catch (err) { log('自动采集失败', err.message); }
    }, collectIntervalMs);
    timer.unref?.();
  };

  server.stopAutoCollect = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  server.runCollect = runCollect;
  // 暴露出来供测试直接驱动判定，不必真的跑一轮全量采集。
  server.watcher = watcher;
  return server;
}

function handleSse(req, res, clients) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
  clients.add(res);
  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { /* 客户端已断开 */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function q(url, key) {
  return url.searchParams.get(key);
}

/**
 * 把「进程状态」与「索引状态」拼成每个 Agent 的一行。
 * 未接入索引的 Agent 照样出现在结果里，sessionCount 为 0、
 * latestSession 为 null —— 界面据此显示「进程在跑，但会话内容还没接入」，
 * 而不是干脆把这个 Agent 藏起来假装它不存在。
 */
async function buildAgentOverview(store) {
  const scan = await listProcesses();
  const overview = new Map(store.sourceOverview().map((o) => [o.source, o]));
  return summarizeAgents(scan).map((agent) => {
    const rows = agent.sources.map((s) => overview.get(s)).filter(Boolean);
    const latestSession = rows
      .map((r) => r.latest_session)
      .filter(Boolean)
      .sort((a, b) => (b.last_event_at ?? 0) - (a.last_event_at ?? 0))[0] ?? null;
    return {
      ...agent,
      indexed: rows.length > 0,
      sessionCount: rows.reduce((n, r) => n + (r.session_count ?? 0), 0),
      lastEventAt: rows.reduce((mx, r) => Math.max(mx, r.last_event_at ?? 0), 0) || null,
      latestSession,
      // 内容完整度按源汇总：界面据此说明「这个 Agent 只能看到一部分」，
      // 而不是让用户以为它什么都没干。
      contentScope: summarizeScope(rows),
    };
  });
}

function summarizeScope(rows) {
  const acc = { full: 0, userPrompts: 0, metadataOnly: 0 };
  let total = 0;
  for (const r of rows) {
    acc.full += r.full_sessions ?? 0;
    acc.userPrompts += r.user_prompt_sessions ?? 0;
    acc.metadataOnly += r.metadata_only_sessions ?? 0;
    total += r.session_count ?? 0;
  }
  if (!total) return null;
  if (acc.full === total) return 'full';
  if (acc.full > 0) return 'mixed';
  if (acc.userPrompts === total) return 'user-prompts';
  if (acc.metadataOnly === total) return 'metadata-only';
  return 'mixed';
}

function num(url, key, fallback) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}