/**
 * dsh-image-studio —— 识图：看一张（或几张）图，整理出条目的名字、别名、标签和外观描述。
 *
 *   source = 'dsh'     用 DSH 自己的看图模型（默认 deepseek-flash）：ctx.attachments 存图 → ctx.llm.stream
 *   source = 'openai'  任意 OpenAI 兼容的 /v1/chat/completions（图片用 image_url data URI）
 *
 * 模型只输出一个 JSON；解析容错（去掉 ``` 包裹、截取第一个 { 到最后一个 }）。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { mimeOf, sniffImage } from './library.js'

const FOCUS = {
  characters: {
    role: '角色设定整理助手',
    focus: '只描述人物外貌：脸型五官、发型与发色、瞳色、肤色、体型比例、年龄感、标志性特征（兽耳、尾巴、角、翅膀、饰品等），服装只用一句话概括。不要写姿势、表情神态（如「笑容」「脸红」）、动作和背景——这些每张图都会变，写进去会让以后每张图都长一个样。',
    name: '认得出是哪个角色就用角色名，否则按特征起名，如「蓝发鲸鱼娘」',
    tags: '画风、发色、体型、种族特征、气质等',
  },
  outfits: {
    role: '服装设计整理助手',
    focus: '只描述服装本身，完全忽略穿着者的长相、姿势和背景：服装类型与版型、长度、颜色搭配、面料材质、图案、领口 / 袖口 / 裙摆等结构细节、纽扣拉链蕾丝等装饰、鞋袜和配饰。图里有多件时描述整套穿搭（除非补充说明另有指定）。',
    name: '按款式起名，如「蓝白女仆装」「米色针织开衫」',
    tags: '风格（如 JK、洛丽塔、中式、通勤、运动）、季节、场合、主色、材质',
  },
  scenes: {
    role: '场景设定整理助手',
    focus: '只描述空间本身，忽略画面里的人物：空间类型与大小、布局、主要家具和陈设、材质、配色、光线与时间、时代与风格。',
    name: '按空间起名，如「暖光小卧室」「海边咖啡馆」',
    tags: '室内 / 室外、空间类型、风格、色调、氛围、适合做的事',
  },
  props: {
    role: '道具设计整理助手',
    focus: '只描述这个物品：类别、外形结构、尺寸感、颜色、材质、纹理图案和细节，忽略拿着它的手和背景。',
    name: '按物品起名，如「鲸鱼抱枕」「复古胶片相机」',
    tags: '类别、材质、颜色、风格、用途',
  },
}

export function analyzePrompt(category, hint) {
  const f = FOCUS[category] || FOCUS.props
  return [
    `你是一名${f.role}。请仔细观察图片，为生图参考库整理一个条目。`,
    f.focus,
    '不要描述图片本身的版式（如「三视图」「设定图」「细节特写框」「排版」），只描述画的东西。',
    hint ? `用户的补充说明（优先遵守）：${hint}` : '',
    '只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：',
    '{',
    `  "name": "简短好记的中文名，2–10 个字；${f.name}",`,
    '  "aliases": ["0–3 个别名或常见叫法"],',
    `  "tags": ["5–10 个短标签：${f.tags}"],`,
    '  "description": "给生图模型看的外观描述，80–220 字，写具体可画的细节（颜色、形状、材质、位置关系），不写主观评价"',
    '}',
  ].filter(Boolean).join('\n')
}

/** 从模型输出里抠出 JSON 并规整字段。 */
export function parseFields(text) {
  let s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error(`识图结果不是 JSON：${s.slice(0, 120)}`)
  let j
  try { j = JSON.parse(s.slice(a, b + 1)) } catch (e) { throw new Error(`识图结果解析失败：${e.message}`) }
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、]/) : [])
    .map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean).slice(0, 12)
  return {
    name: String(j.name ?? '').trim().slice(0, 40),
    aliases: list(j.aliases).slice(0, 4),
    tags: list(j.tags),
    description: String(j.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200),
  }
}

