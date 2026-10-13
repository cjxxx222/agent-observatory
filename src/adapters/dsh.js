/**
 * DeepSeek Harness 适配器。
 *
 * 布局（实测）：
 *   ~/.dsh/sessions/<编码后的cwd>/<sessionId>/session.v<3|4>.jsonl.zstd
 *
 * 两个坑：
 *  1. 文件不是单个 zstd 流，而是**多个 zstd 帧顺序拼接**（每次追加一个帧）。
 *     实测一个 374KB 的文件里含 135 个帧，Node 的 zstdDecompressSync 只解第一帧，
 *     结果只能拿到 186 字节。必须按魔术字切分后逐帧解压。
 *  2. 同一目录可能同时存在 v3 与 v4 文件。取版本号高的那个，保证结果确定。
 *
 * 记录是扁平的 {type, seq, time, data}。派生关系来自两个确定性字段：
 * session 记录里的 parentSession，以及 subagent/catalog 里的 childId。
 *
 * 刻意丢弃的控制面记录：permission/preset、sandbox/mode、approval/policy、
 * session/end-seed、command/run、command/done、agent/inbox/spliced、
 * turn/start、step/start、step/end、turn/end、request/header、request/context、
 * session/title-llm-request、web/deepseek-search-llm-request、model/selection。
 * 这些是编排与内部 LLM 调用留痕，不是用户与 Agent 的对话。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  SessionKind, ContentScope, MessageKind, Role,
  sessionId as makeSessionId, messageId as makeMessageId,
  emptySession, emptyMessage, emptyAgentEdge, toNumber,
} from '../model.js';

export const SOURCE = 'dsh';

const TEXT_LIMIT = 20000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const IGNORED = new Set([
  'permission/preset', 'sandbox/mode', 'approval/policy', 'session/end-seed',
  'command/run', 'command/done', 'agent/inbox/spliced',
  'turn/start', 'step/start', 'step/end', 'turn/end',
  'request/header', 'request/context', 'model/selection',
  'session/title-llm-request', 'web/deepseek-search-llm-request',
]);

/**
 * 解压「多帧拼接」的 zstd 文件。
 * 按魔术字切分逐帧解，失败的分片直接跳过（魔术字理论上可能出现在压缩数据内部，
 * 那种分片解不开，跳过即可，不影响其余帧）。
 */
