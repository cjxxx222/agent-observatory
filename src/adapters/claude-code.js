/**
 * Claude Code 适配器。
 *
 * 源目录布局（实测确认，非文档推断）：
 *   ~/.claude/projects/<编码后的cwd>/
 *     <sessionId>.jsonl                          主会话
 *     <sessionId>/subagents/agent-<id>.jsonl     子代理
 *     <sessionId>/subagents/agent-<id>.meta.json ← 含 toolUseId，回指父会话的 tool_use
 *     <sessionId>/subagents/workflows/wf_<id>/   工作流代理队列
 *     <sessionId>/workflows/wf_<id>/             同上（两个位置都出现过）
 *     <sessionId>/tool-results/                  超长工具结果溢出文件
 *
 * 刻意丢弃的记录类型：queue-operation / atis-latch / mode / file-history-snapshot /
 * file-history-delta / attachment / cost-state(转成会话聚合)。
 * 这些是控制面与提示注入噪声（单个会话里 attachment 就有 481 条），
 * 收进消息流会淹没真正的对话。丢弃是产品决策，不是遗漏。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import {
  SessionKind, MessageKind, Role, sessionId as makeSessionId, messageId as makeMessageId,
  emptySession, emptyMessage, emptyAgentEdge, toEpochMs, toNumber,
} from '../model.js';

export const SOURCE = 'claude-code';

/** 单条消息正文的存储上限，超出部分截断（超长工具结果已在 tool-results/ 另有留存）。 */
const TEXT_LIMIT = 20000;

/** 不产生消息、只用于提取元数据的记录类型。 */
const META_ONLY_TYPES = new Set([
  'ai-title', 'last-prompt', 'cost-state',
]);

/** 完全不关心的控制面记录。 */
const IGNORED_TYPES = new Set([
  'queue-operation', 'atis-latch', 'mode', 'file-history-snapshot',
  'file-history-delta', 'attachment',
]);

/**
 * 枚举所有可采集的源文件。
 * @returns {Array<{path:string, nativeSessionId:string, sessionKind:string, parentNativeId:string|null, agentId:string|null, metaPath:string|null}>}
 */
export function discover(claudeHome) {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) return [];

  const out = [];
  for (const projectDir of safeDirs(projectsDir)) {
    const projectPath = join(projectsDir, projectDir);
    for (const entry of safeEntries(projectPath)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push({
          path: join(projectPath, entry.name),
          nativeSessionId: basename(entry.name, '.jsonl'),
          sessionKind: SessionKind.Main,
          parentNativeId: null,
          agentId: null,
          metaPath: null,
        });
      }
      if (entry.isDirectory()) {
        // 会话子目录：子代理与工作流代理都在里面
        const sessionRoot = join(projectPath, entry.name);
        out.push(...discoverAgentFiles(sessionRoot, entry.name, SessionKind.Subagent));
        out.push(...discoverAgentFiles(sessionRoot, entry.name, SessionKind.WorkflowAgent));
      }
    }
  }
  return out;
}

/** 在 <sessionRoot>/subagents 与 <sessionRoot>/subagents/workflows 下收集 agent-*.jsonl。 */
function discoverAgentFiles(sessionRoot, nativeSessionId, kind) {
  const targets = [];
  const subagentsDir = join(sessionRoot, 'subagents');
  if (kind === SessionKind.Subagent) {
    targets.push(subagentsDir);
  }
  const workflowRoots = [
    join(subagentsDir, 'workflows'),
    join(sessionRoot, 'workflows'),
  ];
  if (kind === SessionKind.WorkflowAgent) {
    for (const root of workflowRoots) {
      for (const wf of safeDirs(root)) targets.push(join(root, wf));
    }
  }

  const out = [];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    for (const entry of safeEntries(dir)) {
      if (!entry.isFile() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;
      const filePath = join(dir, entry.name);
      const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
      out.push({
        path: filePath,
        nativeSessionId,
        sessionKind: kind,
        parentNativeId: nativeSessionId,
        agentId: basename(entry.name, '.jsonl').replace(/^agent-/, ''),
        metaPath: existsSync(metaPath) ? metaPath : null,
      });
    }
  }
  return out;
}

/** 读取文件的当前指纹，用于判断是否需要重采。 */
export function fingerprint(path) {
  const st = statSync(path);
  return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
}

/**
 * 解析一个会话文件，返回统一模型下的 { session, messages }。
 * 不接触索引库，纯函数，便于单独测试。
 */
