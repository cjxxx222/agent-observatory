/**
 * Agent Observatory 前端。
 *
 * 视角：以「Agent」为单位，不以「数据表」为单位。
 * 三层入口，密度依次递增：
 *   看板（图标网格）→ 双击进入「当前任务」→ 需要时再展开「完整记录」
 * 历史任务单独成按钮，避免和「当前在做什么」混在一屏里。
 *
 * 无框架、无构建。只读 API 的稳定面，新增数据源时界面不需要跟着改。
 */

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ 图标 */

/**
 * Agent 图标是抽象几何形状，刻意不模仿任何厂商商标。
 * 这些字符串全部是本文件内的字面量，不含外部输入，
 * 因此可以安全地用 innerHTML 注入；界面上的所有业务文本一律走 textContent。
 */
const GLYPHS = {
  star: '<path d="M12 2.4 13.9 10.1 21.6 12 13.9 13.9 12 21.6 10.1 13.9 2.4 12 10.1 10.1Z"/>',
  hexagon: '<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  wave: '<path d="M2.6 15.4c2.9-6.6 5.7-6.6 8.6-1.9s5.7 4.7 8.6-1.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  buddy: '<circle cx="9.2" cy="12" r="5.2"/><circle cx="16" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  chevron: '<path d="M4.4 16.6 12 7.2l7.6 9.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

function iconNode(glyph, { big = false, accent = '#888888' } = {}) {
  const node = h('div', {
    class: `agent-icon${big ? ' big' : ''}`,
    style: `--accent:${accent}`,
  });
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${GLYPHS[glyph] ?? GLYPHS.hexagon}</svg>`;
  return node;
}

/* ------------------------------------------------------------------ 工具 */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error ?? ''; } catch { /* 非 JSON */ }
    throw new Error(`${res.status} ${detail}`.trim());
  }
  return res.json();
}

function fmtRelative(ts) {
  if (!ts) return '无时间戳';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function fmtAbs(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
}

/** 「未知」与「0」必须显示得不一样，否则等于在看板上编数据。 */
function fmtCost(v) {
  return v === null || v === undefined ? '成本未知' : `$${Number(v).toFixed(2)}`;
}

function fmtTokens(v) {
  if (v === null || v === undefined) return 'token 未知';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ------------------------------------------------------------------ 状态 */

const state = {
  agents: [],
  probe: { supported: true, reason: null },
  view: 'board',      // board | current | history | record
  agentId: null,
  sessionId: null,
  sessions: [],
  messages: [],
};

/**
 * 内容完整度：各源能读到的范围不一样，看板上必须讲清楚 ——
 * 否则「Trae CN 没有工具调用」会被误读成「它没干过活」。
 */
const SCOPE_NOTICE = {
  'user-prompts': '只能读到你的提问；模型回复与工具调用不在本地，所以这里没有它们。',
  'metadata-only': '只能读到会话元数据（标题、目录、模型、时间）；消息正文不在本地。',
  mixed: '部分会话只能读到提问、部分能读到完整内容，注意逐条区分。',
};

function scopeLabel(scope) {
  return { 'user-prompts': '仅提问', 'metadata-only': '仅元数据', mixed: '内容不完整' }[scope] ?? scope;
}

/* --------------------------------------------------------------- 看板视图 */

async function loadAgents() {
  const data = await api('/api/agents');
  state.agents = data.agents;
}

function agentById(id) {
  return state.agents.find((a) => a.id === id) ?? null;
}

/**
 * 运行状态的展示文案。
 * 可见文字保持简短，但判定依据挂在 tooltip 上 ——
 * 一盏亮着的灯必须能回答「你凭什么说它在运行」，否则这个灯不值得信。
 */
function procLabel(agent) {
  if (agent.probeSupported === false) return { cls: 'unknown', text: '进程不可观测', detail: agent.reason ?? '' };
  const parts = [];
  if (agent.mainPid) parts.push(`主进程 PID ${agent.mainPid}`);
  if (agent.sidecarProcessCount) parts.push(`附加进程 ${agent.sidecarProcessCount}`);
  if (agent.helperProcessCount) parts.push(`辅助服务 ${agent.helperProcessCount}`);
  if (agent.childProcessCount) parts.push(`子进程 ${agent.childProcessCount}`);
  const basis = agent.evidence === 'exe' ? '判定依据：可执行文件名'
    : agent.evidence === 'cmdline' ? '判定依据：宿主进程的命令行' : '';
  if (basis) parts.push(basis);
  if (agent.running) {
    return { cls: 'on', text: `运行中 · ${agent.processCount} 个进程`, detail: parts.join(' · ') };
  }
  return { cls: '', text: '未运行', detail: parts.join(' · ') || '未发现该 Agent 的进程' };
}

function renderBoard() {
  const main = clear($('main'));
  const running = state.agents.filter((a) => a.running).length;
  const indexed = state.agents.filter((a) => a.indexed).length;

  const board = h('div', { class: 'board' },
    h('div', { class: 'board-head' },
      h('h2', { text: 'Agent 看板' }),
      h('p', {
        text: `${state.agents.length} 个 Agent · ${running} 个运行中 · ${indexed} 个已接入会话索引` +
          '　—　双击卡片查看当前任务',
      }),
    ),
  );

  if (state.probe.supported === false) {
    board.append(h('div', { class: 'notice warn' },
      `进程状态不可用：${state.probe.reason}。卡片上的运行状态会显示为「进程不可观测」，` +
      '而不会用「最近没动静」冒充「已退出」。'));
  }

  const grid = h('div', { class: 'agent-grid' });
  for (const agent of state.agents) grid.append(renderTile(agent));
  board.append(grid);
  main.append(board);
}

function renderTile(agent) {
  const proc = procLabel(agent);
  const latest = agent.latestSession;

  const tile = h('article', {
    class: `agent-tile${agent.running ? '' : ' off'}`,
    tabindex: '0',
    role: 'button',
    title: '双击查看当前任务',
    // 双击才是主入口。单击不做跳转，否则「历史任务」按钮会被误触发的导航打断。
    ondblclick: () => openCurrent(agent.id),
    onkeydown: (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openCurrent(agent.id); }
    },
  },
    h('div', { class: 'tile-head' },
      iconNode(agent.glyph, { accent: agent.accent }),
      h('div', { class: 'tile-id' },
        h('h3', { text: agent.label }),
        h('div', { class: 'proc-row' },
          h('span', { class: `proc-dot ${proc.cls}`, title: proc.detail }),
          h('span', { text: proc.text, title: proc.detail }),
        ),
      ),
    ),
    h('div', { class: 'tile-task' },
      h('div', { class: 'task-label', text: '当前任务' }),
      latest
        ? h('div', { class: 'task-title', text: latest.title || '(无标题)' })
        : h('div', { class: 'task-title none', text: agent.indexed ? '暂无会话' : '会话内容尚未接入' }),
      h('div', { class: 'task-meta' },
        latest
          ? `${fmtRelative(latest.last_event_at)} · ${latest.message_count ?? 0} 条消息`
          : (agent.indexed ? '索引里还没有主会话'
            // 未接入时优先说清「为什么」——Codex 是因为自己没落盘，Trae CN 是因为内容在云端。
            : (agent.note || '进程可观测，但拿不到对话内容')),
      ),
      // 内容完整度是逐源的硬约束，必须在卡片上就能看见，不能只在详情页里说。
      agent.contentScope && agent.contentScope !== 'full'
        ? h('div', { class: 'scope-tag', title: SCOPE_NOTICE[agent.contentScope] ?? '', text: scopeLabel(agent.contentScope) })
        : null,
    ),
    h('div', { class: 'tile-foot' },
      h('button', {
        class: 'btn-ghost', type: 'button',
        text: agent.indexed ? `历史任务 ${agent.sessionCount}` : '历史任务',
        disabled: !agent.indexed,
        onclick: (ev) => { ev.stopPropagation(); if (agent.indexed) openHistory(agent.id); },
      }),
      h('span', { class: 'hint', text: '双击卡片' }),
    ),
  );

  if (agent.note) tile.title = agent.note;
  return tile;
}

/* ----------------------------------------------------------- 当前任务视图 */

async function openCurrent(agentId) {
  state.view = 'current';
  state.agentId = agentId;
  state.sessionId = null;
  renderLoading('正在读取当前任务…');
  const agent = agentById(agentId);
  const latest = agent?.latestSession;
  if (!latest) { renderCurrent(); return; }
  try {
    const [detail, page] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(latest.id)}`),
      api(`/api/sessions/${encodeURIComponent(latest.id)}/messages?tail=60`),
    ]);
    state.detail = detail;
    state.messages = page.messages;
  } catch (err) {
    toast(`读取失败：${err.message}`);
  }
  renderCurrent();
}

