/**
 * Codex 适配器。
 *
 * 两个数据源，缺一不可：
 *
 * 1) `$CODEX_HOME/state_5.sqlite`
 *      threads              会话元数据（rollout_path / cwd / title / first_user_message / 模型 / git）
 *      thread_spawn_edges   父子代理关系（parent_thread_id → child_thread_id）—— 精确，非推断
 *
 * 2) `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`（归档后移到 `archived_sessions/`）
 *      正文事实源。冷历史可能是 `.jsonl.zst`。
 *
 * rollout 行格式取自 openai/codex 源码（codex-rs/rollout 与 codex-rs/history）：
 *
 *   RolloutLine = {
 *     timestamp: string,          // RFC 3339 UTC
 *     ordinal?: uint64,           // paginated 历史的逻辑序号，legacy 无
 *     type: <snake_case>,         // 顶层记录类型
 *     payload: object,
 *     metadata?: object           // 目前仅 response_item 使用（CodexHarnessMetadata）
 *   }
 *
 *   type ∈ session_meta | response_item | compacted | turn_context | token_usage_record |
 *          world_state | inter_agent_communication(/_metadata) | retained_context |
 *          security_risk_score | event_msg | realtime_item
 *
 *   session_meta.payload 是扁平的 SessionMetaLine：
 *     { session_id, id, parent_thread_id?, cwd, originator, cli_version, source,
 *       agent_nickname?, agent_role?, git?: { commit_hash?, branch?, repository_url? } }
 *     source 的 subagent 形态形如 { subagent: "review" | { thread_spawn: { parent_thread_id, ... } } }
 *
 *   response_item.payload 是 Responses API 的 ResponseItem：
 *     message{ role, content: [{type:"input_text"|"output_text"|"input_image", ...}], id? }
 *     reasoning{ summary: [{type:"summary_text", text}], content?, id? }
 *     function_call{ name, arguments, call_id, id? }
 *     function_call_output{ call_id, output: string | ContentItem[], id? }
 *     custom_tool_call / custom_tool_call_output / local_shell_call / web_search_call / ...
 *
 *   event_msg.payload.type === "token_count" 携带累计用量 info.total_token_usage。
 *
 * 关于「本机有没有数据」：早先的注释说本机全空，那是**归因错误**。
 * 实际情况是 Codex++ 会删会话并把它备份到 `~/.codex-session-delete/backups/*.json`，
 * 所以 `state_5.sqlite` 的 threads 会归零、`sessions/` 会变空 —— 存过，只是被清掉了。
 * 解析逻辑已用一份从该备份里取回的真实 rollout（55,624 字节，2026-10-12）端到端验证：
 * session_meta / response_item 的解析、注入上下文过滤、turn_context 取模型均与真实文件吻合。
 *
 * 刻意不实现：tool_search_* / image_generation_call / compaction / context_compaction /
 * world_state / retained_context / security_risk_score / realtime_item /
 * inter_agent_communication —— 都不是「用户与 Agent 的对话」，属于内部状态或控制面。
 * （唯一例外：turn_context 只取 model 字段，它是模型名的真实来源。）
 */

import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  SessionKind, ContentScope, MessageKind, Role,
  sessionId as makeSessionId, messageId as makeMessageId,
  emptySession, emptyMessage, emptyAgentEdge, toNumber, toEpochMs,
} from '../model.js';

export const SOURCE = 'codex';

const TEXT_LIMIT = 20000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS_SUBDIR = 'sessions';
const ARCHIVED_SUBDIR = 'archived_sessions';
/** rollout-YYYY-MM-DDThh-mm-ss-<thread_id>[_<rollout_id>].jsonl[.zst] */
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+?)\.jsonl(\.zst)?$/;

