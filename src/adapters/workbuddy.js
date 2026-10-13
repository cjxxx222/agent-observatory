/**
 * WorkBuddy 适配器。
 *
 * 布局（实测）：
 *   ~/.workbuddy/projects/<编码后的cwd>/<sessionId>.jsonl      ← 会话正文
 *   ~/.workbuddy/projects/<编码后的cwd>/<sessionId>.file-rollback.ndjson
 *
 * 注意：`~/.workbuddy/sessions/*.json` 只是进程心跳注册表（pid / endpoint），
 * `workbuddy.db` 的 sessions 表只有会话元数据（18 行），**消息正文都不在那里**。
 * 正文就是上面这个 jsonl。目录名是编码过的路径，但记录里带 cwd，不需要去解码目录名。
 *
 * 记录类型：session-meta / message / reasoning / function_call /
 * function_call_result / ai-title / file-history-snapshot。
 * file-history-snapshot 是文件快照账本，不进消息流。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SessionKind, ContentScope, MessageKind, Role,
  sessionId as makeSessionId, messageId as makeMessageId,
  emptySession, emptyMessage, toNumber,
} from '../model.js';

export const SOURCE = 'workbuddy';

const TEXT_LIMIT = 20000;

/**
 * discover 会顺带读一次 workbuddy.db 的 sessions 表。
 * 原因：jsonl 里只有 2/18 个文件带了 cwd，而数据库 18/18 都有 ——
 * 目录、标题、模型这些元数据必须从库里补，否则 16 个会话会显示「目录未知」。
 */
export function discover(wbHome) {
  const projectsDir = join(wbHome, 'projects');
  if (!existsSync(projectsDir)) return [];
  const meta = readSessionMeta(join(wbHome, 'workbuddy.db'));

  const out = [];
  for (const projectDir of safeDirs(projectsDir)) {
    const projectPath = join(projectsDir, projectDir);
    for (const entry of safeEntries(projectPath)) {
      // 只用正文 jsonl；.file-rollback.ndjson 是回滚账本，不是对话。
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (entry.name.includes('.file-rollback.')) continue;
      const nativeSessionId = basename(entry.name, '.jsonl');
      out.push({
        path: join(projectPath, entry.name),
        nativeSessionId,
        sessionKind: SessionKind.Main,
        parentNativeId: null,
        agentId: null,
        metaPath: null,
        record: meta.get(nativeSessionId) ?? null,
      });
    }
  }
  return out;
}

function readSessionMeta(dbPath) {
  const map = new Map();
  if (!existsSync(dbPath)) return map;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return map; }
  try {
    for (const r of db.prepare(
      'SELECT id, cwd, title, custom_title, model, status, created_at, updated_at, last_activity_at FROM sessions',
    ).all()) {
      map.set(r.id, r);
    }
  } catch { /* 表结构变化时退回纯文件解析 */ } finally {
    db.close();
  }
  return map;
}

export function fingerprint(path) {
  const st = statSync(path);
  return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
}

