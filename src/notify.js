/**
 * 任务完成提醒。
 *
 * 判定用的是「通用静默判定」：一个会话从「还在冒新事件」变成「连续 N 秒没有新事件」，
 * 就认为这一轮干活结束。它对全部源通用，代价是语义上是「安静下来了」，不等于
 * 「Agent 真的汇报完成」—— Agent 停在等你审批输入时同样会触发。那种时刻本来也值得看一眼，
 * 所以不算误报，但心里要清楚这个口径。
 *
 * 只对 content_scope === 'full' 的会话提醒：只有这类会话我们能看到 Agent 的正文，
 * 说「它干完了」才站得住脚。user-prompts（Trae CN，没有 Agent 回复）和 metadata-only
 * 都拿不到 Agent 的产出，对它们报「完成」是在编。
 *
 * 提醒走 Windows 通知：系统 toast + 提示音，点一下用默认浏览器打开观测台。
 * 全部用系统自带的 WinRT API（经 PowerShell 调用），不引任何第三方模块。
 */

import { spawn } from 'node:child_process';
import { listSources } from './adapters/index.js';

const DEFAULT_QUIET_MS = 90_000;
const DEFAULT_URL = 'http://127.0.0.1:7788';
// 单轮最多弹几条。归组只合并「同一个父」的批量完成，多个互不相关的会话同批安静时
// 仍会各弹一条 —— 那种情况下一轮能 spawn 几十个 PowerShell，必须兜一道硬上限。
const DEFAULT_MAX_PER_ROUND = 5;
// 借 PowerShell 自己已注册的 AppUserModelID，免去注册应用的成本（未注册的 AppID 在部分版本上不显示）。
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const SOURCE_LABELS = new Map(listSources().map((s) => [s.source, s.label]));

/**
 * 静默判定 + 提醒去重 + 同父归组 + 单轮上限。
 * 状态只活在内存里 —— 它描述的是「本进程运行期间观察到的变化」，重启后重新建立基线。
 * 已知代价：重启时正处于「安静中、尚未提醒」的会话不会再补提醒（基线重建后它们被当作老会话）。
 * 这是刻意取舍：宁可偶尔漏一条，也不要在启动瞬间把一屏历史会话全补出来。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.quietMs]   多久没新事件算这轮结束，默认 90s
 * @param {string}   [opts.url]       通知点击后打开的地址（由调用方按真实监听端口传入）
 * @param {function} [opts.notifier]  实际弹通知的函数，注入以便测试
 * @param {number}   [opts.startedAt] 开始观察的时刻，默认构造时；用于 N2 的「回填」判定
 * @param {number}   [opts.maxPerRound] 单轮最多弹几条，超出的折叠成一条汇总
 * @param {function} [opts.log]
 */
