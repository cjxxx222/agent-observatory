/**
 * 进程探针。
 *
 * 这是唯一一个「不属于任何 Agent transcript」的数据源 —— 它直接问操作系统。
 * 之所以要单独做一层：文件时间戳只能告诉你「这个会话多久没动静了」，
 * 不能告诉你「这个 Agent 现在是不是活着」。看板上那个亮灭的灯必须是后者，
 * 否则等于用「最近没说话」冒充「已经退出」。
 *
 * 平台支持：目前只实现 Windows（本机环境）。其他平台明确返回 unsupported，
 * 不用「猜一个运行中」来糊弄。
 */

import { execFile } from 'node:child_process';

/**
 * 已知 Agent 目录。
 *
 * mainExeNames   —— 判定「这个 Agent 在运行」的决定性可执行文件名（小写）
 * helperExeNames —— 常驻辅助进程（沙箱服务等）。单独计数，不作为运行依据：
 *                   它们即使 Agent 没在用也会一直挂着，拿它们当「运行中」是误报。
 * hostExeNames   —— 命令行匹配只在这些宿主进程上生效。这条限制是必需的：
 *                   探针自身通过 PowerShell 执行，命令行里就带着我们写下的字面量，
 *                   不限制宿主会匹配到探针自己（实测踩过）。
 * cmdline        —— 在 hostExe 上匹配的正则，用于没有独立可执行文件的 Agent
 * sources        —— 在统一模型里对应的 source，用于把进程与会话关联
 * electron       —— 该类应用会派生大量子进程，主进程只认不带 --type= 的那个
 */
export const AGENT_CATALOG = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    sources: ['claude-code'],
    mainExeNames: ['claude.exe'],
    helperExeNames: [],
    hostExeNames: ['node.exe', 'bun.exe', 'deno.exe'],
    cmdline: /[@\\/]claude-code[\\/]|claude-code[\\/]cli\.js|(?:^|\s)claude(?:\.cmd)?(?:\s|$)/i,
    electron: false,
    glyph: 'star',
    accent: '#C2703F',
    note: '多数时候不单独起进程，作为 Node 进程运行在编辑器内',
  },
  {
    id: 'codex',
    label: 'Codex',
    sources: ['codex'],
    mainExeNames: ['codex.exe', 'codex-plus-plus.exe'],
    helperExeNames: ['codex-windows-sandbox-service.exe'],
    hostExeNames: [],
    cmdline: null,
    electron: false,
    glyph: 'hexagon',
    accent: '#4A5568',
    note: '本机会话曾落盘，但被 Codex++ 删除并备份到 ~/.codex-session-delete；state_5.sqlite 的 threads 因此为空',
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    sources: ['dsh'],
    mainExeNames: ['deepseek harness.exe'],
    helperExeNames: [],
    hostExeNames: [],
    cmdline: null,
    electron: true,
    glyph: 'wave',
    accent: '#3B6FD4',
    note: null,
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    sources: ['workbuddy'],
    mainExeNames: ['workbuddy.exe'],
    helperExeNames: [],
    hostExeNames: [],
    cmdline: null,
    electron: true,
    glyph: 'buddy',
    accent: '#2E9E6B',
    note: null,
  },
  {
    id: 'trae-cn',
    label: 'Trae CN',
    sources: ['trae-cn'],
    mainExeNames: ['trae cn.exe'],
    helperExeNames: [],
    hostExeNames: [],
    cmdline: null,
    electron: true,
    glyph: 'chevron',
    accent: '#7B5BD6',
    note: '本地只存你的提问历史，模型回复与工具调用在云端，读不到',
  },
];

const PS_SCRIPT = '@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,CreationDate,WorkingSetSize,ExecutablePath) | ConvertTo-Json -Compress';

/** 单个 Agent 最多列出这么多条进程详情，避免一个 30 进程的 IDE 把接口撑爆。 */
const MAX_PROCESS_ROWS = 14;

export function platformSupported() {
  return process.platform === 'win32';
}

/** PowerShell 冷启动要数百毫秒，因此带短 TTL 缓存，避免前端轮询就重起一次进程。 */
let cache = { at: 0, value: null };
const CACHE_MS = 2000;