function renderCurrent() {
  const agent = agentById(state.agentId);
  if (!agent) return renderBoard();
  const main = clear($('main'));
  const proc = procLabel(agent);
  const d = state.detail;
  const latest = agent.latestSession;

  const page = h('div', { class: 'page' },
    backButton('返回看板', () => { state.view = 'board'; renderBoard(); }),
    h('div', { class: 'page-head' },
      iconNode(agent.glyph, { big: true, accent: agent.accent }),
      h('div', { class: 'titles' },
        h('h2', { text: agent.label }),
        h('div', { class: 'proc-row' },
          h('span', { class: `proc-dot ${proc.cls}`, title: proc.detail }),
          h('span', { text: proc.text, title: proc.detail }),
          agent.mainPid ? h('span', { text: `· PID ${agent.mainPid}` }) : null,
        ),
      ),
    ),
  );

  if (!agent.indexed) {
    page.append(
      h('div', { class: 'notice' },
        '这个 Agent 目前只能观测到进程，拿不到会话内容 —— 它的适配器还没接入索引层。' +
        (agent.note ? `（${agent.note}）` : '')),
      h('h3', { class: 'hero-task none', text: '当前任务：不可见' }),
      h('div', { class: 'hero-meta', text: '进程层面的信息仍然可查，见下方。' }),
      processSection(agent),
    );
    main.append(page);
    return;
  }

  // 有索引但内容不完整时，必须在最显眼的位置说清楚缺了什么。
  if (agent.contentScope && agent.contentScope !== 'full') {
    page.append(h('div', { class: 'notice warn' },
      SCOPE_NOTICE[agent.contentScope] ?? `内容范围：${agent.contentScope}`));
  }
  if (!latest) {
    page.append(
      h('h3', { class: 'hero-task none', text: '当前任务：暂无会话' }),
      processSection(agent),
    );
    main.append(page);
    return;
  }

  // 当前任务 = 该 Agent 最近活跃的主会话。用大字号单点呈现，其余信息压到次级。
  // 注意 null 时间戳：直接拼「${fmtRelative()}有活动」会得到「无时间戳有活动」这种病句。
  const whenText = latest.last_event_at
    ? `${fmtRelative(latest.last_event_at)}有活动`
    : '源没有记录时间戳';
  page.append(
    h('h3', { class: 'hero-task', text: latest.title || '(无标题)' }),
    h('div', { class: 'hero-meta' },
      `${whenText} · ${latest.message_count ?? 0} 条消息` +
      ` · 模型 ${latest.primary_model ?? '未知'}` +
      (latest.child_count ? ` · 派出过 ${latest.child_count} 个子代理` : '') +
      ` · 目录 ${d?.cwd ?? '未知'}`),
  );

  const turns = buildTurns(state.messages);
  const recent = turns.slice(-4);
  page.append(h('div', { class: 'section' },
    h('h3', { text: '最近进展' }),
    h('p', {
      class: 'section-note',
      text: recent.length
        ? '只摘出对话与工具名，思考过程和工具原始输出收在完整记录里。点任意一段可展开。'
        : '这个会话里还没有可摘要的对话。',
    }),
    recent.length
      ? h('div', { class: 'turns' }, ...recent.map(renderTurn))
      : null,
  ));

  page.append(h('div', { class: 'actions' },
    h('button', {
      class: 'btn-primary', type: 'button', text: '查看完整记录',
      onclick: () => openRecord(latest.id),
    }),
    h('button', {
      class: 'btn', type: 'button', text: `历史任务 ${agent.sessionCount}`,
      onclick: () => openHistory(agent.id),
    }),
  ));

  page.append(processSection(agent));
  main.append(page);
}

