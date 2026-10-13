/**
 * Trae CN 适配器（部分接入）。
 *
 * 数据源：`%APPDATA%\Trae CN\User\workspaceStorage\<hash>\`
 *   workspace.json   工作区真实路径（URI 编码的 file:// 形式）
 *   state.vscdb      VS Code 的 KV 存储（单表 ItemTable）
 *
 * 能读到什么（已逐项核实）：
 *   icube-ai-agent-storage-input-history  用户自己的提问历史 —— 有内容
 * 读不到什么：
 *   ChatStore                             只是气泡高度等 UI 状态
 *   chat.ChatSessionStore.index           值是 {"version":1,"entries":{}} —— 空的
 *   chatQueryCompletion.v2.*              短小的补全缓存
 *   模型回复 / 工具调用                     本地不存在，只在云端
 *
 * 因此这里把「一个工作区的提问历史」建模成一个会话，contentScope 标为 user-prompts。
 * 看板上必须能看出这是「只有你的提问，没有 Agent 的回复」——
 * 否则用户会以为 Trae CN 在这里没干过活。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SessionKind, ContentScope, MessageKind, Role,
  sessionId as makeSessionId, messageId as makeMessageId,
  emptySession, emptyMessage,
} from '../model.js';

export const SOURCE = 'trae-cn';

const INPUT_HISTORY_KEY = 'icube-ai-agent-storage-input-history';
const MAX_PROMPTS = 200;

/**
 * traeRoot 由 collector 传入（AppData\Roaming\Trae CN）。
 * 这些数据挂在 %APPDATA% 而不是用户主目录下，与其余源不同。
 */
export function discover(traeRoot) {
  const wsRoot = join(traeRoot, 'User', 'workspaceStorage');
  if (!existsSync(wsRoot)) return [];
  const out = [];
  for (const dir of safeDirs(wsRoot)) {
    const dbPath = join(wsRoot, dir, 'state.vscdb');
    if (!existsSync(dbPath)) continue;
    out.push({
      path: dbPath,
      nativeSessionId: dir,
      sessionKind: SessionKind.Main,
      parentNativeId: null,
      agentId: null,
      metaPath: join(wsRoot, dir, 'workspace.json'),
    });
  }
  return out;
}

export function fingerprint(path) {
  const st = statSync(path);
  return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
}

export function parse(artifact) {
  const session = emptySession();
  session.id = makeSessionId(SOURCE, artifact.nativeSessionId);
  session.source = SOURCE;
  session.nativeId = artifact.nativeSessionId;
  session.sessionKind = SessionKind.Main;
  session.contentScope = ContentScope.UserPromptsOnly;
  session.artifactPath = artifact.path;
  session.title = null;
  session.primaryModel = null;
  session.models = [];
  session.costUsd = null;
  session.tokensIn = null;
  session.tokensOut = null;

  // 工作区真实路径
  const ws = readWorkspaceFolder(artifact.metaPath);
  session.cwd = ws.folder;
  session.entrypoint = ws.kind;

  const messages = [];
  const prompts = readInputHistory(artifact.path);
  prompts.forEach((text, i) => {
    messages.push({
      ...emptyMessage(),
      id: makeMessageId(SOURCE, session.nativeId, `prompt${i}`),
      sessionId: session.id,
      source: SOURCE,
      seq: i,
      role: Role.User,
      kind: MessageKind.Text,
      text,
      ts: null, // 源不记录时间戳，不编
    });
  });

  if (messages.length) {
    session.title = messages[0].text.replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  }
  /*
   * 源不记录任何消息时间戳，所以 startedAt 只能留 null —— 不知道该从何时算起。
   * 但 state.vscdb 的 mtime 是一个**真实存在**的事实：它给出「这个工作区最后一次被写入」
   * 的时间。用它兜底 lastEventAt 好过全 null —— 全 null 会让界面上的「最近活动」退化成
   * 任意顺序，看不出哪个工作区最近在动。它是上界而非精确提问时间，故只用于 lastEventAt。
   */
  session.startedAt = null;
  session.lastEventAt = mtimeMs(artifact.path);

  return { session, messages };
}

/** Trae CN 本地没有任何父子关系信息。 */
export function parseEdge() {
  return null;
}

// ---------------------------------------------------------------------------

function readWorkspaceFolder(metaPath) {
  if (!metaPath || !existsSync(metaPath)) return { folder: null, kind: null };
  try {
    const j = JSON.parse(readFileSync(metaPath, 'utf8'));
    const raw = j.folder ?? j.workspace ?? null;
    if (!raw) return { folder: null, kind: null };
    return {
      folder: uriToPath(raw),
      kind: j.folder ? 'folder' : 'workspace-file',
    };
  } catch {
    return { folder: null, kind: null };
  }
}

/** "file:///d%3A/%E6%AC%A7%E6%98%93app" → "d:\欧易app" */
function uriToPath(uri) {
  try {
    const u = new URL(uri);
    const decoded = decodeURIComponent(u.pathname);
    // Windows 上 pathname 形如 /d:/欧易app，去掉前导斜杠并把盘符归一化。
    const p = decoded.replace(/^\//, '');
    return /^[a-zA-Z]:/.test(p) ? p.replace(/\//g, '\\') : decoded;
  } catch {
    return null;
  }
}

function readInputHistory(dbPath) {
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return []; }
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(INPUT_HISTORY_KEY);
    if (!row?.value) return [];
    const arr = JSON.parse(String(row.value));
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    /*
     * 源里是**最早的在最前**（时间正序），不是倒序 —— 之前那句「按时间倒序存的」注释写反了，
     * 那个 reverse() 会把顺序翻成「最新在前」，于是 messages[0] 成了最后一句提问，
     * 标题也就取错了（实测：标题取到的是最近一次提问）。
     * 只保留最近 MAX_PROMPTS 条，仍保持时间正序。
     */
    const recent = arr.length > MAX_PROMPTS ? arr.slice(-MAX_PROMPTS) : arr;
    for (const item of recent) {
      const text = typeof item?.inputText === 'string' ? item.inputText.trim() : '';
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text.length > 20000 ? `${text.slice(0, 20000)}\n…[已截断]` : text);
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 文件 mtime（epoch ms）；读不到就返回 null，不用 0 冒充。 */
function mtimeMs(p) {
  try { return Math.floor(statSync(p).mtimeMs); } catch { return null; }
}

function safeDirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}