async function loadImages(paths) {
  const out = []
  for (const p of paths.slice(0, 4)) {
    const data = await readFile(p)
    const ext = sniffImage(data) || path.extname(p).toLowerCase()
    out.push({ data, mime: mimeOf(`x${ext}`), name: path.basename(p) })
  }
  return out
}

function service(ctx, name) {
  try {
    const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    return v ?? ctx[name]
  } catch {
    return undefined
  }
}

/** DSH 里能看图的模型：[{ route: 'provider/model', name }] */
export async function listHostVisionModels(ctx) {
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return []
  const out = []
  const guesses = []
  for (const p of llm.listProviders() || []) {
    const pid = p && (p.id || p.provider)
    if (!pid) continue
    let models = []
    try { models = await llm.listModels(pid) } catch { continue }
    for (const m of models || []) {
      if (!m || !m.id) continue
      if (Array.isArray(m.inputModalities) && m.inputModalities.includes('image')) out.push({ route: `${pid}/${m.id}`, name: m.name || m.id })
      // 服务端模型列表可能不标输入模态：按名字猜一个（deepseek-flash 这类）
      else if (!Array.isArray(m.inputModalities) && /flash|vision|vl\b|omni/i.test(m.id)) guesses.push({ route: `${pid}/${m.id}`, name: `${m.name || m.id}（未标注，按名字推测支持图片）` })
    }
  }
  return out.length ? out : guesses
}

/** 纯文字任务用：第一个能用的模型。 */
async function firstHostRoute(llm) {
  for (const p of llm.listProviders() || []) {
    const pid = p && (p.id || p.provider)
    if (!pid) continue
    try {
      const models = await llm.listModels(pid)
      if (models && models[0] && models[0].id) return `${pid}/${models[0].id}`
    } catch {}
  }
  throw new Error('DSH 里没有可用的模型')
}

async function askHost(ctx, cfg, prompt, images, signal) {
  const llm = service(ctx, 'llm')
  const attachments = service(ctx, 'attachments')
  if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 的模型服务不可用；可以在设置里把识图改成「OpenAI 兼容接口」')
  if (images.length && (!attachments || typeof attachments.saveImages !== 'function')) throw new Error('DSH 的附件服务不可用，没法把图片交给模型；可以在设置里把识图改成「OpenAI 兼容接口」')
  let route = cfg.vision.dshModel
  if (!route) {
    const list = await listHostVisionModels(ctx)
    if (list.length) route = list[0].route
    else if (images.length) throw new Error('DSH 里没有找到能看图的模型（需要 deepseek-flash 这类支持图片输入的模型）')
    else route = await firstHostRoute(llm)
  }
  const slash = route.indexOf('/')
  const provider = route.slice(0, slash)
  const model = route.slice(slash + 1)
  const max = attachments.imageLimits && attachments.imageLimits.maxImageBytes
  for (const img of images) {
    if (max && img.data.length > max) throw new Error(`图片「${img.name}」太大（${Math.round(img.data.length / 1048576)}MB），超过 DSH 附件上限`)
  }
  const refs = images.length ? await attachments.saveImages(images.map((i) => ({ data: i.data, mediaType: i.mime, name: i.name }))) : []
  const content = [{ type: 'text', text: prompt }, ...refs.map((attachment) => ({ type: 'image', attachment }))]
  let text = ''
  for await (const chunk of llm.stream({ provider, model, messages: [{ role: 'user', content }], signal })) {
    if (!chunk) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && text === '' && typeof chunk.block.text === 'string') text = chunk.block.text
    else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind
      if (kind === 'error' || kind === 'aborted') {
        const f = chunk.reason.failure
        throw new Error(`识图模型（${route}）出错：${(f && (f.message || f.code)) || kind}`)
      }
    }
  }
  return text
}