/** 进程区块。让「双击进去看当前任务」对未接入索引的 Agent 也不是死胡同。 */
function processSection(agent) {
  const proc = procLabel(agent);
  const rows = agent.processes ?? [];
  const head = h('h3', { text: '进程' });

  if (proc.cls === 'unknown') {
    return h('div', { class: 'section' }, head,
      h('div', { class: 'notice warn', text: '当前平台无法读取进程信息，因此不做任何关于「是否在运行」的断言。' }));
  }
  // 无进程时只留一处说明。既放副标题又放空态会把同一句话讲两遍。
  if (!rows.length) {
    return h('div', { class: 'section' }, head,
      h('div', { class: 'empty-state', text: proc.detail || '未发现该 Agent 的进程' }));
  }

  const roleLabel = { main: '主进程', sidecar: '附加进程', child: '子进程', helper: '辅助服务', cmdline: '宿主进程' };
  return h('div', { class: 'section' }, head,
    h('p', { class: 'section-note', text: proc.detail }),
    h('table', { class: 'grid procs' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'PID' }), h('th', { text: '角色' }), h('th', { text: '进程名' }),
        h('th', { class: 'num', text: '内存' }), h('th', { text: '启动于' }))),
      h('tbody', {}, ...rows.map((p) => h('tr', {},
        h('td', { class: 'mono', text: String(p.pid) }),
        h('td', { text: roleLabel[p.role] ?? p.role }),
        h('td', { class: 'mono ellip', title: p.exePath ?? '', text: p.name }),
        h('td', { class: 'num', text: p.memoryMB === null ? '未知' : `${p.memoryMB} MB` }),
        h('td', { text: p.startedAt ? fmtRelative(p.startedAt) : '未知' }),
      ))),
    ),
  );
}