export function decompressFrames(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { offsets.push(i); i += 1; }
  if (!offsets.length) {
    // 不是 zstd（或只有一帧且没有前缀），退回整段解压。
    try { return zstdDecompressSync(buf).toString('utf8'); } catch { return ''; }
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k], end))); } catch { /* 假分裂 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

export function discover(dshHome) {
  const sessionsDir = join(dshHome, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  const out = [];
  for (const projectDir of safeDirs(sessionsDir)) {
    const projectPath = join(sessionsDir, projectDir);
    for (const sessionDir of safeDirs(projectPath)) {
      // 同一会话目录里可能同时有 v3 和 v4，取版本号最高的那个。
      const files = safeEntries(join(projectPath, sessionDir))
        .filter((e) => e.isFile() && /^session\.v(\d+)\.jsonl\.zstd$/.test(e.name))
        .map((e) => ({ name: e.name, version: Number(e.name.match(/^session\.v(\d+)\./)[1]) }));
      if (!files.length) continue;
      files.sort((a, b) => b.version - a.version);
      out.push({
        path: join(projectPath, sessionDir, files[0].name),
        dirName: sessionDir,
        version: files[0].version,
        sessionKind: SessionKind.Main,
        parentNativeId: null,
        agentId: null,
        metaPath: null,
      });
    }
  }
  return out;
}

export function fingerprint(path) {
  const st = statSync(path);
  return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
}

export function parse(artifact) {
  const raw = decompressFrames(readFileSync(artifact.path));
  const lines = raw.split('\n').filter((l) => l.trim());

  let nativeId = artifact.dirName;
  const session = emptySession();
  session.source = SOURCE;
  session.sessionKind = SessionKind.Main;
  session.contentScope = ContentScope.Full;
  session.artifactPath = artifact.path;

  const messages = [];
  const models = new Set();
  const edges = [];
  let startedAt = null;
  let lastEventAt = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let sawUsage = false;
  let firstUserText = null;

  for (let i = 0; i < lines.length; i += 1) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const type = rec.type;
    const ts = toNumber(rec.time);

    if (type === 'session') {
      // 注意：session 记录是**扁平**的（id/cwd/origin 直接挂顶层），
      // 其余记录才包在 data 里。按 rec.data 读会把 cwd 与 parentSession 全丢掉。
      const d = rec.data ?? rec;
      nativeId = d.id ?? artifact.dirName;
      session.cwd = d.cwd ?? null;
      session.startedAt = toNumber(d.createdAt);
      session.agentId = d.origin === 'subagent' ? (d.id ?? null) : null;
      session.sessionKind = d.origin === 'subagent' ? SessionKind.Subagent : SessionKind.Main;
      session.parentNativeId = d.parentSession ?? null;
      session.agentPreset = d.agentPreset ?? null;
      session.delegationDepth = toNumber(d.delegationDepth);
      continue;
    }
    if (ts !== null) {
      startedAt = startedAt === null ? ts : Math.min(startedAt, ts);
      lastEventAt = lastEventAt === null ? ts : Math.max(lastEventAt, ts);
    }
    if (IGNORED.has(type)) continue;

    if (type === 'session/title') {
      // 源的标题里偶尔会混进内联思考（实测出现过 " thinking We need to generat…"），
      // 直接拿去当标题会很难看，这里顺手剥掉。
      const raw = rec.data?.title;
      if (raw) {
        // 源的第二条 session/title 是 LLM 生成的，实测有时整条就是一段思考
        // （类似 " thinkingWe need to generate a title..."）。这种情况留空，
        // 让下面的「首个用户提问」兜底 —— 把思考正文当标题比没有标题更糟。
        const s = splitInlineThinking(raw);
        if (s.text) session.title = s.text;
      }
      continue;
    }
    if (type === 'subagent/catalog') {
      const d = rec.data ?? {};
      if (d.childId) {
        const edge = emptyAgentEdge();
        // catalog 记录出现在**父会话自己的文件里**，所以父就是当前会话 ——
        // 取 session.parentSessionId（当前会话的父）会指向错误的对象，边也就写不进库。
        edge.parentSessionId = makeSessionId(SOURCE, nativeId);
        edge.id = `${edge.parentSessionId}#spawn#${d.childId}`;
        edge.childSessionId = makeSessionId(SOURCE, d.childId);
        edge.parentToolUseId = null;
        edge.agentType = 'subagent';
        edge.description = d.label ?? null;
        edge.spawnDepth = null;
        edge.linkMethod = 'parent_session_field';
        edges.push(edge);
      }
      continue;
    }

    if (type === 'system/message') {
      const text = blocksToText(rec.data?.message?.content);
      if (!text) continue;
      messages.push({
        ...emptyMessage(),
        id: makeMessageId(SOURCE, nativeId, `sys${i}`),
        sessionId: makeSessionId(SOURCE, nativeId),
        source: SOURCE,
        seq: i,
        role: Role.System,
        kind: MessageKind.System,
        text: clip(text),
        ts,
      });
      continue;
    }

    if (type === 'user/message') {
      const d = rec.data ?? {};
      const text = blocksToText(d.content);
      if (!text) continue;
      firstUserText ??= text;
      messages.push({
        ...emptyMessage(),
        id: makeMessageId(SOURCE, nativeId, d.id ?? `u${i}`),
        sessionId: makeSessionId(SOURCE, nativeId),
        source: SOURCE,
        seq: i,
        uuid: d.id ?? null,
        role: Role.User,
        kind: MessageKind.Text,
        text: clip(text),
        ts,
      });
      continue;
    }

    if (type === 'assistant/message') {
      const d = rec.data ?? {};
      const msg = d.message ?? {};
      const model = msg.source?.model ?? null;
      if (model) models.add(model);
      const usage = d.usage ?? {};
      const inTok = toNumber(usage.inputTokens);
      const outTok = toNumber(usage.outputTokens);
      if (inTok !== null || outTok !== null) {
        sawUsage = true;
        tokensIn += inTok ?? 0;
        tokensOut += outTok ?? 0;
      }
      // DSH 把思考内联在正文里（"......"），不是独立块，需要自己拆。
      const { thinking, text } = splitInlineThinking(blocksToText(msg.content));
      if (thinking) {
        messages.push({
          ...emptyMessage(),
          id: makeMessageId(SOURCE, nativeId, `${msg.id ?? `a${i}`}:think`),
          sessionId: makeSessionId(SOURCE, nativeId),
          source: SOURCE,
          seq: i,
          role: Role.Assistant,
          kind: MessageKind.Thinking,
          text: clip(thinking),
          model,
          ts,
        });
      }
      if (text) {
        messages.push({
          ...emptyMessage(),
          id: makeMessageId(SOURCE, nativeId, msg.id ?? `a${i}`),
          sessionId: makeSessionId(SOURCE, nativeId),
          source: SOURCE,
          seq: i,
          uuid: msg.id ?? null,
          role: Role.Assistant,
          kind: MessageKind.Text,
          text: clip(text),
          model,
          tokensIn: inTok,
          tokensOut: outTok,
          ts,
        });
      }
      continue;
    }

    if (type === 'tool/call') {
      const d = rec.data ?? {};
      let args = null;
      if (typeof d.arguments === 'string') {
        try { args = JSON.parse(d.arguments); } catch { args = null; }
      } else if (d.arguments && typeof d.arguments === 'object') {
        args = d.arguments;
      }
      messages.push({
        ...emptyMessage(),
        id: makeMessageId(SOURCE, nativeId, `call${d.callId ?? i}`),
        sessionId: makeSessionId(SOURCE, nativeId),
        source: SOURCE,
        seq: i,
        role: Role.Assistant,
        kind: MessageKind.ToolUse,
        toolName: d.name ?? null,
        toolUseId: d.callId ?? null,
        text: summarizeToolInput(d.name, args),
        payload: args,
        ts,
      });
      continue;
    }

    if (type === 'tool/result') {
      const d = rec.data ?? {};
      const msg = d.message ?? {};
      const text = blocksToText(msg.content);
      messages.push({
        ...emptyMessage(),
        id: makeMessageId(SOURCE, nativeId, `result${d.toolCallId ?? i}`),
        sessionId: makeSessionId(SOURCE, nativeId),
        source: SOURCE,
        seq: i,
        role: Role.Tool,
        kind: MessageKind.ToolResult,
        toolUseId: d.toolCallId ?? null,
        isError: msg.isError === true,
        text: clip(text),
        ts,
      });
    }
  }

  session.id = makeSessionId(SOURCE, nativeId);
  session.nativeId = nativeId;
  // parentNativeId 是在解析 session 记录时拿到的，这里补成全局 id。
  session.parentNativeId = session.parentNativeId ?? null;
  session.title ??= firstUserText ? firstUserText.replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  session.models = [...models];
  session.primaryModel = [...models][0] ?? null;
  session.startedAt ??= startedAt;
  session.lastEventAt = lastEventAt ?? session.startedAt;
  session.tokensIn = sawUsage ? tokensIn : null;
  session.tokensOut = sawUsage ? tokensOut : null;
  session.costUsd = null; // DSH 本地不记录成本

  return { session, messages, edges };
}

/** 从 agent-*.meta.json 无对应物：DSH 的父子关系在会话记录与 catalog 里，不需额外文件。 */
export function parseEdge() {
  return null;
}

// ---------------------------------------------------------------------------

/** 把内联的  thinking… 拆成思考与正文两段。 */
function splitInlineThinking(text) {
  if (!text) return { thinking: null, text: null };
  const blocks = [];
  let rest = text;
  const re = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/i;
  let m;
  while ((m = re.exec(rest))) {
    blocks.push(m[1]);
    rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
  }
  return {
    thinking: blocks.join('\n').trim() || null,
    text: rest.trim() || null,
  };
}

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b?.type === 'text' && b.text) parts.push(b.text);
    else if (b?.type === 'image') parts.push('[图片]');
  }
  return parts.length ? parts.join('\n') : null;
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return name ?? null;
  const first = input.command ?? input.file_path ?? input.path ?? input.query
    ?? input.pattern ?? input.url ?? null;
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