/**
 * dsh-image-studio —— 路径、配置与生成记录。
 *
 * 数据都落在 <DSH_HOME>/image-studio/ 下：
 *   config.json      插件配置（含 API Key，只在本机）
 *   library/<类>/    四个参考库的默认目录（可在设置页逐个改到别处）
 *   outputs/YYYY-MM/ 生成的图片
 *   history.jsonl    生成记录（最近的在文件末尾）
 *   .trash/          设置页「删除」的素材会挪到这里，不做硬删除
 *
 * 只 import node: 内置模块（本地 link 安装时裸包名解析不到宿主的包）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CATEGORIES = ['characters', 'outfits', 'scenes', 'props']
export const CATEGORY_LABEL = { characters: '人物', outfits: '服饰', scenes: '场景', props: '道具' }

export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
}

let rootOverride = ''
/** 测试用：把数据根目录指到临时目录。 */
export function __setRootForTest(dir) { rootOverride = dir }

export function studioRoot() { return rootOverride || path.join(dshHome(), 'image-studio') }
export function configPath() { return path.join(studioRoot(), 'config.json') }
export function historyPath() { return path.join(studioRoot(), 'history.jsonl') }
export function outputsRoot() { return path.join(studioRoot(), 'outputs') }
export function trashRoot() { return path.join(studioRoot(), '.trash') }
export function defaultCategoryDir(category) { return path.join(studioRoot(), 'library', category) }
export function presetsPath() { return path.join(studioRoot(), 'presets.json') }
export function stagingRoot() { return path.join(studioRoot(), 'staging') }

export const PROVIDERS = {
  '65535-tasks': {
    label: '65535 原生异步任务（/v1/tasks）',
    baseUrls: [
      { url: 'https://task-api-1-cn.65535.space', label: '大陆优化线路' },
      { url: 'https://task-api-1.65535.space', label: '国际线路' },
    ],
  },
  'openai-images': {
    label: 'OpenAI 兼容（/v1/images/generations + edits）',
    baseUrls: [],
  },
}

export const DEFAULT_CONFIG = {
  enabled: true,
  dirs: { characters: '', outfits: '', scenes: '', props: '' },
  api: {
    provider: '65535-tasks',
    baseUrl: 'https://task-api-1-cn.65535.space',
    apiKey: '',
    model: 'gpt-image-2',
    resolution: '2k',
    quality: '',
    defaultAspect: '3:4',
    timeoutSec: 300,
  },
  policy: {
    mode: 'balanced',
    cooldownMin: 3,
    rules: '',
  },
  compose: {
    maxRefs: 8,
    refsPerCharacter: 2,
    refsPerOther: 1,
    autoMatch: true,
    useDefaultOutfit: true,
    followSchedule: true,
    stylePrompt: '',
    catalogInPrompt: true,
    identityOnly: true,
  },
  output: {
    showToModel: false,
  },
  vision: {
    source: 'dsh',
    dshModel: '',
    baseUrl: 'https://api2-cn.65535.space',
    apiKey: '',
    model: '',
  },
}

export const POLICY_MODES = ['manual', 'balanced', 'proactive']
export const RESOLUTIONS = ['', '1k', '2k', '4k']
export const ASPECTS = ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9']