/**
 * 把消息流压成「轮次」。
 * 工具调用按名字归并计数 —— 一个助手轮里连着 20 次 Bash，展开成 20 行是噪声，
 * 压成「Bash ×20」才是有信息的。
 */
function buildTurns(messages) {
  const turns = [];
  let tools = [];

  const flushTools = () => {
    if (!tools.length) return;
    const counts = new Map();
    for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
    turns.push({ role: '工具', tools: [...counts.entries()].map(([name, n]) => ({ name, n })) });
    tools = [];
  };

  for (const m of messages) {
    if (m.kind === 'tool_use') { tools.push(m.tool_name ?? '未知工具'); continue; }
    if (m.kind === 'thinking' || m.kind === 'tool_result' || m.kind === 'attachment') continue;
    if (m.kind === 'text') {
      flushTools();
      turns.push({
        role: m.role === 'user' ? '用户' : '助手',
        text: m.text ?? '',
        ts: m.ts,
      });
      continue;
    }
    if (m.kind === 'system') { flushTools(); continue; }
  }
  flushTools();
  return turns;
}

function renderTurn(turn) {
  if (turn.tools) {
    return h('div', { class: 'turn' },
      h('div', { class: 'turn-role', text: turn.role }),
      h('div', { class: 'turn-body' },
        h('div', { class: 'tool-strip' },
          ...turn.tools.map((t) => h('span', { class: 'tool-chip', text: t.n > 1 ? `${t.name} ×${t.n}` : t.name })),
        ),
      ),
    );
  }
  const body = h('div', {
    class: 'turn-body collapsed',
    title: '点击展开/收起',
    onclick: () => body.classList.toggle('collapsed'),
  }, h('div', { class: 'txt', text: turn.text }));
  return h('div', { class: 'turn' },
    h('div', { class: 'turn-role', text: turn.role, title: fmtAbs(turn.ts) }),
    body,
  );
}