export function parse(artifact) {
  const lines = readFileSync(artifact.path, 'utf8').split('\n').filter((l) => l.trim());
  const meta = artifact.record ?? {};

  const session = emptySession();
  session.id = makeSessionId(SOURCE, artifact.nativeSessionId);
  session.source = SOURCE;
  session.nativeId = artifact.nativeSessionId;
  session.sessionKind = SessionKind.Main;
  session.contentScope = ContentScope.Full;
  session.artifactPath = artifact.path;

  // 数据库是元数据的事实来源；文件记录只做补充。
  session.cwd = meta.cwd ?? null;
  session.startedAt = toNumber(meta.created_at);
  session.lastEventAt = toNumber(meta.last_activity_at ?? meta.updated_at);
  if (meta.custom_title || meta.title) session.title = meta.custom_title || meta.title;
  // 库里的 model 常常是 "auto"（用户选了自动），那不是模型名，不能当模型显示。
  const dbModel = meta.model && meta.model !== 'auto' ? meta.model : null;
  if (dbModel) session.primaryModel = dbModel;

  const messages = [];
  const models = new Set();
  if (dbModel) models.add(dbModel);
  let startedAt = null;
  let lastEventAt = null;
  let firstUserText = null;
  let firstModel = null;

  for (let i = 0; i < lines.length; i += 1) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const ts = toNumber(rec.timestamp);
    if (ts !== null) {
      startedAt = startedAt === null ? ts : Math.min(startedAt, ts);
      lastEventAt = lastEventAt === null ? ts : Math.max(lastEventAt, ts);
    }
    if (rec.cwd) session.cwd ??= rec.cwd;
    if (rec.sessionId) session.nativeId = rec.sessionId;

    switch (rec.type) {
      case 'custom-title':
        // 用户手改的标题优先于 ai-title。
        if (rec.customTitle) session.title = rec.customTitle;
        break;

      case 'ai-title':
        if (rec.aiTitle && !session.title) session.title = rec.aiTitle;
        break;

      case 'message': {
        const who = rec.role === 'user' ? Role.User : Role.Assistant;
        const text = contentToText(rec.content);
        if (!text) break;
        if (who === Role.User) firstUserText ??= text;
        const model = rec.providerData?.model ?? null;
        if (model && who === Role.Assistant) { models.add(model); firstModel ??= model; }
        messages.push({
          ...emptyMessage(),
          id: makeMessageId(SOURCE, session.nativeId, rec.id ?? `m${i}`),
          sessionId: session.id,
          source: SOURCE,
          seq: i,
          uuid: rec.id ?? null,
          role: who,
          kind: MessageKind.Text,
          model,
          text: clip(text),
          ts,
        });
        break;
      }

      case 'reasoning': {
        const text = contentToText(rec.rawContent) ?? contentToText(rec.content);
        if (!text) break;
        const model = rec.providerData?.model ?? null;
        if (model) models.add(model);
        messages.push({
          ...emptyMessage(),
          id: makeMessageId(SOURCE, session.nativeId, `${rec.id ?? `r${i}`}:think`),
          sessionId: session.id,
          source: SOURCE,
          seq: i,
          uuid: rec.id ?? null,
          parentUuid: rec.parentId ?? null,
          role: Role.Assistant,
          kind: MessageKind.Thinking,
          model,
          text: clip(text),
          ts,
        });
        break;
      }

      case 'function_call': {
        let args = null;
        if (typeof rec.arguments === 'string') {
          try { args = JSON.parse(rec.arguments); } catch { args = null; }
        } else if (rec.arguments && typeof rec.arguments === 'object') {
          args = rec.arguments;
        }
        messages.push({
          ...emptyMessage(),
          id: makeMessageId(SOURCE, session.nativeId, `call${rec.callId ?? rec.id ?? i}`),
          sessionId: session.id,
          source: SOURCE,
          seq: i,
          uuid: rec.id ?? null,
          parentUuid: rec.parentId ?? null,
          role: Role.Assistant,
          kind: MessageKind.ToolUse,
          toolName: rec.name ?? null,
          toolUseId: rec.callId ?? null,
          text: summarizeToolInput(rec.name, args),
          payload: args,
          ts,
        });
        break;
      }

      case 'function_call_result': {
        messages.push({
          ...emptyMessage(),
          id: makeMessageId(SOURCE, session.nativeId, `result${rec.callId ?? rec.id ?? i}`),
          sessionId: session.id,
          source: SOURCE,
          seq: i,
          uuid: rec.id ?? null,
          parentUuid: rec.parentId ?? null,
          role: Role.Tool,
          kind: MessageKind.ToolResult,
          toolName: rec.name ?? null,
          toolUseId: rec.callId ?? null,
          // status 是 'completed' / 'failed' 之类的枚举，只有明确的失败才算错误。
          isError: rec.status ? /fail|error|cancel/i.test(String(rec.status)) : null,
          text: clip(contentToText(rec.output)),
          ts,
        });
        break;
      }

      default:
        // session-meta / file-history-snapshot 及未知类型不进消息流。
        // 未知类型不做静默丢弃：留一条薄记录以便后续识别新增类型。
        if (rec.type && !KNOWN_SKIP.has(rec.type)) {
          messages.push({
            ...emptyMessage(),
            id: makeMessageId(SOURCE, session.nativeId, `unknown${i}`),
            sessionId: session.id,
            source: SOURCE,
            seq: i,
            role: Role.System,
            kind: MessageKind.System,
            payload: { unknownRecordType: rec.type },
            ts,
          });
        }
    }
  }

  session.title ??= firstUserText ? firstUserText.replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  session.models = [...models];
  // 记录里的模型比库里的 "auto" 更具体，有就用它覆盖。
  session.primaryModel = firstModel ?? session.primaryModel;
  // 库里已有 created_at/updated_at 时以库为准，文件时间只做兜底。
  session.startedAt ??= startedAt;
  const fromFile = lastEventAt ?? 0;
  session.lastEventAt = Math.max(session.lastEventAt ?? 0, fromFile) || null;
  // WorkBuddy 本地没有成本与 token 记录，保持 null 而不是 0。
  session.costUsd = null;
  session.tokensIn = null;
  session.tokensOut = null;

  return { session, messages };
}

/** WorkBuddy 的父子关系在数据库里（workbuddy.db），不在文件里，P1 不解析。 */
export function parseEdge() {
  return null;
}

// ---------------------------------------------------------------------------

const KNOWN_SKIP = new Set(['session-meta', 'file-history-snapshot', 'custom-title', 'ai-title']);

/** WorkBuddy 的 content 块类型有 input_text / output_text / reasoning_text / text。 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b?.text) parts.push(b.text);
    else if (b?.type === 'image') parts.push('[图片]');
  }
  return parts.length ? parts.join('\n') : null;
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return name ?? null;
  const first = input.command ?? input.file_path ?? input.path ?? input.query
    ?? input.pattern ?? input.url ?? input.description ?? null;
  const short = typeof first === 'string' ? first.replace(/\s+/g, ' ').slice(0, 120) : null;
  return short ? `${name}: ${short}` : String(name ?? '');
}

function clip(text) {
  if (!text) return null;
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…[已截断，原文 ${text.length} 字符]` : text;
}

function safeDirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}

function safeEntries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}