/**
 * dsh-image-studio —— 宿主半：生图工具 + 发图说明注入 + 设置页 HTTP 接口。
 *
 *   image_generate  模型调用：画面描述 + 参考库条目 → 组合参考图 → 生图 API → 存本地
 *   image_library   模型调用：查参考库（库很大、目录没全列出来时用）
 *   systemPrompt    注入「何时发图 / 怎么调用 / 参考库目录」，三档策略 + 自定义规则 + 冷却
 *   webServer       /api/image-studio/*，设置页「生图工作室」与聊天里的出图卡片用
 *
 * 只 import node: 内置模块与同目录文件（本地 link 安装时裸包名解析不到宿主的包）。
 */
import { readFileSync } from 'node:fs'

import { abortAllJobs, outputAbs, runGeneration } from './engine.js'
import { createHandler, API_PREFIX } from './http.js'
import { scanAll } from './library.js'
import { getPresets, loadPresets } from './presets.js'
import { guideText, libraryQueryText } from './prompt.js'
import { cleanupStaging } from './sheets.js'
import { CATEGORIES, compactHistory, ensureDirs, getConfig, loadConfig } from './store.js'

export const name = 'image-studio'
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 每个会话上一次（工具）出图的时间，用于主动发图冷却。 */
const lastShot = new Map()

const IMAGE_GENERATE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description: '这张图的画面描述：谁在哪里、正在做什么、和周围的互动、构图与情绪重点。人物长相与服饰设计由参考图提供，不必重复；神态 / 动作 / 镜头 / 光线优先用下面的关键词参数，也可以直接写在这里。',
    },
    situation: { type: 'string', description: '情境关键词（如 在家休息、睡前、外出、工作学习），会自动带上对应的场景、服饰和光线。按角色此刻在哪、在做什么来选。' },
    expression: { type: 'string', description: '神态关键词（如 开心、害羞、困倦、委屈），按角色此刻的心情选；也可以直接写一句具体神态。' },
    pose: { type: 'string', description: '动作关键词（如 抱膝坐、趴着、托腮、伸懒腰），也可以直接写具体动作。' },
    shot: { type: 'string', description: '镜头关键词（如 自拍、近景、全身、俯视、第一人称）。' },
    light: { type: 'string', description: '光线关键词（如 午后暖阳、夜晚台灯、黄昏逆光）；不填时用情境的默认光线。' },
    characters: { type: 'array', items: { type: 'string' }, description: '人物库条目（id 或名字），可多个。' },
    outfits: { type: 'array', items: { type: 'string' }, description: '服饰库条目（id 或名字）。人物没指定服饰时会用其默认服饰。' },
    scene: { type: 'string', description: '场景库条目（id 或名字），只能一个。' },
    props: { type: 'array', items: { type: 'string' }, description: '道具库条目（id 或名字），可多个。' },
    extra_images: { type: 'array', items: { type: 'string' }, description: '可选：要在其基础上修改的图（之前生成的图片编号 img-…，或本机图片绝对路径），会作为第一张参考图。' },
    aspect: { type: 'string', description: '画幅比例，如 1:1、3:4、4:3、9:16、16:9；不填用默认。' },
    caption: { type: 'string', description: '可选：显示在图下面的一句配图说明。' },
    user_requested: { type: 'boolean', description: '用户本轮明确要求出图时为 true（不受主动发图间隔限制）。' },
  },
}

const LIBRARY_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: CATEGORIES, description: '只查某一个库：characters / outfits / scenes / props。' },
    query: { type: 'string', description: '关键词，匹配名字、别名、标签、描述；留空列出全部。' },
    id: { type: 'string', description: '查看某个条目的完整信息（含人设、外观描述）。' },
  },
}

const LOOSE_OBJECT = { type: 'object', additionalProperties: true }

const KW_LABEL = { situation: '情境', expression: '神态', pose: '动作', shot: '镜头', light: '光线' }

function seconds(ms) { return Math.max(1, Math.round((ms || 0) / 1000)) }

function refLine(refs) {
  const labels = { characters: '人物', outfits: '服饰', scenes: '场景', props: '道具' }
  return (refs || []).map((r) => (r.kind === 'extra' ? r.label : `${labels[r.category] || ''}「${r.name}」${r.count > 1 ? `×${r.count}` : ''}`)).join('、')
}

function renderGenerate(_args, value) {
  const v = value && typeof value === 'object' ? value : {}
  const blocks = []
  if (!v.ok) {
    blocks.push({ type: 'text', text: String(v.message || '没有生成图片。') })
    return blocks
  }
  const lines = [
    `已生成图片 ${v.id}（${[v.model, v.size, `用时 ${v.seconds} 秒`].filter(Boolean).join(' · ')}），已经显示在对话里给用户看了。`,
    `文件：${v.path}`,
  ]
  if (v.refs) lines.push(`用到的参考：${v.refs}`)
  if (v.keywords && Object.keys(v.keywords).length) lines.push(`关键词：${Object.entries(v.keywords).map(([k, x]) => `${KW_LABEL[k] || k}「${x}」`).join('、')}`)
  if (Array.isArray(v.notes) && v.notes.length) lines.push(`说明：${v.notes.join('；')}`)
  if (Array.isArray(v.unresolved) && v.unresolved.length) lines.push(`参考库里没找到：${v.unresolved.join('、')}（已只按文字描述画）`)
  lines.push('不用再向用户复述画面；想基于这张继续改，把图片编号放进 extra_images。若用户是在微信等外部渠道和你聊天，用对应发送工具（如 send_to_wechat）把上面的文件路径发过去。')
  blocks.push({ type: 'text', text: lines.join('\n') })
  if (Array.isArray(v.attachments)) {
    for (const attachment of v.attachments) blocks.push({ type: 'image', attachment })
  }
  return blocks
}