/* ----------------------------------------------------------- 历史任务视图 */

async function openHistory(agentId) {
  state.view = 'history';
  state.agentId = agentId;
  renderLoading('正在读取历史任务…');
  const agent = agentById(agentId);
  state.sessions = [];
  if (agent?.sources?.length) {
    const seen = new Map();
    for (const src of agent.sources) {
      try {
        const data = await api(`/api/sessions?source=${encodeURIComponent(src)}&limit=200`);
        for (const s of data.sessions) seen.set(s.id, s);
      } catch { /* 单个源失败不影响其他源 */ }
    }
    state.sessions = [...seen.values()].sort((a, b) => (b.last_event_at ?? 0) - (a.last_event_at ?? 0));
  }
  renderHistory();
}

function renderHistory() {
  const agent = agentById(state.agentId);
  if (!agent) return renderBoard();
  const main = clear($('main'));

  const page = h('div', { class: 'page' },
    backButton('返回看板', () => { state.view = 'board'; renderBoard(); }),
    h('div', { class: 'page-head' },
      iconNode(agent.glyph, { accent: agent.accent }),
      h('div', { class: 'titles' },
        h('h2', { text: `${agent.label} · 历史任务` }),
        h('div', { class: 'proc-row' },
          h('span', { class: `proc-dot ${procLabel(agent).cls}` }),
          h('span', { text: `${state.sessions.length} 个会话（含子代理）` }),
        ),
      ),
    ),
  );

  if (!state.sessions.length) {
    page.append(h('div', { class: 'empty-state', text: '这个 Agent 还没有已索引的会话' }));
    main.append(page);
    return;
  }

  const list = h('div', { class: 'hist' });
  for (const s of state.sessions) {
    list.append(h('div', {
      class: 'hist-item',
      onclick: () => openRecord(s.id),
    },
      h('div', {},
        h('div', { class: 'h-title', text: s.title || '(无标题)' }),
        h('div', { class: 'h-meta' },
          [
            fmtRelative(s.last_event_at),
            s.session_kind === 'main' ? '主会话' : s.session_kind === 'workflow' ? '工作流代理' : '子代理',
            s.content_scope && s.content_scope !== 'full' ? scopeLabel(s.content_scope) : null,
            s.primary_model,
            s.child_count ? `派出 ${s.child_count} 个子代理` : null,
          ].filter(Boolean).join(' · '),
        ),
      ),
      h('div', { class: 'h-right' },
        h('div', { text: `${s.message_count ?? 0} 条消息` }),
        h('div', { text: `${s.tool_call_count ?? 0} 次工具` }),
      ),
    ));
  }
  page.append(list);
  main.append(page);
}

/* --------------------------------------------------------- 完整记录视图 */

async function openRecord(sessionId) {
  state.view = 'record';
  state.sessionId = sessionId;
  state.messages = [];
  state.messagesDone = false;
  renderLoading('正在读取完整记录…');
  try {
    const [detail, page] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(sessionId)}`),
      api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=200&offset=0`),
    ]);
    state.detail = detail;
    state.messages = page.messages;
    state.messagesDone = page.messages.length < 200;
  } catch (err) {
    toast(`读取失败：${err.message}`);
  }
  renderRecord();
}