export function discover(codexHome) {
  const byId = new Map();

  // 1) 文件系统上的 rollout —— 正文事实源，优先。
  //    同一个 thread 可能有多个物理 rollout（revert 的 <thread_id>_<rollout_id>、
  //    归档后又有新活动）。按「先 sessions/ 后 archived_sessions/，同目录取 mtime 最新」
  //    排序后只留第一个，保证结果确定 —— 否则谁胜出取决于 readdir 顺序与 DFS 走向。
  const found = [];
  [SESSIONS_SUBDIR, ARCHIVED_SUBDIR].forEach((sub, rootIndex) => {
    for (const f of listRolloutFiles(join(codexHome, sub))) {
      let mtime = 0;
      try { mtime = statSync(f.path).mtimeMs; } catch { /* 读不到就算了，排最后 */ }
      found.push({ ...f, rootIndex, mtime });
    }
  });
  found.sort((a, b) => (a.rootIndex - b.rootIndex) || (b.mtime - a.mtime));
  for (const f of found) {
    if (byId.has(f.nativeSessionId)) continue;
    byId.set(f.nativeSessionId, {
      path: f.path,
      nativeSessionId: f.nativeSessionId,
      sessionKind: SessionKind.Main,
      parentNativeId: null,
      agentId: null,
      metaPath: null,
      record: null,
    });
  }

  // 2) state_5.sqlite 的 threads —— 元数据来源；rollout 缺失时是唯一来源。
  const dbPath = join(codexHome, 'state_5.sqlite');
  if (existsSync(dbPath)) {
    let db = null;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { db = null; }
    if (db) {
      try {
        const threads = db.prepare('SELECT * FROM threads').all();
        const edges = safeAll(db, 'SELECT * FROM thread_spawn_edges');
        const edgeByChild = new Map(edges.map((e) => [e.child_thread_id, e]));
        for (const t of threads) {
          const artifact = byId.get(t.id) ?? {
            // rollout 不存在时用这个路径占位，fingerprint 会走「不可读」分支。
            path: t.rollout_path,
            nativeSessionId: t.id,
            sessionKind: SessionKind.Main,
            parentNativeId: null,
            agentId: null,
            metaPath: null,
          };
          const spawn = edgeByChild.get(t.id) ?? null;
          artifact.record = t;
          artifact.parentNativeId = spawn?.parent_thread_id ?? null;
          artifact.agentId = t.agent_nickname ?? null;
          if (spawn) artifact.sessionKind = SessionKind.Subagent;
          byId.set(t.id, artifact);
        }
      } finally {
        db.close();
      }
    }
  }

  return [...byId.values()];
}

/**
 * 指纹：rollout 文件可能不存在（元数据模式下就是常态），
 * 此时退回用数据库里该行自身的时间戳做变更依据。
 */
export function fingerprint(path, artifact) {
  if (path && existsSync(path)) {
    const st = statSync(path);
    return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
  }
  const t = artifact?.record;
  const stamp = t ? Number(t.updated_at_ms ?? t.updated_at ?? 0) : 0;
  return { bytes: -1, mtime: Number.isFinite(stamp) ? stamp : 0 };
}

/** 磁盘上有 rollout 正文就先解正文，否则退回纯元数据。 */
export function parse(artifact) {
  if (artifact.path && ROLLOUT_RE.test(basename(artifact.path)) && existsSync(artifact.path)) {
    return parseRollout(artifact);
  }
  return parseMetadata(artifact);
}