export function listProcesses({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
  if (!platformSupported()) {
    return Promise.resolve({ supported: false, reason: `当前平台 ${process.platform} 未实现进程探针`, processes: [] });
  }
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ supported: false, reason: `进程查询失败：${err.message}`, processes: [] });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout.trim() || '[]');
        } catch (e) {
          resolve({ supported: false, reason: `进程输出解析失败：${e.message}`, processes: [] });
          return;
        }
        // 只有一条进程时 ConvertTo-Json 返回对象而不是数组，这里统一成数组。
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const processes = rows
          .filter((p) => p && p.Name)
          .map((p) => ({
            pid: p.ProcessId,
            name: p.Name.toLowerCase(),
            cmdline: p.CommandLine ?? '',
            startedAt: toEpoch(p.CreationDate),
            memoryBytes: Number.isFinite(Number(p.WorkingSetSize)) ? Number(p.WorkingSetSize) : null,
            exePath: p.ExecutablePath ?? null,
          }));
        const value = { supported: true, at: Date.now(), processes };
        cache = { at: Date.now(), value };
        resolve(value);
      });
  });
}

/**
 * 把进程列表归到各 Agent 名下。
 *
 * Electron 应用会派生一堆子进程（渲染 / GPU / 网络服务）。那些不是「Agent 在跑」
 * 的证据，只用于展示进程规模，主进程单独认。
 */
export function summarizeAgents(scan) {
  if (!scan.supported) {
    return AGENT_CATALOG.map((a) => shape(a, { running: null, reason: scan.reason }));
  }

  return AGENT_CATALOG.map((agent) => {
    const mains = [];
    const helpers = [];
    const byCmdline = [];

    for (const p of scan.processes) {
      if (agent.mainExeNames.includes(p.name)) { mains.push(p); continue; }
      if (agent.helperExeNames.includes(p.name)) { helpers.push(p); continue; }
      // 命令行匹配只在可信宿主上进行，避免匹配到 shell 或探针自身。
      if (agent.cmdline && agent.hostExeNames.includes(p.name) && agent.cmdline.test(p.cmdline)) {
        byCmdline.push(p);
      }
    }

    const decisive = [...mains, ...byCmdline];

    /*
     * 一个 Agent 名下可能出现多个决定性进程（实测 Codex 同时跑着 codex.exe 与 codex-plus-plus.exe）。
     * 全部标成「主进程」会让界面出现两行主进程，所以只认一个主进程：
     * 优先取裸命令启动的那个，其次取启动最早的；其余算「附加进程」。
     */
    const bare = decisive.filter(isBareInvocation);
    const primaryProc = pickEarliest(bare.length ? bare : decisive);
    const attached = decisive.filter((p) => p !== primaryProc);

    const rowsForUi = [primaryProc, ...attached, ...helpers].filter(Boolean)
      .slice(0, MAX_PROCESS_ROWS)
      .map((p) => ({
        pid: p.pid,
        name: p.name,
        role: p === primaryProc ? 'main' : decisive.includes(p) ? 'sidecar' : 'helper',
        startedAt: p.startedAt,
        memoryMB: p.memoryBytes === null ? null : Math.round(p.memoryBytes / 1048576),
        exePath: p.exePath,
      }));

    if (!agent.electron) {
      return shape(agent, {
        running: decisive.length > 0,
        mainPid: primaryProc?.pid ?? null,
        mainProcessCount: primaryProc ? 1 : 0,
        sidecarProcessCount: attached.length,
        helperProcessCount: helpers.length,
        evidence: mains.length ? 'exe' : byCmdline.length ? 'cmdline' : null,
        processCountOverride: decisive.length + helpers.length,
        processes: rowsForUi,
      });
    }

    /*
     * Electron 应用有三类进程混在一起，不能一概而论：
     *   主进程   —— 不带 --type= 且以裸命令启动的那个
     *   附加进程 —— 同样不带 --type=，但其实是守护 / sidecar / CLI 入口（实测 WorkBuddy 有 3 个）
     *   子进程   —— 带 --type= 的渲染 / GPU / 网络服务
     * 只数主进程 + 子进程会漏掉附加进程（实测 DeepSeek Harness 少算 1 个）。
     */
    const electronMains = mains.filter((p) => !/--type=/.test(p.cmdline));
    const electronChildren = mains.filter((p) => /--type=/.test(p.cmdline));
    // 不能用「启动最早」代替「裸命令」：实测那样会把 Trae CN 的 CSS 语言服务器选成主进程。
    const primary = pickEarliest(electronMains.filter(isBareInvocation).length
      ? electronMains.filter(isBareInvocation)
      : electronMains);
    const sidecars = electronMains.filter((p) => p !== primary);

    const electronRows = [primary, ...sidecars, ...helpers].filter(Boolean)
      .slice(0, MAX_PROCESS_ROWS)
      .map((p) => ({
        pid: p.pid,
        name: p.name,
        role: p === primary ? 'main' : helpers.includes(p) ? 'helper' : 'sidecar',
        startedAt: p.startedAt,
        memoryMB: p.memoryBytes === null ? null : Math.round(p.memoryBytes / 1048576),
        exePath: p.exePath,
      }));

    return shape(agent, {
      running: mains.length > 0,
      mainPid: primary?.pid ?? null,
      mainProcessCount: primary ? 1 : 0,
      sidecarProcessCount: sidecars.length,
      helperProcessCount: helpers.length,
      childProcessCount: electronChildren.length,
      evidence: mains.length ? 'exe' : null,
      // 进程总数直接取实测值，不用分类结果相加 —— 相加一旦分类有遗漏就会少算。
      processCountOverride: mains.length + helpers.length,
      processes: electronRows,
    });
  });
}

