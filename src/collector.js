/**
 * 采集器：把各源的源文件扫进索引库。
 *
 * 流程刻意分成两趟：
 *   第一趟：所有主会话。这样主会话里的 tool_use 记录已经入库。
 *   第二趟：子代理 / 工作流代理，用 meta.toolUseId 反查父会话，建立派生关系。
 * 反过来做的话，子代理找不到父会话，关系图会断。
 */

import { homedir } from 'node:os';
import { getAdapters, homeFor } from './adapters/index.js';
import { ContentScope, SessionKind, sessionId as makeSessionId } from './model.js';

export function resolveHome(source, override) {
  if (override) return override;
  return homeFor(source, homedir());
}

/**
 * 执行一次采集。
 * @param {object} store            索引库
 * @param {object} options
 * @param {string} [options.source] 只采某个源
 * @param {boolean} [options.force] 忽略指纹，强制重采
 * @param {(evt:object)=>void} [options.onEvent] 采集进度回调（供 SSE 推送）
 */
export function collect(store, { source, force = false, onEvent = () => {} } = {}) {
  const adapters = getAdapters(source);
  const summary = { sources: [], filesSeen: 0, filesIngested: 0, filesSkipped: 0, filesEmpty: 0, errors: [] };

  for (const adapter of adapters) {
    const home = resolveHome(adapter.SOURCE);
    const started = Date.now();
    const result = { source: adapter.SOURCE, label: adapter.label, home, main: 0, agents: 0 };

    let artifacts = [];
    if (!home) {
      summary.errors.push({ source: adapter.SOURCE, stage: 'discover', message: '该源在本机没有可用的数据目录' });
      summary.sources.push(result);
      continue;
    }
    try {
      artifacts = adapter.discover(home, { homedir: homedir() });
    } catch (err) {
      summary.errors.push({ source: adapter.SOURCE, stage: 'discover', message: err.message });
      summary.sources.push(result);
      continue;
    }

    const mains = artifacts.filter((a) => a.sessionKind === 'main');
    const agents = artifacts.filter((a) => a.sessionKind !== 'main');

    ingestPass(store, adapter, mains, { force, summary, result, bucket: 'main', onEvent });
    ingestPass(store, adapter, agents, { force, summary, result, bucket: 'agents', onEvent });

    result.elapsedMs = Date.now() - started;
    summary.sources.push(result);
    onEvent({ type: 'source_done', ...result });
  }

  /*
   * 收尾兜底：把所有「会话知道自己的父、但 agent_edges 里没有这条边」的关系补回来。
   *
   * 为什么放在全部源都采完之后、而不是每个源各自收尾：父会话也讲不通 ——
   * Codex / Claude Code 的边由**子**会话产出，而重采父会话时子会话这一轮往往指纹未变、
   * 直接跳过，于是那些边不会被任何人重写。若它们此前丢过（旧版本 bug、手工改动），
   * 就永久缺失。sessions.parent_session_id 是同一份确定性指针的副本，从它补边不引入猜测。
   * 只在真正补出边时记账，平时这几条 SQL 的结果是 0，成本可以忽略。
   */
  try {
    const recovered = store.recoverMissingEdges();
    if (recovered > 0) summary.edgesRecovered = recovered;
  } catch (err) {
    summary.errors.push({ stage: 'recover_edges', message: err.message });
  }

  return summary;
}