function parseRollout(artifact) {
  const raw = readRolloutText(artifact.path);
  const lines = raw.split('\n');

  const session = emptySession();
  session.source = SOURCE;
  session.artifactPath = artifact.path;
  session.sessionKind = artifact.sessionKind ?? SessionKind.Main;

  const drafts = [];
  let nativeId = artifact.nativeSessionId;
  let sawSessionMeta = false;
  let startedAt = null;
  let lastEventAt = null;
  let usage = null;
  let agentRole = null;
  let turnContextModel = null;
  let baseInstructionsModel = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const ts = toEpochMs(rec.timestamp);
    if (ts !== null) {
      startedAt = startedAt === null ? ts : Math.min(startedAt, ts);
      lastEventAt = lastEventAt === null ? ts : Math.max(lastEventAt, ts);
    }

    const payload = rec.payload ?? {};
    switch (rec.type) {
      case 'session_meta':
        // fork 会在后面再次写入父线程的 session_meta，只有第一条是本文件的身份页。
        if (sawSessionMeta) break;
        sawSessionMeta = true;
        applySessionMeta(session, payload, artifact);
        agentRole = payload.agent_role ?? payload.meta?.agent_role ?? agentRole;
        // base_instructions 里也带着模型名（provenance.type === 'model' 时）。
        baseInstructionsModel =
          (payload.base_instructions ?? payload.meta?.base_instructions)?.provenance?.model
          ?? baseInstructionsModel;
        nativeId = session.nativeId ?? nativeId;
        break;
      case 'turn_context':
        // turn_context 不是对话正文，但模型名就写在它的 model 字段里 ——
        // 整条丢掉会让 primaryModel 永远是 null。只取模型名，其余忽略。
        if (payload.model) turnContextModel = payload.model;
        break;
      case 'response_item': {
        const draft = responseItemToDraft(payload, i, ts);
        if (draft) drafts.push(draft);
        break;
      }
      case 'token_usage_record':
        usage = usageFrom(payload) ?? usage;
        break;
      case 'event_msg': {
        // 持久化的只是 EventMsg 的 durable 子集；token_count 是唯一我们需要的。
        // 其余（user_message / agent_message / agent_reasoning / patch_apply_end …）
        // 要么是 legacy UI replay（与 response_item 重复），要么属于控制面，一律不入库。
        if (payload.type === 'token_count') {
          const info = payload.info ?? {};
          usage = usageFrom(info.total_token_usage ?? info.last_token_usage ?? info) ?? usage;
        }
        break;
      }
      default:
        // compacted / world_state / inter_agent_* / retained_context /
        // security_risk_score / realtime_item：非对话正文，跳过。
        break;
    }
  }

  session.id = makeSessionId(SOURCE, nativeId);
  session.nativeId = nativeId;
  session.startedAt = session.startedAt ?? startedAt;
  session.lastEventAt = lastEventAt ?? session.startedAt;
  // 元数据里没有「输入/输出」的拆分，用量只在 token_count 里出现，拿不到就留 null。
  session.tokensIn = usage?.in ?? null;
  session.tokensOut = usage?.out ?? null;
  session.tokensCacheRead = usage?.cacheRead ?? null;
  // 模型名有三个来源，按可信度取：DB 行（thread 级）→ turn_context（turn 级）→ base_instructions。
  session.primaryModel = artifact.record?.model ?? turnContextModel ?? baseInstructionsModel ?? null;
  session.models = session.primaryModel ? [session.primaryModel] : [];
  if (session.cliVersion === null) session.cliVersion = artifact.record?.cli_version ?? null;

  /*
   * 标题兜底。rollout 的 session_meta 里**没有**标题字段（已核实），
   * 只读文件时 artifact.record 又是 null，于是退到第一条**真实**用户提问 ——
   * 与其余四个适配器一致。注入的环境上下文已在 responseItemToDraft 里被滤掉，
   * 不会混进来当标题。
   */
  const firstUserText = drafts.find((d) => d.role === Role.User && d.kind === MessageKind.Text)?.text ?? null;
  session.title = artifact.record?.title ?? artifact.record?.preview ?? titleFrom(firstUserText);

  const messages = drafts.map((d) => ({
    ...emptyMessage(),
    id: makeMessageId(SOURCE, nativeId, d.uuid ?? `seq${d.seq}`),
    sessionId: session.id,
    source: SOURCE,
    ...d,
  }));

  /*
   * 一份 rollout 抽不出任何消息，只有两种可能：它本身是空会话，或本解析器与该版本格式
   * 有出入。两种情况下保留元数据（至少还有身份、目录、时间）都比让采集器把它当噪声删掉更好，
   * 所以这里退回 metadata-only —— 采集器正是按这个标记免于删除。
   */
  session.contentScope = messages.length ? ContentScope.Full : ContentScope.MetadataOnly;

  /*
   * 父子关系来自子会话自己的 session_meta.parent_thread_id ——
   * 与 DSH 不同，Codex 的父 rollout 里没有「我派生了谁」的目录记录，
   * 所以这条边只能由子会话产出。
   *
   * 有 DB 行（artifact.parentNativeId 已由 thread_spawn_edges 填好）时交给下面的
   * parseEdge 产出，这里就不再发一条 —— 两条边的 id 相同，后写的会把先写的覆盖掉，
   * 反而会把 session_meta 里更准的 agent_role 丢掉。只有只读文件、没有 DB 行的子代理
   * 才走这里。
   */
  const edges = [];
  if (session.parentNativeId && !artifact.parentNativeId) {
    const edge = emptyAgentEdge();
    edge.id = `${session.id}#spawn`;
    edge.childSessionId = session.id;
    edge.parentSessionId = makeSessionId(SOURCE, session.parentNativeId);
    edge.parentToolUseId = null;
    edge.agentType = agentRole;
    edge.description = session.title ?? null;
    edge.spawnDepth = null;
    edge.linkMethod = 'session_meta_parent_thread_id';
    edges.push(edge);
  }

  return { session, messages, edges };
}