export function apply(ctx) {
  ensureDirs()
  loadConfig()
  loadPresets()
  compactHistory()
  cleanupStaging()
  scanAll(true)

  const logger = (() => {
    try { return typeof ctx.logger === 'function' ? ctx.logger('image-studio') : ctx.logger } catch { return null }
  })()
  const log = (level, msg) => { try { logger?.[level]?.(msg) } catch {} }
  // DSH 的 loader 偶尔会把插件装配两次：同名工具重复注册时跳过，别让整个插件失效
  const register = (def) => {
    try {
      return ctx.tools.register(def)
    } catch (error) {
      if (error instanceof Error && /already|duplicate|exists/i.test(error.message)) {
        log('warn', `image-studio: 工具 ${def.name} 已注册，跳过重复注册`)
        return () => {}
      }
      throw error
    }
  }

  // ---- 1. 工具：image_generate ------------------------------------------------
  register({
    name: 'image_generate',
    description: '生成一张图片并直接展示给用户。按画面描述和关键词（情境 / 神态 / 动作 / 镜头 / 光线），把本地参考库里选中的人物 / 服饰 / 场景 / 道具参考图一起交给生图模型：参考图只保证长相和设计一致，姿势表情构图由文字决定。何时调用见系统提示里的「生图」说明。',
    parameters: IMAGE_GENERATE_PARAMS,
    output: {
      schema: LOOSE_OBJECT,
      render: renderGenerate,
      presentationMeta: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {}
        return {
          studio: 'image-studio',
          ok: v.ok === true,
          id: typeof v.id === 'string' ? v.id : '',
          path: typeof v.path === 'string' ? v.path : '',
          count: Array.isArray(v.files) ? v.files.length : 0,
          caption: typeof v.caption === 'string' ? v.caption : '',
          refs: typeof v.refs === 'string' ? v.refs : '',
          keywords: v.keywords && typeof v.keywords === 'object' ? v.keywords : {},
          message: typeof v.message === 'string' ? v.message : '',
        }
      },
    },
    async execute(args, exec) {
      const cfg = getConfig()
      const a = args && typeof args === 'object' ? args : {}
      if (!cfg.enabled) return { ok: false, message: '生图插件已在设置里关闭，本次没有出图。' }
      const sessionId = String(exec?.agent?.session?.header?.id ?? exec?.agent?.id ?? '')
      if (a.user_requested !== true && cfg.policy.cooldownMin > 0 && sessionId) {
        const last = lastShot.get(sessionId) || 0
        const gapMin = (Date.now() - last) / 60000
        if (last > 0 && gapMin < cfg.policy.cooldownMin) {
          return {
            ok: false,
            message: `主动发图冷却中：距离上一张才 ${gapMin.toFixed(1)} 分钟（设定至少 ${cfg.policy.cooldownMin} 分钟）。这次先不发；如果用户明确要图，带上 user_requested: true 再调用。`,
          }
        }
      }
      const record = await runGeneration(a, { signal: exec?.signal, source: 'tool', sessionId })
      if (sessionId) lastShot.set(sessionId, Date.now())
      const files = (record.files || []).map(outputAbs)
      const value = {
        ok: true,
        id: record.id,
        path: files[0] || '',
        files,
        model: record.model || '',
        size: record.size || '',
        seconds: seconds(record.ms),
        refs: refLine(record.refs),
        notes: record.notes || [],
        unresolved: record.unresolved || [],
        keywords: record.keywords || {},
        caption: record.caption || '',
      }
      // 可选：让对话模型也「看到」这张图（需要宿主附件服务；模型不支持看图时别开）
      if (cfg.output.showToModel && files.length) {
        try {
          const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
          if (attachments && typeof attachments.saveImages === 'function') {
            const refs = await attachments.saveImages(files.slice(0, 1).map((f) => ({
              data: readFileSync(f),
              mediaType: f.endsWith('.jpg') || f.endsWith('.jpeg') ? 'image/jpeg' : f.endsWith('.webp') ? 'image/webp' : 'image/png',
              name: `${record.id}${f.slice(f.lastIndexOf('.'))}`,
            })))
            value.attachments = JSON.parse(JSON.stringify(refs))
          }
        } catch (e) {
          log('warn', `image-studio: 附件保存失败，模型只收到文字结果：${e?.message || e}`)
        }
      }
      return value
    },
  })

  // ---- 2. 工具：image_library -------------------------------------------------
  register({
    name: 'image_library',
    description: '查询本地生图参考库（人物 / 服饰 / 场景 / 道具）：按关键词搜，或按 id 看某个条目的完整信息（人设、外观描述）。只在系统提示里的目录不够用时才需要。',
    parameters: LIBRARY_PARAMS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      return libraryQueryText({ category: a.category, query: a.query, id: a.id })
    },
  })

  // ---- 3. 发图说明 + 参考库目录 ------------------------------------------------
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.context({
        name: 'image-studio:guide',
        order: 270,
        text: () => {
          try { return guideText(getConfig(), scanAll(), getPresets()) } catch { return '' }
        },
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) return () => {}
      throw error
    }
  }, 'dsh-image-studio: guide context')

  // ---- 4. 设置页 HTTP 接口 -----------------------------------------------------
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: createHandler(ctx) })
    return () => {
      abortAllJobs()
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-image-studio: http')

  const cfg = getConfig()
  log('info', `生图工作室已加载：${cfg.enabled ? '开' : '关'} · ${cfg.api.provider} · ${cfg.api.model} · ${cfg.api.apiKey ? '已填 Key' : '未填 Key'}`)
}
