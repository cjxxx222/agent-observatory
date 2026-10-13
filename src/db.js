/**
 * 索引库（SQLite）。
 *
 * 用 Node 22+ 内置的 node:sqlite，零第三方依赖 —— 这个项目依赖越少，
 * 越不会被上游破坏（上一个项目的教训）。
 *
 * 索引库始终可以被删除重建：它只是各源会话的派生视图，不是事实来源。
 * 因此 schema 变更的处理方式是「升版本号 → 重建」，不写迁移脚本。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODEL_VERSION, activityOf, normalizePathKey } from './model.js';

/**
 * 表结构版本。与 MODEL_VERSION 分开：字段语义变更影响的是解析逻辑，
 * 表结构变更影响的是存储。两者任一变化都必须重建索引库。
 */
const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  cwd_key    TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  name       TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  native_id           TEXT NOT NULL,
  session_kind        TEXT NOT NULL DEFAULT 'main',
  content_scope       TEXT NOT NULL DEFAULT 'full',
  project_id          TEXT,
  parent_session_id   TEXT,
  agent_id            TEXT,
  title               TEXT,
  cwd                 TEXT,
  git_branch          TEXT,
  cli_version         TEXT,
  entrypoint          TEXT,
  primary_model       TEXT,
  models_json         TEXT,
  started_at          INTEGER,
  last_event_at       INTEGER,
  cost_usd            REAL,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  tokens_cache_read   INTEGER,
  tokens_cache_create INTEGER,
  tokens_thinking     INTEGER,
  artifact_path       TEXT,
  artifact_bytes      INTEGER,
  artifact_mtime      INTEGER,
  ingested_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_source  ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent  ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last    ON sessions(last_event_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  source              TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  role                TEXT,
  kind                TEXT NOT NULL,
  uuid                TEXT,
  parent_uuid         TEXT,
  agent_id            TEXT,
  tool_name           TEXT,
  tool_use_id         TEXT,
  is_error            INTEGER,
  text                TEXT,
  payload_json        TEXT,
  model               TEXT,
  ts                  INTEGER,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  tokens_cache_read   INTEGER,
  tokens_cache_create INTEGER,
  tokens_thinking     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_tooluse ON messages(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_messages_tool    ON messages(tool_name);

CREATE TABLE IF NOT EXISTS agent_edges (
  id                 TEXT PRIMARY KEY,
  parent_session_id  TEXT NOT NULL,
  child_session_id   TEXT NOT NULL,
  parent_tool_use_id TEXT,
  agent_type         TEXT,
  description        TEXT,
  spawn_depth        INTEGER,
  request_shape      TEXT,
  link_method        TEXT,
  created_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_edges_parent ON agent_edges(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_edges_child  ON agent_edges(child_session_id);

CREATE TABLE IF NOT EXISTS artifacts (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  session_id  TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  ingested_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  message_id UNINDEXED,
  session_id UNINDEXED,
  text
);
`;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  /*
   * 重建判定走双重校验，不只看版本号：
   *  - 版本号可能被上一次「半成功」的启动写脏（DDL 建完、Store 构造失败，标记却已落库）；
   *  - 只 DELETE 数据行也不够，表结构变了旧列还在，新列根本加不上，必须 DROP 重建。
   * 因此：版本不符 **或** 关键列缺失 —— 任一成立就整库重建。
   */
  const needRebuild = isVersionStale(db) || !hasExpectedColumns(db);
  if (needRebuild) dropAll(db);

  db.exec(DDL);
  db.exec('PRAGMA foreign_keys = ON');

  // 先把 Store 建起来。构造成功就说明语句与表结构匹配，这时才写版本标记 ——
  // 顺序反过来会出现「标记说已重建、实际没重建」的脏状态。
  const store = new Store(db);

  const setMeta = db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  setMeta.run('model_version', String(MODEL_VERSION));
  setMeta.run('schema_version', String(SCHEMA_VERSION));
  if (needRebuild) setMeta.run('rebuilt_at', String(Date.now()));

  return store;
}

/** 读取已存版本；表不存在或版本不符都算需要重建。 */
function isVersionStale(db) {
  let model;
  let schema;
  try {
    model = db.prepare('SELECT value FROM meta WHERE key = ?').get('model_version');
    schema = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  } catch {
    return false; // meta 表还不存在 —— 全新库，交给 DDL 去建。
  }
  if (!model || !schema) return false;
  return Number(model.value) !== MODEL_VERSION || Number(schema.value) !== SCHEMA_VERSION;
}

/** sessions 是变化最频繁的表；它的关键列缺任何一个都说明结构与当前代码不匹配。 */
const REQUIRED_SESSION_COLUMNS = ['content_scope', 'parent_session_id', 'artifact_path', 'source'];

function hasExpectedColumns(db) {
  let cols;
  try {
    cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  } catch {
    return true; // 查不到就当作需要由 DDL 创建
  }
  if (!cols.length) return true;
  return REQUIRED_SESSION_COLUMNS.every((c) => cols.includes(c));
}

/** 索引库只是各源的派生视图，不是事实来源，因此版本不符直接整库重建。 */
function dropAll(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.exec('PRAGMA foreign_keys = ON');
}

const TABLES = ['messages_fts', 'messages', 'agent_edges', 'sessions', 'projects', 'artifacts', 'meta'];

class Store {
  constructor(db) {
    this.db = db;
    this.stmt = {
      getArtifact: db.prepare('SELECT * FROM artifacts WHERE path = ?'),
      upsertArtifact: db.prepare(`
        INSERT INTO artifacts(path, source, session_id, bytes, mtime, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          session_id = excluded.session_id, bytes = excluded.bytes,
          mtime = excluded.mtime, ingested_at = excluded.ingested_at`),
      upsertProject: db.prepare(`
        INSERT INTO projects(id, cwd_key, cwd, name, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`),
      upsertSession: db.prepare(`
        INSERT INTO sessions(
          id, source, native_id, session_kind, content_scope, project_id, parent_session_id, agent_id,
          title, cwd, git_branch, cli_version, entrypoint, primary_model, models_json,
          started_at, last_event_at, cost_usd, tokens_in, tokens_out, tokens_cache_read,
          tokens_cache_create, tokens_thinking, artifact_path, artifact_bytes, artifact_mtime, ingested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          session_kind = excluded.session_kind, content_scope = excluded.content_scope,
          project_id = excluded.project_id,
          parent_session_id = excluded.parent_session_id, agent_id = excluded.agent_id,
          title = excluded.title, cwd = excluded.cwd, git_branch = excluded.git_branch,
          cli_version = excluded.cli_version, entrypoint = excluded.entrypoint,
          primary_model = excluded.primary_model, models_json = excluded.models_json,
          started_at = excluded.started_at, last_event_at = excluded.last_event_at,
          cost_usd = excluded.cost_usd, tokens_in = excluded.tokens_in,
          tokens_out = excluded.tokens_out, tokens_cache_read = excluded.tokens_cache_read,
          tokens_cache_create = excluded.tokens_cache_create,
          tokens_thinking = excluded.tokens_thinking, artifact_path = excluded.artifact_path,
          artifact_bytes = excluded.artifact_bytes, artifact_mtime = excluded.artifact_mtime,
          ingested_at = excluded.ingested_at`),
      insertMessage: db.prepare(`
        INSERT INTO messages(
          id, session_id, source, seq, role, kind, uuid, parent_uuid, agent_id,
          tool_name, tool_use_id, is_error, text, payload_json, model, ts,
          tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, tokens_thinking)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text, payload_json = excluded.payload_json, is_error = excluded.is_error`),
      insertFts: db.prepare(
        'INSERT INTO messages_fts(message_id, session_id, text) VALUES (?, ?, ?)',
      ),
      deleteFts: db.prepare('DELETE FROM messages_fts WHERE session_id = ?'),
      upsertEdge: db.prepare(`
        INSERT INTO agent_edges(
          id, parent_session_id, child_session_id, parent_tool_use_id,
          agent_type, description, spawn_depth, request_shape, link_method, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          parent_session_id = excluded.parent_session_id,
          parent_tool_use_id = excluded.parent_tool_use_id,
          agent_type = excluded.agent_type, description = excluded.description,
          spawn_depth = excluded.spawn_depth, request_shape = excluded.request_shape,
          link_method = excluded.link_method`),
      deleteSessionMessages: db.prepare('DELETE FROM messages WHERE session_id = ?'),
      deleteEdgesOfParent: db.prepare('DELETE FROM agent_edges WHERE parent_session_id = ?'),
      deleteEdgesOfChild: db.prepare('DELETE FROM agent_edges WHERE child_session_id = ?'),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getArtifact(path) {
    return this.stmt.getArtifact.get(path) ?? null;
  }

  saveArtifact(path, source, sessionId, bytes, mtime) {
    this.stmt.upsertArtifact.run(path, source, sessionId, bytes, mtime, Date.now());
  }

  /**
   * 清除一个会话的正文与「以它为子」的派生边。
   * 重采策略是「先删后插」而不是增量追加：seq 取记录在源文件中的位置，
   * 因此重采同一文件的结果完全一致（幂等）。代价是文件变更时要重读整个文件，
   * 但源文件量级在百 KB 到 MB，这个代价换来的是「不会写出重复或错序的消息」。
   *
   * 刻意不在这里删「以本会话为父」的边：边的归属者是**子**会话 ——
   * 重采子会话时它自己会把边写回来；而重采父会话时，它的子代理这一轮往往
   * 指纹未变、直接跳过，那些边不会被任何人重建，删掉就是永久丢失。
   * 父角色的边何时该清，由采集器判断（见 collector.js）或 deleteSession 负责。
   */
  resetSessionMessages(sessionId) {
    this.stmt.deleteSessionMessages.run(sessionId);
    this.stmt.deleteFts.run(sessionId);
    this.stmt.deleteEdgesOfChild.run(sessionId);
  }

  /** 单独清掉「以本会话为父」的边，供「本会话是父边所有者」的重采路径使用。 */
  deleteParentEdges(sessionId) {
    this.stmt.deleteEdgesOfParent.run(sessionId);
  }

  /** 彻底移除一个会话（消息、FTS、派生边、会话行、采集记录）。 */
  deleteSession(sessionId) {
    this.resetSessionMessages(sessionId);
    // 会话没了，它作为父的那些边也必须一起走，否则关系图上会留下指向空气的箭头。
    this.stmt.deleteEdgesOfParent.run(sessionId);
    this.db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  saveProject(cwd) {
    const key = normalizePathKey(cwd);
    if (!key) return null;
    const id = `cwd:${key}`;
    const now = Date.now();
    const name = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? cwd;
    this.stmt.upsertProject.run(id, key, cwd, name, now, now);
    return id;
  }

  saveSession(s) {
    this.stmt.upsertSession.run(
      s.id, s.source, s.nativeId, s.sessionKind, s.contentScope ?? 'full',
      s.projectId, s.parentSessionId, s.agentId,
      s.title, s.cwd, s.gitBranch, s.cliVersion, s.entrypoint, s.primaryModel,
      JSON.stringify(s.models ?? []), s.startedAt, s.lastEventAt, s.costUsd,
      s.tokensIn, s.tokensOut, s.tokensCacheRead, s.tokensCacheCreate, s.tokensThinking,
      s.artifactPath, s.artifactBytes, s.artifactMtime, Date.now(),
    );
  }

  /** 写入消息。seq 由适配器按源文件中的记录位置提供，保证重采结果幂等。 */
  appendMessages(sessionId, messages, { searchable = true } = {}) {
    for (const m of messages) {
      this.stmt.insertMessage.run(
        m.id, m.sessionId, m.source, m.seq, m.role, m.kind, m.uuid, m.parentUuid, m.agentId,
        m.toolName, m.toolUseId, m.isError === null || m.isError === undefined ? null : m.isError ? 1 : 0,
        m.text, m.payload ? JSON.stringify(m.payload) : null, m.model, m.ts,
        m.tokensIn, m.tokensOut, m.tokensCacheRead, m.tokensCacheCreate, m.tokensThinking,
      );
      if (searchable && m.text) this.stmt.insertFts.run(m.id, m.sessionId, m.text);
    }
  }

  saveEdge(e) {
    this.stmt.upsertEdge.run(
      e.id, e.parentSessionId, e.childSessionId, e.parentToolUseId,
      e.agentType, e.description, e.spawnDepth, e.requestShape, e.linkMethod ?? null, Date.now(),
    );
  }

  /**
   * 找出持有某个 tool_use_id 的会话 —— 用于把子代理挂回父会话。
   * 这是确定性的回指，不是启发式猜测。
   * 必须限定 source：tool_use_id 只在一个源内部才有意义，
   * 不同源的 id 一旦撞车，会把父关系挂到别的 Agent 的会话上。
   */
  findSessionByToolUseId(toolUseId, source) {
    const row = this.db
      .prepare('SELECT session_id FROM messages WHERE tool_use_id = ? AND source = ? LIMIT 1')
      .get(toolUseId, source);
    return row?.session_id ?? null;
  }

  /**
   * 供「任务完成提醒」使用：能看到正文、且有时间戳的会话，连同它的最后活动时间。
   * 只要 content_scope = 'full' 的 —— 只有这类会话拿得到 Agent 的产出正文，
   * 对 user-prompts / metadata-only 报「完成」是在编。
   */
  listCompletionCandidates() {
    return this.db
      .prepare(`SELECT id, source, title, last_event_at AS lastAt
                FROM sessions
                WHERE content_scope = 'full' AND last_event_at IS NOT NULL`)
      .all();
  }

  stats() {
    const one = (sql, ...p) => this.db.prepare(sql).get(...p);
    return {
      modelVersion: MODEL_VERSION,
      sessions: one('SELECT COUNT(*) c FROM sessions').c,
      mainSessions: one("SELECT COUNT(*) c FROM sessions WHERE session_kind = 'main'").c,
      subagentSessions: one("SELECT COUNT(*) c FROM sessions WHERE session_kind <> 'main'").c,
      messages: one('SELECT COUNT(*) c FROM messages').c,
      toolCalls: one("SELECT COUNT(*) c FROM messages WHERE kind = 'tool_use'").c,
      agentEdges: one('SELECT COUNT(*) c FROM agent_edges').c,
      projects: one('SELECT COUNT(*) c FROM projects').c,
      sources: this.db
        .prepare('SELECT source, COUNT(*) sessions FROM sessions GROUP BY source ORDER BY sessions DESC')
        .all(),
    };
  }

  listSessions({ source, projectId, kind, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (source) { where.push('s.source = ?'); params.push(source); }
    if (projectId) { where.push('s.project_id = ?'); params.push(projectId); }
    if (kind) { where.push('s.session_kind = ?'); params.push(kind); }
    const sql = `
      SELECT s.id, s.source, s.native_id, s.session_kind, s.content_scope, s.project_id, s.parent_session_id,
             s.agent_id, s.title, s.cwd, s.git_branch, s.primary_model, s.started_at,
             s.last_event_at, s.cost_usd, s.tokens_in, s.tokens_out, s.tokens_cache_read,
             p.name AS project_name,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.kind = 'tool_use') AS tool_call_count,
             (SELECT COUNT(*) FROM agent_edges e WHERE e.parent_session_id = s.id) AS child_count
      FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.last_event_at DESC NULLS LAST
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset);
    const now = Date.now();
    return rows.map((r) => ({ ...r, activity: activityOf(r.last_event_at, now) }));
  }

  getSession(id) {
    const row = this.db
      .prepare(`SELECT s.*, p.name AS project_name,
                       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.kind = 'tool_use') AS tool_call_count
                FROM sessions s
                LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`)
      .get(id);
    if (!row) return null;
    const children = this.db
      .prepare(`SELECT e.*, c.title AS child_title, c.session_kind AS child_kind,
                       c.last_event_at AS child_last_event_at
                FROM agent_edges e LEFT JOIN sessions c ON c.id = e.child_session_id
                WHERE e.parent_session_id = ? ORDER BY e.created_at`)
      .all(id);
    // 指向本会话的那条派生边。代理会话靠它才能说清「我是被谁、以什么方式派生的」——
    // 54 个工作流代理的标题完全相同，没有这个就没法区分它们。
    const spawnEdge = this.db
      .prepare('SELECT * FROM agent_edges WHERE child_session_id = ?')
      .get(id) ?? null;
    const parentTitle = row.parent_session_id
      ? this.db.prepare('SELECT title FROM sessions WHERE id = ?').get(row.parent_session_id)?.title ?? null
      : null;
    return {
      ...row,
      models: safeParse(row.models_json),
      activity: activityOf(row.last_event_at),
      children,
      spawnEdge,
      parentTitle,
    };
  }

  /**
   * 读消息。tail 用于「当前任务」视图：那里要看的是最近发生了什么，
   * 取开头几百条毫无意义。用倒序取再翻正，避免为了拿尾部而全表扫描。
   */
  getMessages(sessionId, { limit = 200, offset = 0, kinds, tail = null } = {}) {
    const params = [sessionId];
    let filter = '';
    if (kinds?.length) {
      filter = ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (tail !== null) {
      // 加 id 做并列裁决：seq 可能重复（个别源不保证唯一），只按 seq 排会得到不稳定顺序。
      const rows = this.db
        .prepare(`SELECT * FROM messages WHERE session_id = ?${filter} ORDER BY seq DESC, id DESC LIMIT ?`)
        .all(...params, tail);
      return rows.reverse().map((r) => ({ ...r, payload: safeParse(r.payload_json) }));
    }
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ?${filter} ORDER BY seq, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return rows.map((r) => ({ ...r, payload: safeParse(r.payload_json) }));
  }

  search(query, { limit = 50, source } = {}) {
    const params = [query];
    let filter = '';
    if (source) { filter = ' AND s.source = ?'; params.push(source); }
    const sql = `
      SELECT m.id, m.session_id, m.kind, m.role, m.tool_name, m.ts,
             snippet(messages_fts, 2, '[', ']', '…', 12) AS snippet,
             s.source, s.title, s.session_kind
      FROM messages_fts f
      JOIN messages m ON m.id = f.message_id
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?${filter}
      ORDER BY m.ts DESC LIMIT ?`;
    try {
      return this.db.prepare(sql).all(...params, limit);
    } catch (err) {
      // FTS5 查询语法对用户输入敏感（例如裸引号），退化为子串匹配而不是报 500。
      const like = `%${query}%`;
      return this.db
        .prepare(`SELECT m.id, m.session_id, m.kind, m.role, m.tool_name, m.ts,
                         substr(m.text, 1, 200) AS snippet, s.source, s.title, s.session_kind
                  FROM messages m JOIN sessions s ON s.id = m.session_id
                  WHERE m.text LIKE ?${filter} ORDER BY m.ts DESC LIMIT ?`)
        .all(like, ...params.slice(1), limit);
    }
  }

  /**
   * 每个数据源的概览：会话总数、最近活跃时间，以及「当前任务」——
   * 取该源最近活跃的主会话。刻意不取子代理：子代理时间戳更新，
   * 但那是主会话派生出去的活，不是这个 Agent 在做的主线任务。
   */
  sourceOverview() {
    const totals = this.db
      .prepare(`SELECT source, COUNT(*) AS session_count,
                       MAX(last_event_at) AS last_event_at,
                       SUM(cost_usd) AS cost_usd,
                       SUM(tokens_in) AS tokens_in,
                       SUM(CASE WHEN content_scope = 'full' THEN 1 ELSE 0 END) AS full_sessions,
                       SUM(CASE WHEN content_scope = 'user-prompts' THEN 1 ELSE 0 END) AS user_prompt_sessions,
                       SUM(CASE WHEN content_scope = 'metadata-only' THEN 1 ELSE 0 END) AS metadata_only_sessions
                FROM sessions GROUP BY source`)
      .all();
    const latestMain = this.db
      .prepare(`SELECT * FROM (
                  SELECT s.*,
                         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                         (SELECT COUNT(*) FROM agent_edges e WHERE e.parent_session_id = s.id) AS child_count
                  FROM sessions s WHERE s.session_kind = 'main'
                  ORDER BY s.last_event_at DESC
                ) GROUP BY source`)
      .all();
    const bySource = new Map(totals.map((t) => [t.source, t]));
    for (const s of latestMain) {
      const t = bySource.get(s.source);
      if (t) {
        t.latest_session = { ...s, activity: activityOf(s.last_event_at) };
      }
    }
    return [...bySource.values()];
  }

  /** 项目视图：按工作目录聚合，附各源会话计数与最近活跃时间。 */
  listProjects() {
    return this.db
      .prepare(`SELECT p.id, p.cwd, p.name, p.last_seen,
                       COUNT(s.id) AS session_count,
                       MAX(s.last_event_at) AS last_event_at,
                       SUM(CASE WHEN s.source = 'claude-code' THEN 1 ELSE 0 END) AS claude_code_count
                FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
                GROUP BY p.id ORDER BY last_event_at DESC NULLS LAST`)
      .all();
  }

  toolUsage({ source, limit = 30 } = {}) {
    const params = [];
    let filter = '';
    if (source) { filter = 'WHERE m.source = ?'; params.push(source); }
    return this.db
      .prepare(`SELECT m.tool_name, COUNT(*) AS calls,
                       COUNT(DISTINCT m.session_id) AS sessions
                FROM messages m ${filter}
                ${filter ? 'AND' : 'WHERE'} m.kind = 'tool_use'
                GROUP BY m.tool_name ORDER BY calls DESC LIMIT ?`)
      .all(...params, limit);
  }

  /** 会话树：主会话 + 其派生的子代理 / 工作流代理。 */
  sessionTree(rootId) {
    const root = this.getSession(rootId);
    if (!root) return null;
    // 每层都要带上消息计数，否则关系图里每个节点都没有「多少条消息」可显示。
    const childrenOf = this.db.prepare(`
      SELECT s.*, 
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.kind = 'tool_use') AS tool_call_count
      FROM sessions s WHERE s.parent_session_id = ? ORDER BY s.started_at`);

    const nodes = [root];
    const queue = [rootId];
    const seen = new Set([rootId]);
    while (queue.length) {
      const pid = queue.shift();
      for (const child of childrenOf.all(pid)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        nodes.push(child);
        queue.push(child.id);
      }
    }
    return { root: rootId, nodes };
  }

  close() {
    this.db.close();
  }
}

function safeParse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}