/** 只有元数据（rollout 不在磁盘上）时的退化路径。 */
function parseMetadata(artifact) {
  const t = artifact.record ?? {};
  const session = emptySession();
  session.id = makeSessionId(SOURCE, artifact.nativeSessionId);
  session.source = SOURCE;
  session.nativeId = artifact.nativeSessionId;
  session.sessionKind = artifact.sessionKind;
  session.contentScope = ContentScope.MetadataOnly;
  session.agentId = t.agent_nickname ?? artifact.agentId ?? null;
  session.title = t.title || t.preview || null;
  session.cwd = t.cwd ?? null;
  session.gitBranch = t.git_branch ?? null;
  session.cliVersion = t.cli_version ?? null;
  session.entrypoint = t.thread_source ?? (typeof t.source === 'string' ? t.source : null) ?? null;
  session.primaryModel = t.model ?? null;
  session.models = t.model ? [t.model] : [];
  session.startedAt = toNumber(t.created_at_ms ?? t.created_at);
  session.lastEventAt = toNumber(t.updated_at_ms ?? t.updated_at) ?? session.startedAt;
  session.artifactPath = artifact.path ?? null;
  // threads.tokens_used 是「输入+输出合并」的单一数值，硬塞进任一侧都是编造分布，留空。
  session.costUsd = null;
  session.tokensIn = null;
  session.tokensOut = null;

  const messages = [];
  // 首个用户消息在元数据里有留存，这是元数据模式下唯一能拿到的消息内容。
  if (t.first_user_message) {
    messages.push({
      ...emptyMessage(),
      id: makeMessageId(SOURCE, session.nativeId, 'first-user'),
      sessionId: session.id,
      source: SOURCE,
      seq: 0,
      role: Role.User,
      kind: MessageKind.Text,
      text: t.first_user_message,
      ts: session.startedAt,
    });
  }

  return { session, messages };
}

/** 把 session_meta.payload（扁平的 SessionMetaLine）写进统一会话。 */
function applySessionMeta(session, payload, artifact) {
  // 源码里 SessionMetaLine 是 `#[serde(flatten)] meta + git`；为兼容非扁平的历史写法，两种都认。
  const meta = payload.meta ?? payload;
  const git = payload.git ?? meta.git ?? {};

  session.nativeId = meta.id ?? meta.session_id ?? artifact.nativeSessionId;
  session.cwd = meta.cwd ?? null;
  session.gitBranch = git.branch ?? null;
  session.cliVersion = meta.cli_version ?? null;
  session.entrypoint = meta.originator ?? (typeof meta.source === 'string' ? meta.source : null) ?? null;
  session.agentId = meta.agent_nickname ?? session.agentId ?? null;
  session.startedAt = toEpochMs(meta.timestamp) ?? session.startedAt;

  const parentFromSource = subagentParentId(meta.source);
  session.parentNativeId = meta.parent_thread_id ?? parentFromSource ?? session.parentNativeId ?? null;
  if (session.parentNativeId || isSubagentSource(meta.source)) {
    session.sessionKind = SessionKind.Subagent;
  }
}

