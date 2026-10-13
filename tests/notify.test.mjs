/**
 * 任务完成提醒的回归测试。
 *
 * 判定是「通用静默判定」：会话从「还在冒新事件」变成「连续 N 秒没有新事件」即认为这轮结束。
 * 锁住的行为：
 *   - 启动瞬间已安静的会话不补报
 *   - 安静满阈值只报一次；再次有新活动会重新武装
 *   - 时间戳被回填（变新但仍很旧）不触发补报
 *   - 同一父会话下几十个子代理同批安静 → 只发一条合并通知
 *   - 只有能看到正文（content_scope=full）的会话才是候选
 *   - 通知里的跳转地址跟随真实监听端口
 *   - 丢失的派生边能从 sessions.parent_session_id 兜底恢复
 * 桌面通知的视觉结果无法在测试里断言，只测 XML 生成与转义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCompletionWatcher, toastXml } from '../src/notify.js';
import { createApiServer } from '../src/server.js';
import { openDb } from '../src/db.js';
import { emptySession } from '../src/model.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 用一个真实量级的 epoch ms 做基准：watcher 的「回填」判定要和时间本身比较，
// 用 0 / 60 这种玩具时间戳测不出真实行为。
const T0 = 1_800_000_000_000;

const fakeStore = (rows) => ({ listCompletionCandidates: () => rows });

function makeWatcher(overrides = {}) {
  const calls = [];
  const watcher = createCompletionWatcher({
    quietMs: MIN,
    startedAt: T0,
    notifier: (n) => calls.push(n),
    log: () => {},
    ...overrides,
  });
  return { calls, watcher };
}

const session = (id, source, scope, lastAt, parentSessionId = null) => {
  const s = emptySession();
  s.id = id;
  s.source = source;
  s.nativeId = id;
  s.sessionKind = parentSessionId ? 'subagent' : 'main';
  s.contentScope = scope;
  s.startedAt = lastAt;
  s.lastEventAt = lastAt;
  s.parentSessionId = parentSessionId;
  return s;
};

test('启动瞬间就已经安静的会话不补报', () => {
  const { calls, watcher } = makeWatcher();
  watcher.observe(fakeStore([{ id: 'a', source: 'dsh', title: 'T', lastAt: T0 - 2 * HOUR, parentSessionId: null }]), T0);
  assert.equal(calls.length, 0, '一开服务就不该刷一屏历史会话');
});

test('活动中的会话安静满阈值后只提醒一次', () => {
  const { calls, watcher } = makeWatcher();
  const store = fakeStore([{ id: 'a', source: 'dsh', title: '修登录超时', lastAt: T0, parentSessionId: null }]);

  watcher.observe(store, T0);
  assert.equal(calls.length, 0, '刚有活动，还没安静');
  watcher.observe(store, T0 + 30_000);
  assert.equal(calls.length, 0, '未满阈值');
  watcher.observe(store, T0 + MIN);
  assert.equal(calls.length, 1, '满阈值应提醒');
  watcher.observe(store, T0 + 5 * MIN);
  assert.equal(calls.length, 1, '持续安静不应重复提醒');
  assert.match(calls[0].body, /DeepSeek Harness · 修登录超时/, '正文应带源名与标题');
});

test('再次出现新活动会重新武装，下一轮结束再提醒', () => {
  const { calls, watcher } = makeWatcher();
  let rows = [{ id: 'a', source: 'dsh', title: 'T', lastAt: T0, parentSessionId: null }];
  const store = { listCompletionCandidates: () => rows };

  watcher.observe(store, T0);
  watcher.observe(store, T0 + MIN);
  assert.equal(calls.length, 1);

  rows = [{ id: 'a', source: 'dsh', title: 'T', lastAt: T0 + 20 * MIN, parentSessionId: null }];
  watcher.observe(store, T0 + 20 * MIN);
  assert.equal(calls.length, 1, '刚重新活动，不该报');

  watcher.observe(store, T0 + 21 * MIN);
  assert.equal(calls.length, 2, '再次安静满阈值应再报一次');
});

test('N2：时间戳被回填（变新但仍早于开始观察）不触发补报', () => {
  const { calls, watcher } = makeWatcher();
  let rows = [{ id: 'a', source: 'dsh', title: 'T', lastAt: T0 - 2 * HOUR, parentSessionId: null }];
  const store = { listCompletionCandidates: () => rows };

  watcher.observe(store, T0);
  assert.equal(calls.length, 0, '启动时它已安静 → 不报');

  // 重解析补出一条更晚、但仍很旧的消息：lastEventAt 变大了，可这不是「刚刚又干活了」
  rows = [{ id: 'a', source: 'dsh', title: 'T', lastAt: T0 - HOUR, parentSessionId: null }];
  watcher.observe(store, T0 + MIN);
  assert.equal(calls.length, 0, '回填不是新活动，不能借它补报一条几小时前的完成');
});

test('N1：同一父下的 50+ 子代理同批安静只发一条合并通知', () => {
  const parent = 'codex:parent-1';
  const children = Array.from({ length: 57 }, (_, i) => ({
    id: `codex:child-${i}`,
    source: 'codex',
    title: `子代理 ${i}`,
    lastAt: T0,
    parentSessionId: parent,
  }));
  const { calls, watcher } = makeWatcher();

  watcher.observe(fakeStore(children), T0);
  assert.equal(calls.length, 0, '子代理还在活动，不报');
  // sessionIds 只在 observe() 的返回值里（通知载荷本身不需要它），所以断言返回值
  const sent = watcher.observe(fakeStore(children), T0 + MIN);

  assert.equal(calls.length, 1, '57 个子代理同批安静只该发一条，不能刷屏');
  assert.equal(sent.length, 1, '归组后只产出一条提醒');
  assert.equal(sent[0].title, '一批子代理完成');
  assert.match(sent[0].body, /派生了 57 个子代理/);
  assert.equal(sent[0].sessionIds.length, 57, '合并通知应覆盖全部子代理');
});

test('没有父会话的多个会话各自成组，不互相合并', () => {
  const { calls, watcher } = makeWatcher();
  const rows = [
    { id: 'a', source: 'dsh', title: 'A', lastAt: T0, parentSessionId: null },
    { id: 'b', source: 'dsh', title: 'B', lastAt: T0, parentSessionId: null },
  ];
  watcher.observe(fakeStore(rows), T0);
  watcher.observe(fakeStore(rows), T0 + MIN);
  assert.equal(calls.length, 2, '彼此无关的会话不该被合并成一条');
});

test('只把能看到正文的会话（content_scope=full）列为候选', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-notify-'));
  const store = openDb(join(dir, 'index.sqlite'));
  try {
    store.saveSession(session('s-full', 'dsh', 'full', T0));
    store.saveSession(session('s-prompts', 'trae-cn', 'user-prompts', T0));
    store.saveSession(session('s-meta', 'codex', 'metadata-only', T0));

    const ids = store.listCompletionCandidates().map((r) => r.id);
    assert.deepEqual(ids, ['s-full'], 'user-prompts / metadata-only 拿不到 Agent 产出，不该报完成');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N3：通知里的跳转地址跟随真实监听端口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-port-'));
  const store = openDb(join(dir, 'index.sqlite'));
  try {
    store.saveSession(session('s1', 'dsh', 'full', T0));
    const calls = [];
    const srv = createApiServer(store, { notify: true, port: 8123, notifier: (n) => calls.push(n), log: () => {} });

    srv.watcher.observe(store, T0);
    // server 侧用的是生产默认静默阈值（90s），这里要跨过它
    srv.watcher.observe(store, T0 + 120_000);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8123', '写死 7788 的话换端口后点通知会打开空服务');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1 兜底：丢失的派生边能从 sessions.parent_session_id 恢复，且幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-edges-'));
  const store = openDb(join(dir, 'index.sqlite'));
  try {
    store.saveSession(session('p', 'dsh', 'full', T0));
    store.saveSession(session('c', 'dsh', 'full', T0, 'p'));
    assert.equal(store.db.prepare('SELECT COUNT(*) c FROM agent_edges').get().c, 0, '前置：边是丢的');

    assert.equal(store.recoverMissingEdges(), 1, '应补回这条边');
    const e = store.db.prepare('SELECT * FROM agent_edges').get();
    assert.equal(e.parent_session_id, 'p');
    assert.equal(e.child_session_id, 'c');
    assert.equal(e.link_method, 'recovered_from_session', '要标明是兜底补的，不假装来自原始文件');

    assert.equal(store.recoverMissingEdges(), 0, '幂等：再跑一次不该重复补');

    // 指向不存在父会话的悬空指针不补，避免关系图上出现指向空气的箭头
    store.saveSession(session('c2', 'dsh', 'full', T0, 'ghost'));
    assert.equal(store.recoverMissingEdges(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N5：单轮通知有硬上限，超出的折叠成一条汇总', () => {
  const { calls, watcher } = makeWatcher({ maxPerRound: 3 });
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`, source: 'dsh', title: `T${i}`, lastAt: T0, parentSessionId: null,
  }));
  watcher.observe(fakeStore(rows), T0);
  watcher.observe(fakeStore(rows), T0 + MIN);

  assert.equal(calls.length, 4, '3 条明细 + 1 条汇总，不能一次 spawn 十个 PowerShell');
  assert.match(calls[3].title, /更多会话完成/);
  assert.match(calls[3].body, /另有 7 个会话/, '被折叠的数量要如实报出来');
});

test('N6：XML 非法控制字符被剔除（否则 LoadXml 静默失败）', () => {
  const xml = toastXml('标题\u0001带\u0007控制符', '正文\u0000\u001F', 'http://127.0.0.1:7788');
  assert.ok(
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml),
    'XML 1.0 不允许的控制字符必须被剔除，否则整条通知会静默丢失',
  );
  assert.match(xml, /标题带控制符/);
});

test('toast XML：可点击跳转、带提示音、特殊字符被转义', () => {
  const xml = toastXml('完成 <&>"', 'dsh · a & b', 'http://127.0.0.1:8123');
  assert.match(xml, /activationType="protocol"/);
  assert.match(xml, /launch="http:\/\/127\.0\.0\.1:8123"/);
  assert.match(xml, /ms-winsoundevent:Notification\.Default/, '应有提示音');
  assert.ok(!/<&>/.test(xml), '原文里的尖括号必须被转义');
  assert.match(xml, /&lt;&amp;&gt;&quot;/, '特殊字符应转义为实体');
});