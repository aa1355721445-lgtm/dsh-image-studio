/**
 * dsh-image-studio —— 注入给对话模型的「生图说明 + 参考库目录」。
 *
 * 发图时机做成三档（设置页可选）+ 自由补充规则 + 主动发图冷却。
 * 目录只列名字、id 和一句描述，控制在几 KB 内；库很大时提示用 image_library 查。
 * 文本只在内容变化时才会被宿主重新追加，所以不会打断提示词缓存。
 */
import { scanAll } from './library.js'
import { getPresets, PRESET_GROUPS, PRESET_LABEL } from './presets.js'
import { CATEGORIES, CATEGORY_LABEL } from './store.js'

const MODE_TEXT = {
  manual: '只在用户明确要图时调用（例如「画一张」「发张图」「让我看看」「生成图片」）。其余时候不要主动发图。',
  balanced: '用户要图时调用。此外，在画面感强、配一张图明显加分的时刻（进入新场景、换装、关键动作、重要瞬间）可以主动发一张；日常问答、写代码、处理文件时不要发，也不要连续几轮都发。',
  proactive: '在角色扮演和闲聊里积极配图：场景、动作、服装或情绪有明显变化时就主动发一张，让对话更有画面感；同一画面不要重复发；写代码等工作场景不发。',
}

const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 宿主把 {{名字}} 当模板变量，未注册的会让整段注入失败——统一降级成单花括号。 */
const safe = (s) => String(s).replace(/\{\{/g, '{').replace(/\}\}/g, '}')

export function catalogText(lib = scanAll(), maxChars = 3600) {
  const sections = []
  let budget = maxChars
  for (const c of CATEGORIES) {
    const list = lib[c] || []
    const head = `${CATEGORY_LABEL[c]}（${c}）`
    if (list.length === 0) {
      sections.push(`${head}：暂无`)
      continue
    }
    const items = []
    let shown = 0
    for (const e of list) {
      const idPart = e.id !== e.name ? ` [id: ${e.id}]` : ''
      const alias = e.aliases.length ? `（又名 ${e.aliases.slice(0, 3).join('/')}）` : ''
      const desc = e.description ? ` — ${oneLine(e.description, 40)}` : ''
      const imgs = e.images.length ? '' : ' (无图)'
      const item = `${e.name}${idPart}${alias}${desc}${imgs}`
      if (budget - item.length < 0) break
      budget -= item.length + 2
      items.push(item)
      shown++
    }
    const more = list.length > shown ? `；…还有 ${list.length - shown} 项，用 image_library 查` : ''
    sections.push(`${head}：${items.join('；')}${more}`)
  }
  return sections.join('\n')
}

export function keywordText(presets) {
  const lines = []
  for (const g of PRESET_GROUPS) {
    const items = (presets && presets[g]) || []
    if (!items.length) continue
    lines.push(`${PRESET_LABEL[g]}（${g}）：${items.map((x) => x.name).join('、')}`)
  }
  return lines.join('\n')
}

export function guideText(cfg, lib = scanAll(), presets = getPresets()) {
  if (!cfg.enabled) return ''
  const lines = []
  lines.push('# 生图（image_generate）')
  lines.push('你可以调用 image_generate 生成图片，图片会直接显示在对话里给用户看。')
  lines.push(`何时发图：${MODE_TEXT[cfg.policy.mode] || MODE_TEXT.balanced}`)
  if (cfg.policy.rules.trim()) lines.push(`用户补充的发图规则：${cfg.policy.rules.trim()}`)
  lines.push(cfg.policy.cooldownMin > 0
    ? `没被要求时，两次主动发图至少间隔 ${cfg.policy.cooldownMin} 分钟。用户本轮明确要图时把 user_requested 设为 true（不受间隔限制）。`
    : '用户本轮明确要图时把 user_requested 设为 true。')
  lines.push('怎么调用：先想清楚角色此刻的状态——在哪、在做什么、心情如何——再选关键词：situation（情境，会自动带上对应的场景、服饰和光线）、expression（神态）、pose（动作）、shot（镜头）、light（光线），填下面列出的名字即可，插件会展开成具体描写；没有合适的就直接写一句具体描述。prompt 写这一张画面本身：发生了什么、和周围的互动、构图与情绪重点。')
  lines.push('参考图只负责长相与服装设计；姿势、表情、视角、景别、光线都由关键词和 prompt 决定，不写就容易照搬参考图，所以每张图都要按当下的情境换着来，别总是同一个站姿和表情。')
  lines.push('用 characters / outfits / scene / props 指定参考库条目（填 id 或名字）；服饰不指定时会沿用全天日程里她此刻的穿着（装了日程插件时），否则按情境和场景自动搭配；想让她穿别的就在 outfits 里写明。想在上一张图的基础上修改时，把它的图片编号（img- 开头）放进 extra_images。一次调用出一张图，出图需要几十秒。')
  const kwText = keywordText(presets)
  if (kwText) {
    lines.push('可用关键词：')
    lines.push(kwText)
  }
  if (cfg.compose.catalogInPrompt) {
    lines.push('参考库：')
    lines.push(catalogText(lib))
  } else {
    lines.push('参考库里有哪些人物、服饰、场景、道具，用 image_library 查询。')
  }
  return safe(lines.join('\n'))
}

/** image_library 工具的文本结果。 */
export function libraryQueryText({ category, query, id }, lib = scanAll()) {
  const cats = category && CATEGORIES.includes(category) ? [category] : CATEGORIES
  if (id) {
    for (const c of cats) {
      const e = (lib[c] || []).find((x) => x.id === id || x.name === id)
      if (!e) continue
      return safe([
        `${CATEGORY_LABEL[c]}「${e.name}」 id: ${e.id}`,
        e.aliases.length ? `别名：${e.aliases.join('、')}` : '',
        e.tags.length ? `标签：${e.tags.join('、')}` : '',
        `参考图：${e.images.length} 张`,
        e.description ? `外观描述：${e.description}` : '',
        e.defaultOutfit ? `默认服饰：${e.defaultOutfit}` : '',
        e.traits ? `神态特点：${e.traits}` : '',
        e.situationOutfits && Object.keys(e.situationOutfits).length ? `情境穿搭：${Object.entries(e.situationOutfits).map(([k, v]) => `${k}→${v}`).join('、')}` : '',
        e.persona ? `人设：\n${e.persona}` : '',
      ].filter(Boolean).join('\n'))
    }
    return `没找到 id 或名字为「${id}」的条目。`
  }
  const q = String(query ?? '').trim().toLowerCase()
  const out = []
  for (const c of cats) {
    const hits = (lib[c] || []).filter((e) => q === '' || [e.id, e.name, ...e.aliases, ...e.tags, e.description].some((s) => String(s).toLowerCase().includes(q)))
    if (hits.length === 0) continue
    out.push(`## ${CATEGORY_LABEL[c]}（${c}）`)
    for (const e of hits.slice(0, 60)) {
      out.push(`- ${e.name} [id: ${e.id}] ${e.images.length} 张图${e.tags.length ? ` · ${e.tags.join('/')}` : ''}${e.description ? ` — ${oneLine(e.description, 80)}` : ''}`)
    }
    if (hits.length > 60) out.push(`…还有 ${hits.length - 60} 项`)
  }
  return safe(out.length ? out.join('\n') : (q ? `没有匹配「${query}」的条目。` : '参考库是空的。'))
}