function isSubagentSource(source) {
  if (source === 'subagent') return true;
  return Boolean(source && typeof source === 'object' && 'subagent' in source);
}

/** 从 source.subagent.thread_spawn.parent_thread_id 取父线程 id（若存在）。 */
function subagentParentId(source) {
  if (!source || typeof source !== 'object') return null;
  const sub = source.subagent;
  if (!sub || typeof sub !== 'object') return null;
  return sub.thread_spawn?.parent_thread_id ?? null;
}

/**
 * 把一条 ResponseItem 转成消息草稿（不含 id/sessionId，等 nativeId 最终确定后再补）。
 * 返回 null 表示这条 item 不入库。
 */
function responseItemToDraft(rt, seq, ts) {
  const base = { seq, ts, uuid: rt.id ?? null };
  switch (rt.type) {
    case 'message': {
      // developer / system 是 Codex 注入的上下文（基础指令、环境上下文），不是人说的话。
      if (rt.role !== 'user' && rt.role !== 'assistant') return null;
      // Codex 把注入的环境上下文也标成 role=user 落盘（真实样本里 <environment_context>
      // 就是 role=user、528 字符）。同一条记录里的 content_item_kinds 是权威判据：
      // 真人输入是 'user.text'，注入的是 'environments.environment_context' 之类。
      if (rt.role === 'user' && !isRealUserText(rt)) return null;
      const text = contentToText(rt.content);
      if (!text) return null;
      return {
        ...base,
        role: rt.role === 'user' ? Role.User : Role.Assistant,
        kind: MessageKind.Text,
        text: clip(text),
      };
    }
    case 'agent_message': {
      const text = contentToText(rt.content);
      if (!text) return null;
      return { ...base, role: Role.Assistant, kind: MessageKind.Text, text: clip(text) };
    }
    case 'reasoning': {
      const text = reasoningToText(rt);
      if (!text) return null;
      return { ...base, role: Role.Assistant, kind: MessageKind.Thinking, text: clip(text) };
    }
    case 'function_call':
    case 'custom_tool_call': {
      const args = rt.arguments ?? rt.input ?? null;
      return {
        ...base,
        role: Role.Assistant,
        kind: MessageKind.ToolUse,
        toolName: rt.name ?? null,
        toolUseId: rt.call_id ?? null,
        text: clip(stringify(args)),
      };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      return {
        ...base,
        role: Role.Tool,
        kind: MessageKind.ToolResult,
        toolName: rt.name ?? null,
        toolUseId: rt.call_id ?? null,
        text: clip(outputToText(rt.output)),
      };
    }
    case 'local_shell_call':
      return {
        ...base,
        role: Role.Assistant,
        kind: MessageKind.ToolUse,
        toolName: 'local_shell',
        toolUseId: rt.call_id ?? rt.id ?? null,
        text: clip(stringify(rt.action ?? null)),
      };
    case 'web_search_call':
      return {
        ...base,
        role: Role.Assistant,
        kind: MessageKind.ToolUse,
        toolName: 'web_search',
        toolUseId: rt.id ?? null,
        text: clip(stringify(rt.action ?? null)),
      };
    default:
      return null;
  }
}

/** ContentItem[] → 纯文本。图片/音频项忽略（统一模型里它们不是文本消息）。 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const item of content) {
    if (item && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.length ? parts.join('\n') : null;
}

/** reasoning 的正文：summary（会落盘）与 content（reasoning_text 通常不落盘）。 */
function reasoningToText(rt) {
  const parts = [];
  for (const arr of [rt.summary, rt.content]) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item.text === 'string') parts.push(item.text);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/** function_call_output.output 允许 string 或 ContentItem[]。 */
