/**
 * Codex 适配器回归测试（node:test，零依赖）。
 *
 * 第一条用例跑的是**真实 rollout**：tests/fixtures/codex-home 下那份，取自
 * `~/.codex-session-delete/backups/` 的删除备份（2026-10-12，55,624 字节）。
 * 它锁住 session_meta / response_item / turn_context 的解析，以及注入上下文过滤。
 *
 * 真实样本里没有的路径另外覆盖：多帧 zstd、同 thread 多 rollout 的确定性去重、截断标记、子代理边。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import * as codex from '../src/adapters/codex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_HOME = join(HERE, 'fixtures', 'codex-home');
const REAL_ID = '01a12e9d-aada-7033-a0c4-ec5588d27e6a';

const metaLine = (id, extra = {}) =>
  JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: id, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/work', source: 'cli', history_mode: 'legacy', ...extra },
  });

const msgLine = (role, text, ordinal, extra = {}) =>
  JSON.stringify({
    timestamp: `2026-01-01T00:00:0${ordinal}.000Z`,
    ordinal,
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra },
  });

/** 在临时 CODEX_HOME 里放一个 rollout 文件，返回 home。 */
function fixtureHome(files) {
  const home = mkdtempSync(join(tmpdir(), 'codex-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(home, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return home;
}

test('真实 rollout：身份 / 模型 / 标题 / 注入上下文过滤', () => {
  const artifacts = codex.discover(REAL_HOME);
  assert.equal(artifacts.length, 1, '真实 fixture 应正好发现 1 个 rollout');
  const a = artifacts[0];
  assert.equal(a.nativeSessionId, REAL_ID);
  assert.equal(a.sessionKind, 'main');

  const { session, messages } = codex.parse(a);
  assert.equal(session.id, `codex:${REAL_ID}`);
  assert.equal(session.contentScope, 'full');
  assert.equal(session.cliVersion, '0.162.0-alpha.17.2');
  assert.match(session.cwd, /Documents[\\/]Codex[\\/]2026-10-12[\\/]n-h$/);

  // 这两条正是 C2 / C4 修的：session_meta 里既没有标题也没有模型名，
  // 它们分别来自「第一条真实用户提问」与 turn_context / base_instructions。
  assert.equal(session.primaryModel, 'gpt-6.1-sol');
  assert.equal(session.title, '你好');

  // 6 条 response_item = 4 条 developer + 2 条 user，其中 1 条 user 是注入的
  // <environment_context>。只有真人那句「你好」该进来。
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].text, '你好\n');
  assert.ok(!messages.some((m) => (m.text ?? '').includes('environment_context')), '注入上下文不应入库');
});

test('多帧 zstd：逐帧解压，不静默截断', () => {
  const id = '01a1aaaa-0000-7000-8000-00000000000a';
  const lines = [metaLine(id), msgLine('user', '第一帧', 1), msgLine('assistant', '第二帧', 2)];
  // 三个独立 zstd 帧顺序拼接，模拟 Codex 边跑边追加的冷历史文件
  const buf = Buffer.concat(lines.map((s) => zstdCompressSync(Buffer.from(s + '\n', 'utf8'))));
  const home = fixtureHome({ [`sessions/2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl.zst`]: buf });
  try {
    const a = codex.discover(home).find((x) => x.nativeSessionId === id);
    assert.ok(a, '应发现 .zst rollout');
    const { messages } = codex.parse(a);
    assert.equal(messages.length, 2, '三帧内容都要解出来，只解第一帧就是静默截断');
    assert.equal(messages[0].text, '第一帧');
    assert.equal(messages[1].text, '第二帧');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('同 thread 多 rollout：确定性地取 sessions/，不取归档', () => {
  const id = '01a1bbbb-0000-7000-8000-00000000000b';
  const home = fixtureHome({
    [`sessions/2026/02/02/rollout-2026-02-02T00-00-00-${id}.jsonl`]: metaLine(id),
    [`archived_sessions/2026/02/02/rollout-2026-02-02T00-00-00-${id}.jsonl`]: metaLine(id),
  });
  try {
    const arts = codex.discover(home);
    assert.equal(arts.length, 1, '同一 thread 只应产出一个 artifact');
    assert.ok(!arts[0].path.includes('archived_sessions'), '胜出的必须是 sessions/ 下那份');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('超长文本截断必须留痕', () => {
  const id = '01a1cccc-0000-7000-8000-00000000000c';
  const big = 'x'.repeat(25000);
  const home = fixtureHome({
    [`sessions/2026/03/03/rollout-2026-03-03T00-00-00-${id}.jsonl`]: `${metaLine(id)}\n${msgLine('user', big, 1)}\n`,
  });
  try {
    const { messages } = codex.parse(codex.discover(home)[0]);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /…\[已截断，原文 25000 字符\]$/, '被切短的消息不能看起来像完整的');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('子代理：由 session_meta.parent_thread_id 产出精确边', () => {
  const parentId = '01a1dddd-0000-7000-8000-00000000000d';
  const childId = '01a1eeee-0000-7000-8000-00000000000e';
  const home = fixtureHome({
    [`sessions/2026/04/04/rollout-2026-04-04T00-00-00-${childId}.jsonl`]:
      `${metaLine(childId, { parent_thread_id: parentId, agent_role: 'explorer' })}\n${msgLine('user', '子代理提问', 1)}\n`,
  });
  try {
    const { session, edges } = codex.parse(codex.discover(home)[0]);
    assert.equal(session.sessionKind, 'subagent');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].childSessionId, `codex:${childId}`);
    assert.equal(edges[0].parentSessionId, `codex:${parentId}`);
    assert.equal(edges[0].linkMethod, 'session_meta_parent_thread_id', '精确关系不能被标成目录推断');
    assert.equal(edges[0].agentType, 'explorer');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});