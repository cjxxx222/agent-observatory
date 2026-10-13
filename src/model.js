/**
 * 统一会话模型（Unified Session Model）
 *
 * 这是整个平台唯一自研的核心：把各 Agent 互不兼容的本地存储，
 * 归一化成同一套实体。上层（查询服务 / 看板 / 时间线 / 关系图）
 * 只认这套模型，不关心数据来自哪个 Agent。
 *
 * 设计约束（来自对真实数据的勘察，不是臆测）：
 *  - 各源只保证有「会话」和「消息」两层，工具调用与 token 用量是可选能力。
 *  - 派生关系（谁派生了谁）在 Claude Code / Codex 里都是确定性的，不靠文本猜测。
 *  - 任何源的字段缺失都用 null 表示，绝不用 0 或空串冒充「有值」，
 *    否则看板会把「未知」显示成「0 成本 / 0 token」，属于数据造假。
 */

/** 模型版本。字段含义变更时必须递增，用于索引库重建判断。 */
export const MODEL_VERSION = 1;

/** 会话种类。子代理和工作流代理在统一模型里同样是「会话」，只是长在树上。 */
export const SessionKind = {
  Main: 'main',
  Subagent: 'subagent',
  WorkflowAgent: 'workflow',
};

/**
 * 内容完整度。各源能读到的内容范围并不一样，看板上必须能分辨，
 * 否则「这个 Agent 没有工具调用」和「这个源读不到工具调用」会被混为一谈。
 *   full            —— 用户消息、模型回复、工具调用齐全
 *   user-prompts    —— 只有用户提问；模型回复不存在于本地（Trae CN 就是这种）
 *   metadata-only   —— 只有会话元数据，没有消息正文
 */
export const ContentScope = {
  Full: 'full',
  UserPromptsOnly: 'user-prompts',
  MetadataOnly: 'metadata-only',
};

/** 消息块种类。各源原生类型不同，在此收敛成固定集合。 */
export const MessageKind = {
  Text: 'text',
  Thinking: 'thinking',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
  Image: 'image',
  System: 'system',
  Attachment: 'attachment',
};

/** 角色。'tool' 用于独立表达工具结果，避免与 user 混淆。 */
export const Role = {
  User: 'user',
  Assistant: 'assistant',
  System: 'system',
  Tool: 'tool',
};

/**
 * 生成全局唯一 ID。
 * 各源的 native id（Claude Code 的 sessionId、Codex 的 thread id）会在不同源之间撞车，
 * 因此一律带 source 前缀。
 */
export function sessionId(source, nativeId) {
  return `${source}:${nativeId}`;
}

export function messageId(source, sessionIdValue, nativeKey) {
  return `${source}:${sessionIdValue}:${nativeKey}`;
}

export function projectId(cwd) {
  return `cwd:${normalizePathKey(cwd)}`;
}

/**
 * 归一化路径用于比较与分组：Windows 下大小写不敏感、分隔符不统一，
 * 直接字符串比较会把同一个目录拆成两个项目。
 */
export function normalizePathKey(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 会话活跃度。刻意不在入库时固化，而是在查询时按「最后事件时间」实时计算，
 * 否则索引库里的状态会随时间的推移变成谎言（曾有工具就栽在这上面）。
 */
export function activityOf(lastEventAt, now = Date.now()) {
  if (!lastEventAt) return 'unknown';
  const ageMs = now - lastEventAt;
  if (ageMs < 5 * 60 * 1000) return 'active';
  if (ageMs < 60 * 60 * 1000) return 'idle';
  return 'dormant';
}

/** 把 ISO 时间串转 epoch ms；失败返回 null，不用 0 冒充。 */
export function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 数值安全转换：非有限数一律 null（「未知」不等于 0）。 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 创建一个空的统一会话对象。
 * 适配器只需填充它认识的字段，其余保持 null。
 */
export function emptySession() {
  return {
    id: null,
    source: null,
    nativeId: null,
    sessionKind: SessionKind.Main,
    contentScope: ContentScope.Full,
    projectId: null,
    parentSessionId: null,
    agentId: null,
    title: null,
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: null,
    primaryModel: null,
    models: [],
    startedAt: null,
    lastEventAt: null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    tokensCacheCreate: null,
    tokensThinking: null,
    artifactPath: null,
    artifactBytes: null,
    artifactMtime: null,
  };
}

/**
 * 创建一个空的统一消息对象。
 * seq 由索引层按写入顺序分配，适配器不要自己填。
 */
export function emptyMessage() {
  return {
    id: null,
    sessionId: null,
    source: null,
    role: null,
    kind: null,
    uuid: null,
    parentUuid: null,
    agentId: null,
    toolName: null,
    toolUseId: null,
    isError: null,
    text: null,
    payload: null,
    model: null,
    ts: null,
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    tokensCacheCreate: null,
    tokensThinking: null,
  };
}

/** 空派生关系对象。parentToolUseId 是确定性的回指，不是推断。 */
export function emptyAgentEdge() {
  return {
    id: null,
    parentSessionId: null,
    childSessionId: null,
    parentToolUseId: null,
    agentType: null,
    description: null,
    spawnDepth: null,
    requestShape: null,
    /**
     * 这条父子关系是怎么确定的。
     *   'tool_use_id'    —— 由 meta 里的 toolUseId 精确回指父会话中被调用的那条 tool_use，可信
     *   'host_directory' —— 只能确定代理落在哪个宿主的目录下，但找不到精确的发起记录
     * 关系图上必须区分这两者：把目录推断画成精确调用链是在骗人。
     */
    linkMethod: null,
  };
}