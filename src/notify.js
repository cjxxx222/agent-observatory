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
// 借 PowerShell 自己已注册的 AppUserModelID，免去注册应用的成本（未注册的 AppID 在部分版本上不显示）。
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const SOURCE_LABELS = new Map(listSources().map((s) => [s.source, s.label]));

/**
 * 静默判定 + 提醒去重。
 * 状态只活在内存里 —— 它描述的是「本进程运行期间观察到的变化」，重启后重新建立基线。
 */
export function createCompletionWatcher({
  quietMs = DEFAULT_QUIET_MS,
  url = DEFAULT_URL,
  notifier = notifyDesktop,
  log = () => {},
} = {}) {
  const lastSeen = new Map(); // sessionId -> 上一轮看到的 lastEventAt
  const notified = new Set(); // 已经为「当前这段静默」提醒过的会话

  return {
    /**
     * 每轮采集后调用一次。返回本轮真正提醒出去的会话。
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
        } else if (s.lastAt > prev) {
          notified.delete(s.id); // 又冒了新事件 → 新一轮开始，重新武装
        }
        lastSeen.set(s.id, s.lastAt);

        if (!notified.has(s.id) && now - s.lastAt >= quietMs) {
          notified.add(s.id);
          fired.push(s);
        }
      }

      for (const s of fired) {
        const source = SOURCE_LABELS.get(s.source) ?? s.source;
        const title = s.title ? `· ${s.title}` : '';
        log(`任务提醒：${source} ${title}`.trim());
        notifier({ title: 'Agent 完成了一轮任务', body: `${source} ${title}`.trim(), url });
      }
      return fired;
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

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}