function outputToText(output) {
  if (output === null || output === undefined) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentToText(output);
  return stringify(output);
}

function stringify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return null; }
}

/**
 * 这条 role=user 的消息是不是「人真正敲的那句话」。
 *
 * Codex 会把注入的环境上下文（<environment_context> 等）也以 role=user 落盘，
 * 但同一条记录里带 `internal_chat_message_metadata_passthrough.content_item_kinds`：
 * 真人输入是 ['user.text']，注入的是 ['environments.environment_context'] 之类。
 * 判据缺失时保守放行 —— 宁可多留一条，也不要凭猜测误杀用户的真实提问。
 */
function isRealUserText(rt) {
  const kinds = rt.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (!Array.isArray(kinds) || kinds.length === 0) return true;
  return kinds.includes('user.text');
}

/** 把首条用户提问压成单行、截到 60 字当标题（与其余四个适配器同一约定）。 */
function titleFrom(text) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().slice(0, 60) || null;
}

/** 从 token_count / token_usage_record 的载荷里取用量；取不到一律 null，不用 0 冒充。 */
function usageFrom(u) {
  if (!u || typeof u !== 'object') return null;
  const inTok = toNumber(u.input_tokens);
  const outTok = toNumber(u.output_tokens);
  const cacheRead = toNumber(u.cached_input_tokens);
  if (inTok === null && outTok === null && cacheRead === null) return null;
  return { in: inTok, out: outTok, cacheRead };
}

/**
 * 读 rollout 正文，必要时解 zstd。
 *
 * 这里**先按魔术字切帧**，不能靠 `zstdDecompressSync` 抛错来兜底：多帧输入它不抛错，
 * 只解第一帧就返回（实测 3 帧只拿到第 1 帧），那样会静默截断整段历史。
 * `dsh.js` 里踩过同一个坑，做法一致。
 */
function readRolloutText(path) {
  const buf = readFileSync(path);
  if (!path.endsWith('.zst')) return buf.toString('utf8');
  if (buf.indexOf(ZSTD_MAGIC) === -1) return buf.toString('utf8');
  return decompressFrames(buf);
}

function decompressFrames(buf) {
  const offsets = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i !== -1) { offsets.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 1); }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k], end))); } catch { /* 假分裂 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 递归找出 sessions / archived_sessions 下的 rollout 文件（目录按 YYYY/MM/DD 分层）。 */
function listRolloutFiles(root) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 6) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push([full, depth + 1]); continue; }
      const m = ROLLOUT_RE.exec(e.name);
      if (!m) continue;
      // 文件名可能是 <thread_id> 或 revert 场景的 <thread_id>_<rollout_id>，UUID 不含下划线。
      out.push({ path: full, nativeSessionId: m[1].split('_')[0] });
    }
  }
  return out;
}

/**
 * 派生关系。来自 thread_spawn_edges 或 session_meta.parent_thread_id，都是确定性回指。
 */
export function parseEdge(artifact, childSessionId) {
  if (!artifact.parentNativeId) return null;
  const edge = emptyAgentEdge();
  edge.id = `${childSessionId}#spawn`;
  edge.childSessionId = childSessionId;
  edge.parentSessionId = makeSessionId(SOURCE, artifact.parentNativeId);
  edge.parentToolUseId = null;
  edge.agentType = artifact.record?.agent_role ?? null;
  edge.description = artifact.record?.title ?? null;
  edge.spawnDepth = null;
  edge.linkMethod = artifact.record ? 'spawn_edge_table' : 'session_meta_parent_thread_id';
  return edge;
}

function clip(text) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  // 截断必须留痕：被切短的消息不能看起来跟完整的一样（与其余四个适配器同格式）。
  return s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT)}\n…[已截断，原文 ${s.length} 字符]` : s;
}

function safeAll(db, sql) {
  try { return db.prepare(sql).all(); } catch { return []; }
}