export function parse(artifact) {
  const raw = readFileSync(artifact.path, 'utf8');
  const lines = raw.split('\n');

  const sid = makeSessionId(
    SOURCE,
    artifact.sessionKind === SessionKind.Main
      ? artifact.nativeSessionId
      : `${artifact.nativeSessionId}:agent:${artifact.agentId}`,
  );

  const session = emptySession();
  session.id = sid;
  session.source = SOURCE;
  session.nativeId = artifact.nativeSessionId;
  session.sessionKind = artifact.sessionKind;
  session.agentId = artifact.agentId;
  session.artifactPath = artifact.path;

  const messages = [];
  const modelCounter = new Map();
  const models = new Set();
  let startedAt = null;
  let lastEventAt = null;
  let firstUserText = null;
  let costState = null;
  let usageSum = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 };
  let sawUsage = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // 源文件可能正在写入，末尾出现半行是正常现象，跳过而不是让整次采集失败。
      continue;
    }

    const recTs = toEpochMs(rec.timestamp) ?? toEpochMs(rec.snapshot?.timestamp);
    if (recTs !== null) {
      startedAt = startedAt === null ? recTs : Math.min(startedAt, recTs);
      lastEventAt = lastEventAt === null ? recTs : Math.max(lastEventAt, recTs);
    }
    if (rec.cwd) session.cwd ??= rec.cwd;
    if (rec.gitBranch) session.gitBranch = rec.gitBranch;
    if (rec.version) session.cliVersion = rec.version;
    if (rec.entrypoint) session.entrypoint = rec.entrypoint;

    const type = rec.type;
    if (IGNORED_TYPES.has(type)) continue;

    if (type === 'ai-title') {
      if (rec.aiTitle) session.title = rec.aiTitle;
      continue;
    }
    if (type === 'last-prompt') {
      if (rec.lastPrompt && !firstUserText) firstUserText = rec.lastPrompt;
      continue;
    }
    if (type === 'cost-state') {
      costState = rec;
      continue;
    }

    if (type === 'user' || type === 'assistant' || type === 'system') {
      const { messages: produced, usage } = recordToMessages(rec, sid, i, type);
      for (const m of produced) messages.push(m);

      // usage 是「每条记录一份」，不是「每个内容块一份」。
      // 一条 assistant 记录常含 thinking + text + tool_use 三个块，
      // 若按块累加会把同一份 token 重复计入。
      if (usage) {
        sawUsage = true;
        usageSum.in += usage.in ?? 0;
        usageSum.out += usage.out ?? 0;
        usageSum.cacheRead += usage.cacheRead ?? 0;
        usageSum.cacheCreate += usage.cacheCreate ?? 0;
        usageSum.thinking += usage.thinking ?? 0;
      }

      for (const m of produced) {
        if (m.role === Role.User && m.kind === MessageKind.Text && !firstUserText) {
          firstUserText = m.text;
        }
        if (m.model && m.model !== '<synthetic>') {
          models.add(m.model);
          modelCounter.set(m.model, (modelCounter.get(m.model) ?? 0) + 1);
        }
      }
    }
  }

  // token / 成本聚合。
  //
  // cost-state 优先，但有个坑：源在没有成本数据时也会写 cost-state，
  // 且 totalCostUSD=0 而 modelUsage={}。这种情况它其实什么都没告诉我们 ——
  // 若直接采信，会把「未知」记成「$0 成本」，同时把逐条 usage 里的真实 token 全丢掉。
  // 因此判定标准是「modelUsage 是否有内容」，而不是「有没有 cost-state 记录」。
  const costUsage = costState?.modelUsage;
  const costUsable = costUsage && Object.keys(costUsage).length > 0;

  if (costUsable) {
    session.costUsd = toNumber(costState.totalCostUSD);
    session.tokensIn = sumModelUsage(costUsage, 'inputTokens');
    session.tokensOut = sumModelUsage(costUsage, 'outputTokens');
    session.tokensCacheRead = sumModelUsage(costUsage, 'cacheReadInputTokens');
    session.tokensCacheCreate = sumModelUsage(costUsage, 'cacheCreationInputTokens');
    session.tokensThinking = sumModelUsage(costUsage, 'thinkingTokens');
    for (const name of Object.keys(costUsage)) {
      models.add(name);
      modelCounter.set(name, (modelCounter.get(name) ?? 0) + 1);
    }
  } else if (sawUsage) {
    session.tokensIn = usageSum.in;
    session.tokensOut = usageSum.out;
    session.tokensCacheRead = usageSum.cacheRead;
    session.tokensCacheCreate = usageSum.cacheCreate;
    session.tokensThinking = usageSum.thinking;
    // 逐条 usage 里没有单价，算不出成本。留 null 表示「未知」，
    // 不用 0 冒充 —— 看板上 $0 和「无数据」是两回事。
    session.costUsd = null;
  }

  session.models = [...models];
  session.primaryModel = [...modelCounter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!session.title && firstUserText) {
    session.title = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  }
  session.startedAt = startedAt;
  session.lastEventAt = lastEventAt;

  return { session, messages };
}

/** 从 agent-*.meta.json 读出派生关系。toolUseId 是确定性的父指针。 */
export function parseEdge(artifact, childSessionId) {
  if (!artifact.metaPath || !artifact.parentNativeId || !artifact.agentId) return null;
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(artifact.metaPath, 'utf8'));
  } catch {
    return null;
  }
  const edge = emptyAgentEdge();
  edge.id = `${childSessionId}#spawn`;
  edge.childSessionId = childSessionId;
  edge.parentToolUseId = meta.toolUseId ?? null;
  edge.agentType = meta.agentType ?? null;
  edge.description = meta.description ?? null;
  edge.spawnDepth = toNumber(meta.spawnDepth);
  edge.requestShape = meta.requestShape ?? null;
  return edge;
}