export function createCompletionWatcher({
  quietMs = DEFAULT_QUIET_MS,
  url = DEFAULT_URL,
  notifier = notifyDesktop,
  startedAt = Date.now(),
  maxPerRound = DEFAULT_MAX_PER_ROUND,
  log = () => {},
} = {}) {
  const lastSeen = new Map(); // sessionId -> 上一轮看到的 lastEventAt
  const notified = new Set(); // 已经为「当前这段静默」提醒过的会话

  return {
    /**
     * 每轮采集后调用一次。返回本轮真正发出去的提醒（已按父会话归组）。
     * @param {object} store 索引库
     * @param {number} [now] 注入时间，便于测试
     */
    observe(store, now = Date.now()) {
      const fired = [];
      for (const s of store.listCompletionCandidates()) {
        const prev = lastSeen.get(s.id);
        if (prev === undefined) {
          // 头一次见到：此刻已经安静的（含服务启动前就存在的老会话）不补报，
          // 否则一开服务就刷一屏。正在活动的会留在「未提醒」状态，等它安静下来再报。
          if (now - s.lastAt >= quietMs) notified.add(s.id);
        } else if (s.lastAt > prev && s.lastAt >= startedAt) {
          /*
           * 又有新事件 → 新一轮开始，重新武装。
           *
           * 第二个条件是 N2 的关键：lastEventAt 变大**不一定**等于「刚刚又干活了」。
           * 重新解析一个老会话时，可能补出一条时间戳比上一轮更晚、但仍然很旧的消息
           * （回填 / 时间戳被改写）。若不设防，这种「变新了」会让一个几小时前就结束的
           * 会话立刻满足「已安静 ≥ 阈值」而被补报。
           * 这里要求新时间戳不早于开始观察的时刻，也就是「这确实是本进程运行期间发生的事」。
           *
           * 代价（明确说明，不假装精确）：服务未运行的窗口里真实发生的完成，会被一并
           * 压掉、不再补报。我们宁愿漏报，也不要用一个陈旧会话去打扰用户。
           */
          notified.delete(s.id);
        }
        lastSeen.set(s.id, s.lastAt);

        if (!notified.has(s.id) && now - s.lastAt >= quietMs) {
          notified.add(s.id);
          fired.push(s);
        }
      }

      /*
       * 按父会话归组：一个父下面几十个子代理差不多同时安静下来（它们的时间戳彼此很近，
       * 会在同一轮跨过阈值），逐条弹就是通知轰炸。同父的合并成一条，
       * 正文写明「派生了 N 个子代理」。没有父的会话各自成组。
       *
       * 边界（诚实说明）：归组只在**同一轮 observe** 内生效。子代理若分几轮才陆续安静，
       * 每轮仍会各发一条 —— 归组是「同一批」而不是「同一个父的永远合并」。
       */
      const groups = new Map();
      for (const s of fired) {
        const key = s.parentSessionId ?? `#solo:${s.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }

      const sent = [];
      let folded = 0;
      /*
       * 先按「组内会话数」从多到少排，再按 id 兜底保证顺序确定。
       * 这样单轮上限砍掉的是信息量最小的那几条：一个「派生了 55 个子代理」的合并提醒
       * 远比五条互不相关的一对一提醒有用，不该被上限先挤掉。
       */
      const ordered = [...groups.values()]
        .sort((a, b) => b.length - a.length || (a[0].id < b[0].id ? -1 : 1));
      for (const members of ordered) {
        // 硬上限：单轮最多弹 maxPerRound 条，其余折叠成末尾那一条汇总，
        // 避免「多个互不相关的会话同批安静」时一次 spawn 几十个 PowerShell 刷屏。
        if (sent.length >= maxPerRound) {
          folded += members.length;
          continue;
        }
        const source = SOURCE_LABELS.get(members[0].source) ?? members[0].source;
        const payload = members.length > 1
          ? { title: '一批子代理完成', body: `${source} · 派生了 ${members.length} 个子代理` }
          : { title: 'Agent 完成了一轮任务', body: `${source}${members[0].title ? ` · ${members[0].title}` : ''}` };
        log(`任务提醒：${payload.title} — ${payload.body}`);
        notifier({ ...payload, url });
        sent.push({ ...payload, url, sessionIds: members.map((m) => m.id) });
      }

      if (folded > 0) {
        const payload = {
          title: '更多会话完成',
          body: `另有 ${folded} 个会话在本轮完成，为免刷屏已折叠为这一条`,
        };
        log(`任务提醒：${payload.title} — ${payload.body}`);
        notifier({ ...payload, url });
        sent.push({ ...payload, url, sessionIds: [], foldedCount: folded });
      }
      return sent;
    },
  };
}

/** 拼 Windows toast 的 XML。activationType=protocol + launch=URL → 点击直接开浏览器。 */
export function toastXml(title, body, url) {
  return '<toast activationType="protocol" launch="' + esc(url) + '" duration="short">'
    + '<visual><binding template="ToastGeneric">'
    + `<text>${esc(title)}</text>`
    + `<text>${esc(body)}</text>`
    + '</binding></visual>'
    + '<audio src="ms-winsoundevent:Notification.Default"/>'
    + '</toast>';
}

/**
 * 弹一个 Windows 通知。失败绝不能影响采集 —— 整条链路都是「发出去就不管」。
 * 非 Windows 平台直接静默返回（本项目只在 Windows 上跑，但不该因此崩）。
 */
export function notifyDesktop({ title, body, url = DEFAULT_URL }) {
  if (process.platform !== 'win32') return;
  const xml = toastXml(title, body, url);
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($env:AGENT_OBSERVATORY_TOAST)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($toast)`,
  ].join('; ');

  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, AGENT_OBSERVATORY_TOAST: xml },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // spawn 的失败是异步事件，不接住会变成未捕获异常把进程带崩。
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 提醒失败不影响采集 */
  }
}

/**
 * XML 转义，并顺手剔除 XML 1.0 不允许的控制字符。
 *
 * 为什么必须剔：标题/正文来自会话数据（用户输入、模型输出），混进 \x01 这类字符会让
 * `$doc.LoadXml` 直接抛错。而这条链路是「发出去就不管」—— 失败会被静默吞掉，
 * 用户永远不知道自己少收到一条通知。宁可先清掉，也不要留一个看不见的坑。
 * XML 1.0 允许的控制字符只有 \t \n \r，其余 C0 段一律非法。
 */
function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}