async function loadMoreMessages() {
  if (state.messages.length && state.messagesDone) return;
  try {
    const page = await api(
      `/api/sessions/${encodeURIComponent(state.sessionId)}/messages?limit=200&offset=${state.messages.length}`,
    );
    state.messages.push(...page.messages);
    state.messagesDone = page.messages.length < 200;
    renderRecord();
  } catch (err) {
    toast(`载入更多失败：${err.message}`);
  }
}

function renderRecord() {
  const d = state.detail;
  if (!d) return renderBoard();
  const agent = agentById(state.agentId);
  const main = clear($('main'));

  const page = h('div', { class: 'page wide' },
    backButton('返回', () => {
      if (agent && agent.indexed) openHistory(agent.id);
      else renderBoard();
    }),
    h('div', { class: 'page-head' },
      agent ? iconNode(agent.glyph, { accent: agent.accent }) : h('div'),
      h('div', { class: 'titles' },
        h('h2', { text: d.title || '(无标题)' }),
        h('div', { class: 'proc-row' },
          h('span', { text: `${d.message_count ?? 0} 条消息 · ${fmtCost(d.cost_usd)} · 输入 ${fmtTokens(d.tokens_in)} / 输出 ${fmtTokens(d.tokens_out)}` }),
        ),
      ),
    ),
    h('div', { class: 'notice' },
      `${d.session_kind === 'main' ? '主会话' : '代理会话'} · 最后活动 ${fmtAbs(d.last_event_at)} · 目录 ${d.cwd ?? '未知'}` +
      (d.git_branch ? ` · 分支 ${d.git_branch}` : '')),
  );

  if (d.content_scope && d.content_scope !== 'full') {
    page.append(h('div', { class: 'notice warn' }, SCOPE_NOTICE[d.content_scope] ?? `内容范围：${d.content_scope}`));
  }

  const body = h('div');
  for (const m of state.messages) body.append(renderMessage(m));
  page.append(body);

  if (!state.messagesDone) {
    page.append(h('div', { style: 'text-align:center;padding:24px 0' },
      h('button', {
        class: 'btn', type: 'button',
        text: `载入更早的记录（已显示 ${state.messages.length} 条）`,
        onclick: loadMoreMessages,
      })));
  } else if (!state.messages.length) {
    page.append(h('div', { class: 'empty-state', text: '这个会话没有可显示的消息' }));
  }
  main.append(page);
}

const ROLE_LABEL = { user: '用户', assistant: '助手', tool: '工具', system: '系统' };

function renderMessage(m) {
  const role = m.role ?? 'system';
  const roleCell = h('div', { class: 'msg-role' },
    h('span', { class: `rk ${role}`, text: ROLE_LABEL[role] ?? role }),
    h('div', { text: fmtRelative(m.ts) }),
  );
  const body = h('div', { class: 'msg-body' });
  const isErr = m.is_error === 1;

  if (m.kind === 'tool_use') {
    body.append(h('div', { class: 'tool-line' },
      h('span', { class: 'tool-name', text: m.tool_name ?? '未知工具' }),
      h('span', { class: 'tool-arg', text: m.text ?? '' }),
    ));
  } else if (m.kind === 'tool_result') {
    const text = m.text ?? '(空结果)';
    body.append(h('div', { class: 'tool-line' },
      h('span', { class: 'tool-name', text: `↳ ${m.tool_name ?? '结果'}` }),
      h('span', { class: 'tool-arg', text: `${text.length} 字符${isErr ? ' · 报错' : ''}` }),
    ));
    body.append(collapsible(text, 5));
  } else if (m.kind === 'thinking') {
    body.append(h('div', { class: 'thinking-block' }, collapsible(m.text ?? '', 3, '思考')));
  } else if (m.kind === 'image') {
    body.append(h('span', { class: 'badge-sys', text: '图片附件' }));
  } else if (m.kind === 'system') {
    body.append(h('span', { class: 'badge-sys', text: m.text ?? m.payload?.unknownBlockType ?? '系统记录' }));
  } else {
    body.append(collapsible(m.text ?? '', 8));
  }
  return h('div', { class: `msg${isErr ? ' err' : ''}` }, roleCell, body);
}