// ---------------------------------------------------------------------------

function recordToMessages(rec, sid, seq, type) {
  const out = [];
  const base = {
    sessionId: sid,
    source: SOURCE,
    agentId: rec.agentId ?? null,
    uuid: rec.uuid ?? null,
    parentUuid: rec.parentUuid ?? null,
    ts: toEpochMs(rec.timestamp),
    model: null,
    toolName: null,
    toolUseId: null,
    isError: null,
  };
  const keyOf = (suffix) => `${rec.uuid ?? `seq${seq}`}${suffix ? ':' + suffix : ''}`;

  if (type === 'system') {
    const text = blocksToText(rec.content);
    if (!text) return { messages: out, usage: null };
    out.push({
      ...emptyMessage(), ...base,
      id: makeMessageId(SOURCE, sid, keyOf('system')),
      seq,
      role: Role.System,
      kind: MessageKind.System,
      text,
      payload: rec.subtype ? { subtype: rec.subtype, level: rec.level ?? null } : null,
    });
    return { messages: out, usage: null };
  }

  const msg = rec.message ?? {};
  const usage = msg.usage ?? {};
  const role = type === 'user' ? Role.User : Role.Assistant;

  // usage 只属于 assistant 记录，且整条记录只有一份。
  const recordUsage = role === Role.Assistant ? {
    in: toNumber(usage.input_tokens),
    out: toNumber(usage.output_tokens),
    cacheRead: toNumber(usage.cache_read_input_tokens),
    cacheCreate: toNumber(usage.cache_creation_input_tokens),
    thinking: toNumber(usage.output_tokens_details?.thinking_tokens),
  } : null;

  const content = msg.content;

  if (typeof content === 'string') {
    if (!content) return { messages: out, usage: null };
    out.push({
      ...emptyMessage(), ...base,
      id: makeMessageId(SOURCE, sid, keyOf()),
      seq,
      role,
      kind: MessageKind.Text,
      model: msg.model ?? null,
      text: clip(content),
    });
    return { messages: out, usage: recordUsage };
  }

  if (!Array.isArray(content)) return { messages: out, usage: null };

  content.forEach((block, bi) => {
    const common = {
      ...emptyMessage(), ...base,
      id: makeMessageId(SOURCE, sid, keyOf(`b${bi}`)),
      seq,
      model: msg.model ?? null,
    };
    switch (block.type) {
      case 'text':
        if (!block.text) return;
        out.push({ ...common, role, kind: MessageKind.Text, text: clip(block.text) });
        return;
      case 'thinking':
      case 'redacted_thinking': {
        const text = clip(block.thinking ?? block.data ?? '');
        if (!text) return;
        out.push({ ...common, role: Role.Assistant, kind: MessageKind.Thinking, text });
        return;
      }
      case 'tool_use':
        out.push({
          ...common,
          role: Role.Assistant,
          kind: MessageKind.ToolUse,
          toolName: block.name ?? null,
          toolUseId: block.id ?? null,
          text: summarizeToolInput(block.name, block.input),
          payload: block.input ?? null,
        });
        return;
      case 'tool_result':
        out.push({
          ...common,
          role: Role.Tool,
          kind: MessageKind.ToolResult,
          toolUseId: block.tool_use_id ?? null,
          isError: block.is_error === true,
          text: clip(blocksToText(block.content)),
        });
        return;
      case 'image':
        out.push({
          ...common,
          role,
          kind: MessageKind.Image,
          text: null,
          payload: block.source ? { mediaType: block.source.media_type ?? null } : null,
        });
        return;
      default:
        // 未知块类型不静默丢弃：留一条薄记录，便于后续版本识别新增类型。
        out.push({
          ...common,
          role,
          kind: MessageKind.System,
          text: null,
          payload: { unknownBlockType: block.type ?? null },
        });
    }
  });

  return { messages: out, usage: recordUsage };
}

/** 把 content（字符串 / 文本块数组）压成纯文本。 */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b?.type === 'text' && b.text) parts.push(b.text);
    else if (b?.type === 'image') parts.push('[图片]');
    else if (b?.type === 'tool_reference') parts.push(`[工具引用: ${b.tool_name ?? ''}]`);
  }
  return parts.length ? parts.join('\n') : null;
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return name ?? null;
  const first = input.file_path ?? input.path ?? input.command ?? input.pattern
    ?? input.url ?? input.description ?? input.question ?? null;
  const short = typeof first === 'string' ? first.replace(/\s+/g, ' ').slice(0, 120) : null;
  return short ? `${name}: ${short}` : String(name ?? '');
}

function sumModelUsage(modelUsage, field) {
  if (!modelUsage) return null;
  let total = 0;
  let seen = false;
  for (const u of Object.values(modelUsage)) {
    const v = toNumber(u?.[field]);
    if (v !== null) { total += v; seen = true; }
  }
  return seen ? total : null;
}

function clip(text) {
  if (!text) return null;
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…[已截断，原文 ${text.length} 字符]` : text;
}

function safeDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function safeEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}