async function askOpenAI(cfg, prompt, images, signal) {
  const base = String(cfg.vision.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('识图接口还没填 Base URL')
  const key = cfg.vision.apiKey || cfg.api.apiKey
  if (!key) throw new Error('识图接口还没填 API Key')
  if (!cfg.vision.model) throw new Error(images.length ? '识图接口还没填模型名（要选支持看图的模型）' : '识图接口还没填模型名')
  const url = `${/\/v1$/.test(base) ? base : `${base}/v1`}/chat/completions`
  const content = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data.toString('base64')}` } }))]
    : prompt
  const t = AbortSignal.timeout(180_000)
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.vision.model, messages: [{ role: 'user', content }], temperature: 0.3 }),
    signal: signal ? AbortSignal.any([signal, t]) : t,
  })
  const body = await res.text()
  if (!res.ok) {
    let msg = body.slice(0, 300)
    try { msg = JSON.parse(body).error.message || msg } catch {}
    throw new Error(`识图接口出错（HTTP ${res.status}）：${msg}`)
  }
  const j = JSON.parse(body)
  const c = j?.choices?.[0]?.message?.content
  return Array.isArray(c) ? c.map((x) => x?.text || '').join('') : String(c ?? '')
}

/**
 * @param o { ctx, cfg, paths: string[]（图片绝对路径）, category, hint, signal }
 * @returns {Promise<{ name, aliases, tags, description }>}
 */
export async function analyzeImages(o) {
  const images = await loadImages(o.paths)
  if (!images.length) throw new Error('没有可识别的图片')
  const prompt = analyzePrompt(o.category, o.hint)
  const text = o.cfg.vision.source === 'openai'
    ? await askOpenAI(o.cfg, prompt, images, o.signal)
    : await askHost(o.ctx, o.cfg, prompt, images, o.signal)
  return parseFields(text)
}

// ---- 文生素材：把一句话扩写成条目 ---------------------------------------------

const TEXT_FOCUS = {
  characters: ['角色设计助手', '写人物外貌：脸型五官、发型与发色、瞳色、肤色、体型比例、年龄感、标志性特征（兽耳、尾巴、角、饰品等），再用一两句写一套默认服装。不要写姿势、表情和背景。'],
  outfits: ['服装设计助手', '只写服装本身：类型与版型、长度、颜色搭配、面料材质、图案、领口 / 袖口 / 裙摆等结构细节、纽扣花边等装饰、鞋袜和配饰。'],
  scenes: ['场景设计助手', '只写空间本身：空间类型与大小、布局、主要家具和陈设、材质、配色、光线与时间、风格。不要写人物。'],
  props: ['道具设计助手', '只写这个物品：类别、外形结构、尺寸感、颜色、材质、纹理图案和细节。'],
}

export function expandPrompt(category, text, name, hint) {
  const [role, focus] = TEXT_FOCUS[category] || TEXT_FOCUS.props
  return [
    `你是一名${role}。用户想往生图参考库里加一个新条目，下面是他的文字描述。请据此整理条目，并把描述扩写成适合生图模型的具体外观描述：用户提到的要点一个都不能丢、也不能改；没提到的细节按整体风格合理补全（颜色、材质、结构、比例等），让画师拿着就能画。`,
    focus,
    `用户描述：${text}`,
    name ? `用户指定的名字：${name}（name 字段就用它）` : '',
    hint ? `补充要求：${hint}` : '',
    '只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：',
    '{',
    '  "name": "简短好记的中文名，2–10 个字",',
    '  "aliases": ["0–3 个别名或常见叫法"],',
    '  "tags": ["5–10 个短标签：风格、颜色、材质、场合等"],',
    '  "description": "给生图模型看的外观描述，100–250 字，写具体可画的细节，不写主观评价"',
    '}',
  ].filter(Boolean).join('\n')
}

/**
 * @param o { ctx, cfg, category, text, name, hint, signal }
 * @returns {Promise<{ name, aliases, tags, description }>}
 */
export async function expandText(o) {
  const prompt = expandPrompt(o.category, o.text, o.name, o.hint)
  const out = o.cfg.vision.source === 'openai'
    ? await askOpenAI(o.cfg, prompt, [], o.signal)
    : await askHost(o.ctx, o.cfg, prompt, [], o.signal)
  const f = parseFields(out)
  if (o.name) f.name = o.name
  return f
}
