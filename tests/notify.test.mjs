/**
 * 任务完成提醒的回归测试。
 *
 * 判定是「通用静默判定」：会话从「还在冒新事件」变成「连续 N 秒没有新事件」即认为这轮结束。
 * 这里锁住三件事：启动时不补报、安静满阈值报一次、之后再来新活动能重新武装。
 * 桌面通知本身（Windows toast）无法在测试里断言视觉结果，只测 XML 生成与转义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCompletionWatcher, toastXml } from '../src/notify.js';
import { openDb } from '../src/db.js';
import { emptySession } from '../src/model.js';

const MIN = 60_000;

const fakeStore = (rows) => ({ listCompletionCandidates: () => rows });

function collect() {
  const fired = [];
  const watcher = createCompletionWatcher({
    quietMs: MIN,
    notifier: (n) => fired.push(n),
    log: () => {},
  });
  return { fired, watcher };
}

test('启动瞬间就已经安静的会话不补报', () => {
  const { fired, watcher } = collect();
  watcher.observe(fakeStore([{ id: 'a', source: 'dsh', title: 'T', lastAt: 0 }]), 10 * MIN);
  assert.equal(fired.length, 0, '一开服务就不该刷一屏历史会话');
});

test('活动中的会话安静满阈值后只提醒一次', () => {
  const { fired, watcher } = collect();
  const store = fakeStore([{ id: 'a', source: 'dsh', title: '修登录超时', lastAt: 0 }]);

  watcher.observe(store, 0);
  assert.equal(fired.length, 0, '刚有活动，还没安静');
  watcher.observe(store, 30_000);
  assert.equal(fired.length, 0, '未满阈值');
  watcher.observe(store, MIN);
  assert.equal(fired.length, 1, '满阈值应提醒');
  watcher.observe(store, 5 * MIN);
  assert.equal(fired.length, 1, '持续安静不应重复提醒');
  assert.match(fired[0].body, /DeepSeek Harness · 修登录超时/, '正文应带源名与标题');
});

test('再次出现新活动会重新武装，下一轮结束再提醒', () => {
  const { fired, watcher } = collect();
  let rows = [{ id: 'a', source: 'dsh', title: 'T', lastAt: 0 }];
  const store = { listCompletionCandidates: () => rows };

  watcher.observe(store, 0);
  watcher.observe(store, MIN);
  assert.equal(fired.length, 1);

  rows = [{ id: 'a', source: 'dsh', title: 'T', lastAt: 200 * MIN }]; // 又冒了新事件
  watcher.observe(store, 200 * MIN);
  assert.equal(fired.length, 1, '刚重新活动，不该报');

  watcher.observe(store, 261 * MIN);
  assert.equal(fired.length, 2, '再次安静满阈值应再报一次');
});

test('只把能看到正文的会话（content_scope=full）列为候选', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-notify-'));
  const store = openDb(join(dir, 'index.sqlite'));
  try {
    const mk = (id, source, scope, lastAt) => {
      const s = emptySession();
      s.id = id; s.source = source; s.nativeId = id; s.sessionKind = 'main';
      s.contentScope = scope; s.startedAt = lastAt; s.lastEventAt = lastAt;
      return s;
    };
    store.saveSession(mk('s-full', 'dsh', 'full', 1000));
    store.saveSession(mk('s-prompts', 'trae-cn', 'user-prompts', 1000));
    store.saveSession(mk('s-meta', 'codex', 'metadata-only', 1000));

    const ids = store.listCompletionCandidates().map((r) => r.id);
    assert.deepEqual(ids, ['s-full'], 'user-prompts / metadata-only 拿不到 Agent 产出，不该报完成');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toast XML：可点击跳转、带提示音、特殊字符被转义', () => {
  const xml = toastXml('完成 <&>"', 'dsh · a & b', 'http://127.0.0.1:7788');
  assert.match(xml, /activationType="protocol"/);
  assert.match(xml, /launch="http:\/\/127\.0\.0\.1:7788"/);
  assert.match(xml, /ms-winsoundevent:Notification\.Default/, '应有提示音');
  assert.ok(!/<&>/.test(xml), '原文里的尖括号必须被转义');
  assert.match(xml, /&lt;&amp;&gt;&quot;/, '特殊字符应转义为实体');
});