function ingestPass(store, adapter, artifacts, { force, summary, result, bucket, onEvent }) {
  for (const artifact of artifacts) {
    summary.filesSeen += 1;
    try {
      const fp = adapter.fingerprint(artifact.path, artifact);
      const prev = store.getArtifact(artifact.path);
      if (!force && prev && prev.bytes === fp.bytes && prev.mtime === fp.mtime) {
        summary.filesSkipped += 1;
        continue;
      }

      const { session, messages, edges = [] } = adapter.parse(artifact, { homedir: homedir() });

      /*
       * 空会话是噪声：DSH 里有些文件只剩一个会话头（几百字节、零消息），
       * Trae CN 里有些工作区从没提过问。这类会话放上看板只会稀释信息。
       * 但「直接跳过」会留下上一次采集的旧行，所以这里是真的把它删掉，而不是忽略。
       * 例外：metadata-only 的源（Codex）本来就没有正文，不能按消息数判空。
       */
      if (!messages.length && session.contentScope !== ContentScope.MetadataOnly) {
        /*
         * 空会话是噪声，不该出现在看板上 —— 但也不能每轮都把它重新解压一遍
         * （DSH 的 zstd 文件尤其贵）。删掉会话行之后，把它「已处理过」的指纹留下：
         * 下一轮 getArtifact 命中指纹，直接跳过。文件一旦真有内容，指纹就变了，
         * 会正常重采 —— 不影响正确性。
         */
        store.transaction(() => store.deleteSession(session.id));
        store.saveArtifact(artifact.path, adapter.SOURCE, null, fp.bytes, fp.mtime);
        summary.filesEmpty += 1;
        continue;
      }

      /*
       * 父子关系的来源按可信度排序，先到先用：
       *   1) 记录内部的精确指针（DSH 的 session.parentSession 字段）—— 最可信
       *   2) meta 文件里的 toolUseId 反查（Claude Code）—— 精确到发起它的那次工具调用
       *   3) 文件所在目录的宿主会话（工作流代理都在 <宿主sessionId>/ 之下）—— 只能确定归属
       * 三者都拿不到，就不写这条关系，而不是编一个。
       */
      if (!session.parentSessionId && session.parentNativeId) {
        session.parentSessionId = makeSessionId(adapter.SOURCE, session.parentNativeId);
      }
      if (!session.parentSessionId && artifact.parentNativeId) {
        session.parentSessionId = makeSessionId(adapter.SOURCE, artifact.parentNativeId);
      }

      const resolvedEdges = [];
      for (const e of edges) {
        if (!e.parentSessionId) e.parentSessionId = session.parentSessionId;
        if (e.parentSessionId) resolvedEdges.push(e);
      }

      if (typeof adapter.parseEdge === 'function') {
        const metaEdge = adapter.parseEdge(artifact, session.id);
        if (metaEdge) {
          const owner = metaEdge.parentToolUseId
            ? store.findSessionByToolUseId(metaEdge.parentToolUseId, adapter.SOURCE)
            : null;
          if (owner) {
            session.parentSessionId = owner;
            metaEdge.parentSessionId = owner;
            metaEdge.linkMethod = 'tool_use_id';
          } else if (session.parentSessionId) {
            metaEdge.parentSessionId = session.parentSessionId;
            // 适配器若已给出更精确的 linkMethod（如 Codex 的 spawn_edge_table /
            // session_meta_parent_thread_id），不要用「目录推断」把它盖掉 ——
            // 把精确关系标成推断，关系图就会说谎。只有适配器没声明时才退到这个默认值。
            if (!metaEdge.linkMethod) metaEdge.linkMethod = 'host_directory';
          }
          if (metaEdge.parentSessionId) resolvedEdges.push(metaEdge);
        }
      }

      store.transaction(() => {
        store.resetSessionMessages(session.id);
        /*
         * 只有当本次解析产出了「以本会话为父」的边时，才清掉本会话作为父的旧边。
         * 这类边只有本会话自己会写（DSH 的 subagent/catalog 记在父文件里），
         * 所以它是该命名空间的所有者，清掉再重写是对的（源里删掉的子代理不会留下幽灵边）。
         *
         * 反过来，Codex / Claude Code 的边由**子**会话产出，父会话重采时绝不能清 ——
         * 那会把本轮没被重采的子代理的边一起抹掉，而且没有任何人会把它们写回来。
         */
        if (resolvedEdges.some((e) => e.parentSessionId === session.id)) {
          store.deleteParentEdges(session.id);
        }
        session.projectId = session.cwd ? store.saveProject(session.cwd) : null;
        session.artifactBytes = fp.bytes;
        session.artifactMtime = fp.mtime;
        store.saveSession(session);
        store.appendMessages(session.id, messages);
        for (const e of resolvedEdges) store.saveEdge(e);
      });

      store.saveArtifact(artifact.path, adapter.SOURCE, session.id, fp.bytes, fp.mtime);

      summary.filesIngested += 1;
      // 按会话自身声明的种类计数，而不是按文件所在目录 ——
      // DSH 的子代理是独立目录，不在宿主目录下，按目录分会数错。
      if (session.sessionKind === SessionKind.Main) result.main += 1; else result.agents += 1;
      onEvent({
        type: 'session_ingested',
        source: adapter.SOURCE,
        sessionId: session.id,
        sessionKind: session.sessionKind,
        title: session.title,
        messages: messages.length,
        bytes: fp.bytes,
      });
    } catch (err) {
      // 单个文件失败不能中断整次采集（源文件可能正被写入、或格式已变）。
      summary.errors.push({ path: artifact.path, message: err.message });
    }
  }
}