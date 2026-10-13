/**
 * 适配器注册表。
 *
 * 每个适配器对外暴露同一组能力，采集器只认这组接口，不认具体是哪个 Agent：
 *   SOURCE                 源标识（与统一模型里的 source 字段一致）
 *   label                  人读名称
 *   defaultHome(homedir)   该源默认的数据根目录
 *   discover(home)         枚举可采集的源文件
 *   fingerprint(path, art) 文件指纹，用于判断是否变更（rollout 不存在时可用元数据兜底）
 *   parse(artifact)        解析成统一模型，返回 { session, messages, edges? }
 *   parseEdge(...)         派生关系（可选；仅 Claude Code 与 Codex 需要）
 *
 * 各源的数据根目录并不都在用户主目录下 —— Trae CN 挂在 %APPDATA%，
 * 因此根目录由适配器自己声明，而不是由采集器写死。
 */

import { join } from 'node:path';
import * as claudeCode from './claude-code.js';
import * as dsh from './dsh.js';
import * as workbuddy from './workbuddy.js';
import * as codex from './codex.js';
import * as traeCn from './trae-cn.js';

const REGISTRY = new Map();

function register(adapter, label) {
  REGISTRY.set(adapter.SOURCE, { ...adapter, label });
}

register(claudeCode, 'Claude Code');
register(dsh, 'DeepSeek Harness');
register(workbuddy, 'WorkBuddy');
register(codex, 'Codex');
register(traeCn, 'Trae CN');

/** 各源的默认数据根目录。顺序：环境变量覆盖 → 源特有位置 → 主目录下的默认名。 */
const DEFAULT_HOME = {
  'claude-code': (home) => process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
  dsh: (home) => join(home, '.dsh'),
  workbuddy: (home) => join(home, '.workbuddy'),
  codex: (home) => process.env.CODEX_HOME || join(home, '.codex'),
  // Trae CN 的数据不在主目录，而在 Roaming 下。
  'trae-cn': () => process.env.APPDATA ? join(process.env.APPDATA, 'Trae CN') : null,
};

/** 获取已注册的适配器；source 为空时返回全部。 */
export function getAdapters(source) {
  if (!source) return [...REGISTRY.values()];
  const found = REGISTRY.get(source);
  if (!found) {
    const known = [...REGISTRY.keys()].join(', ');
    throw new Error(`未知数据源 "${source}"，当前已注册：${known}`);
  }
  return [found];
}

/** 已注册的源清单，供 CLI 与 /api/sources 使用。 */
export function listSources() {
  return [...REGISTRY.values()].map((a) => ({ source: a.SOURCE, label: a.label }));
}

/** 计算某个源的数据根目录；返回 null 表示该平台/环境拿不到。 */
export function homeFor(source, homedir) {
  const fn = DEFAULT_HOME[source];
  return fn ? fn(homedir) : homedir;
}