/** 取启动最早的那个；没有启动时间就退回列表首个。 */
function pickEarliest(list) {
  if (!list.length) return null;
  return list.reduce((best, p) => {
    if (best.startedAt === null) return p;
    if (p.startedAt === null) return best;
    return p.startedAt < best.startedAt ? p : best;
  }, list[0]);
}

/**
 * 判断是不是「裸启动」：命令行里除可执行文件本身没有别的参数。
 * 形如：
 *   "C:\path\App.exe"                     → 裸启动
 *   C:\path\App.exe                       → 裸启动
 *   "C:\path\App.exe" "d:\...\server.js"  → 不是（扩展宿主 / 语言服务器 / sidecar 入口）
 */
function isBareInvocation(p) {
  const cmd = (p.cmdline ?? '').trim();
  if (!cmd) return false;
  const rest = cmd.startsWith('"') ? cmd.replace(/^"[^"]*"/, '') : cmd.replace(/^\S+/, '');
  return rest.trim() === '';
}

/**
 * CIM 的时间字段可能以三种形态出现，统一成 epoch ms：
 *   "/Date(1791766179656)/"  —— PowerShell ConvertTo-Json 的 .NET 旧日期格式（实测就是这种）
 *   "2026-10-12T09:12:33+08:00"
 *   数字
 * 之前只处理了后两种，导致「启动于」在界面上全是「未知」。
 */
function toEpoch(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const dotNet = value.match(/\/Date\((-?\d+)\)\//);
    if (dotNet) return Number(dotNet[1]);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function shape(agent, extra) {
  return {
    id: agent.id,
    label: agent.label,
    sources: agent.sources,
    glyph: agent.glyph,
    accent: agent.accent,
    note: agent.note,
    probeSupported: extra.running !== null,
    running: extra.running ?? null,
    reason: extra.reason ?? null,
    mainPid: extra.mainPid ?? null,
    mainProcessCount: extra.mainProcessCount ?? 0,
    sidecarProcessCount: extra.sidecarProcessCount ?? 0,
    helperProcessCount: extra.helperProcessCount ?? 0,
    childProcessCount: extra.childProcessCount ?? 0,
    evidence: extra.evidence ?? null,
    processes: extra.processes ?? [],
    processCount: extra.processCountOverride
      ?? ((extra.mainProcessCount ?? 0) + (extra.sidecarProcessCount ?? 0)
        + (extra.helperProcessCount ?? 0) + (extra.childProcessCount ?? 0)),
  };
}