function clone(v) { return JSON.parse(JSON.stringify(v)) }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function str(v, max = 4000) { return typeof v === 'string' ? v.slice(0, max) : '' }
function int(v, min, max, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/** 把任意输入收敛成合法配置（缺字段回默认，越界夹住）。 */
export function normalizeConfig(raw) {
  const d = DEFAULT_CONFIG
  const r = isObj(raw) ? raw : {}
  const api = isObj(r.api) ? r.api : {}
  const policy = isObj(r.policy) ? r.policy : {}
  const compose = isObj(r.compose) ? r.compose : {}
  const output = isObj(r.output) ? r.output : {}
  const dirs = isObj(r.dirs) ? r.dirs : {}
  const vision = isObj(r.vision) ? r.vision : {}
  const provider = Object.hasOwn(PROVIDERS, api.provider) ? api.provider : d.api.provider
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    dirs: Object.fromEntries(CATEGORIES.map((c) => [c, str(dirs[c], 1024).trim()])),
    api: {
      provider,
      baseUrl: (str(api.baseUrl, 512).trim() || (provider === '65535-tasks' ? d.api.baseUrl : '')).replace(/\/+$/, ''),
      apiKey: str(api.apiKey, 512).trim(),
      model: str(api.model, 128).trim() || d.api.model,
      resolution: RESOLUTIONS.includes(api.resolution) ? api.resolution : d.api.resolution,
      quality: str(api.quality, 32).trim(),
      defaultAspect: ASPECTS.includes(api.defaultAspect) ? api.defaultAspect : d.api.defaultAspect,
      timeoutSec: int(api.timeoutSec, 30, 1800, d.api.timeoutSec),
    },
    policy: {
      mode: POLICY_MODES.includes(policy.mode) ? policy.mode : d.policy.mode,
      cooldownMin: int(policy.cooldownMin, 0, 240, d.policy.cooldownMin),
      rules: str(policy.rules, 4000),
    },
    compose: {
      maxRefs: int(compose.maxRefs, 1, 16, d.compose.maxRefs),
      refsPerCharacter: int(compose.refsPerCharacter, 1, 6, d.compose.refsPerCharacter),
      refsPerOther: int(compose.refsPerOther, 1, 4, d.compose.refsPerOther),
      autoMatch: typeof compose.autoMatch === 'boolean' ? compose.autoMatch : d.compose.autoMatch,
      useDefaultOutfit: typeof compose.useDefaultOutfit === 'boolean' ? compose.useDefaultOutfit : d.compose.useDefaultOutfit,
      followSchedule: typeof compose.followSchedule === 'boolean' ? compose.followSchedule : d.compose.followSchedule,
      stylePrompt: str(compose.stylePrompt, 2000),
      catalogInPrompt: typeof compose.catalogInPrompt === 'boolean' ? compose.catalogInPrompt : d.compose.catalogInPrompt,
      identityOnly: typeof compose.identityOnly === 'boolean' ? compose.identityOnly : d.compose.identityOnly,
    },
    output: {
      showToModel: typeof output.showToModel === 'boolean' ? output.showToModel : d.output.showToModel,
    },
    vision: {
      source: vision.source === 'openai' ? 'openai' : 'dsh',
      dshModel: str(vision.dshModel, 200).trim(),
      baseUrl: (str(vision.baseUrl, 512).trim() || d.vision.baseUrl).replace(/\/+$/, ''),
      apiKey: str(vision.apiKey, 512).trim(),
      model: str(vision.model, 128).trim(),
    },
  }
}

function deepMerge(base, patch) {
  if (!isObj(patch)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

let config = normalizeConfig(clone(DEFAULT_CONFIG))

export function getConfig() { return config }

export function loadConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8')
    config = normalizeConfig(JSON.parse(raw))
  } catch {
    config = normalizeConfig(clone(DEFAULT_CONFIG))
  }
  return config
}

/** 原子写配置。patch 是局部更新（深合并）。 */
export function updateConfig(patch) {
  const next = normalizeConfig(deepMerge(clone(config), patch))
  mkdirSync(studioRoot(), { recursive: true })
  const tmp = `${configPath()}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, configPath())
  config = next
  return config
}

/** 给网页看的配置：API Key 只露尾巴。 */
export function publicConfig(cfg = config) {
  const out = clone(cfg)
  const key = cfg.api.apiKey
  out.api.apiKey = ''
  out.api.hasKey = key !== ''
  out.api.keyHint = key === '' ? '' : `••••${key.slice(-4)}`
  const vkey = cfg.vision.apiKey
  out.vision.apiKey = ''
  out.vision.hasKey = vkey !== ''
  out.vision.keyHint = vkey === '' ? '' : `••••${vkey.slice(-4)}`
  return out
}

export function categoryDir(category, cfg = config) {
  const custom = cfg.dirs[category]
  return custom ? custom : defaultCategoryDir(category)
}

export function ensureDirs() {
  for (const c of CATEGORIES) {
    try { mkdirSync(defaultCategoryDir(c), { recursive: true }) } catch {}
  }
  try { mkdirSync(outputsRoot(), { recursive: true }) } catch {}
}

// ---- 生成记录 ---------------------------------------------------------------

export function appendHistory(entry) {
  try {
    mkdirSync(studioRoot(), { recursive: true })
    appendFileSync(historyPath(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {}
}

/** 读全部记录，同 id 以最后一条为准（状态更新用追加写）。新的在前。 */
export function readHistory(limit = 200) {
  let raw = ''
  try { raw = readFileSync(historyPath(), 'utf8') } catch { return [] }
  const byId = new Map()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.id === 'string') byId.set(e.id, { ...(byId.get(e.id) || {}), ...e })
    } catch {}
  }
  const all = [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return all.slice(0, limit)
}

export function findHistory(id) {
  return readHistory(5000).find((e) => e.id === id) || null
}

/** 记录文件太长时压缩（每个 id 只留一行）。 */
export function compactHistory(maxEntries = 2000) {
  try {
    if (!existsSync(historyPath())) return
    const all = readHistory(maxEntries).reverse()
    const tmp = `${historyPath()}.tmp-${process.pid}`
    writeFileSync(tmp, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''), 'utf8')
    renameSync(tmp, historyPath())
  } catch {}
}

export function newId(prefix) {
  const t = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
  return `${prefix}${stamp}-${Math.random().toString(36).slice(2, 6)}`
}