function collapsible(text, lines, label = '内容') {
  const wrap = h('div');
  if (text.length <= 400 && text.split('\n').length <= lines) {
    wrap.append(h('div', { class: 'txt', text }));
    return wrap;
  }
  const block = h('div', { class: 'txt clamp', text });
  const btn = h('button', {
    class: 'more', type: 'button',
    text: `展开${label}（${text.length} 字）`,
    onclick: () => {
      const clamped = block.classList.toggle('clamp');
      btn.textContent = clamped ? `展开${label}（${text.length} 字）` : '收起';
    },
  });
  wrap.append(block, btn);
  return wrap;
}

/* ------------------------------------------------------------------ 杂项 */

function backButton(text, onClick) {
  return h('button', { class: 'back', type: 'button', text: `← ${text}`, onclick: onClick });
}

function renderLoading(text) {
  clear($('main')).append(h('div', { class: 'loading', text }));
}

/* ------------------------------------------------------------------ 检索 */

let searchTimer = null;

function onSearchInput(ev) {
  const value = ev.target.value.trim();
  clearTimeout(searchTimer);
  const box = $('searchResults');
  if (!value) { box.hidden = true; clear(box); return; }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(value)}&limit=30`);
      renderSearchResults(box, data.results);
    } catch (err) {
      clear(box).append(h('div', { class: 'empty-state', text: `检索失败：${err.message}` }));
      box.hidden = false;
    }
  }, 240);
}

function renderSearchResults(box, results) {
  clear(box);
  if (!results.length) {
    box.append(h('div', { class: 'empty-state', text: '没有命中' }));
  } else {
    for (const r of results) {
      box.append(h('div', {
        class: 'hit',
        onclick: () => { box.hidden = true; openRecord(r.session_id); },
      },
        h('div', { class: 'hit-head' },
          h('span', { class: 'tag', text: r.kind }),
          r.tool_name ? h('span', { class: 'tag', text: r.tool_name }) : null,
          h('span', { text: r.title ?? '(无标题)' }),
          h('span', { text: fmtRelative(r.ts) }),
        ),
        r.snippet ? h('div', { class: 'hit-text', text: r.snippet.slice(0, 220) }) : null,
      ));
    }
  }
  box.hidden = false;
}

/* --------------------------------------------------------------- 启动 */

function initTheme() {
  const saved = localStorage.getItem('obs-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('obs-theme', next);
  });
}

async function reloadBoardData() {
  const [agents, processes] = await Promise.all([
    api('/api/agents'),
    api('/api/processes'),
  ]);
  state.agents = agents.agents;
  state.probe = { supported: processes.supported, reason: processes.reason };
}

async function init() {
  initTheme();
  $('search').addEventListener('input', onSearchInput);
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.search-wrap')) $('searchResults').hidden = true;
  });
  $('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    try {
      const r = await api('/api/collect', { method: 'POST' });
      const s = r.sources?.[0] ?? {};
      toast(`已刷新：会话 +${(s.main ?? 0) + (s.agents ?? 0)}，跳过未变 ${r.filesSkipped ?? 0}`);
      await reloadBoardData();
      if (state.view === 'board') renderBoard();
    } catch (err) {
      toast(`刷新失败：${err.message}`);
    } finally {
      $('refresh').disabled = false;
    }
  });

  try {
    await reloadBoardData();
    renderBoard();
  } catch (err) {
    clear($('main')).append(h('div', { class: 'empty-state', text: `初始化失败：${err.message}` }));
  }
  // 进程状态是秒级事实，定期重取；只在看板页重绘，避免打断正在看的详情。
  setInterval(async () => {
    if (state.view !== 'board' || document.hidden) return;
    try {
      await reloadBoardData();
      renderBoard();
    } catch { /* 静默 */ }
  }, 10000);
}

init();