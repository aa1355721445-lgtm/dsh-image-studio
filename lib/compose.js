/**
 * dsh-image-studio —— 把「画面描述 + 关键词 + 选中的库条目」组合成一次生图请求。
 *
 * 1. 关键词：情境 / 神态 / 动作 / 镜头 / 光线填名字即可，展开成具体描写；没收录的词原样当描述用；
 * 2. 情境带出默认搭配：场景、光线，以及服饰——人物在该情境的专属服饰 > 情境默认服饰；
 * 3. 解析人物 / 服饰 / 场景 / 道具（id、名字、别名都认），可选自动认出描述里提到的库名字；
 * 4. 服饰兜底顺序：显式指定 > 人物的情境穿搭 > 情境默认 > 场景默认 > 人物默认；
 * 5. 按优先级挑参考图（上一张图 > 人物 > 服饰 > 场景 > 道具），总数不超过 maxRefs；
 * 6. 给每张参考图编号并写明「只取什么」——参考图只管长相与设计，
 *    姿势、表情、视角、构图都由文字决定（2026-10-27：出图照抄参考图姿势的问题就出在这里）。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { mentionedIn, resolveRef, scanAll } from './library.js'
import { findPreset, getPresets, PRESET_LABEL } from './presets.js'
import { CATEGORY_LABEL, categoryDir, findHistory, outputsRoot } from './store.js'

const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() !== '' ? [v] : [])
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function normalizeAspect(v, fallback) {
  const s = String(v ?? '').trim().replace(/[：]/g, ':').replace(/[×*X]/g, 'x')
  if (/^\d{1,2}:\d{1,2}$/.test(s)) return s
  if (/^\d{3,4}x\d{3,4}$/.test(s)) return s
  return fallback
}

export function entryImagePath(entry, file) {
  return entry.kind === 'file'
    ? path.join(categoryDir(entry.category), entry.file)
    : path.join(categoryDir(entry.category), entry.id, file)
}

/** 上一张生成图：历史 id 或绝对路径。 */
function resolveExtra(ref) {
  const s = String(ref).trim()
  if (s === '') return null
  const h = findHistory(s)
  if (h && Array.isArray(h.files) && h.files.length) {
    const p = path.join(outputsRoot(), ...String(h.files[0]).split('/'))
    if (existsSync(p)) return { label: `上一张生成图（${s}）`, absPath: p }
  }
  if (path.isAbsolute(s) && existsSync(s) && /\.(png|jpe?g|webp|gif)$/i.test(s)) {
    return { label: `图片 ${path.basename(s)}`, absPath: s }
  }
  return null
}

/** 关键词展开：收录的词 → 具体描写；没收录的原样用。 */
function keyword(group, raw, presets) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  const p = findPreset(group, v, presets)
  return p ? { name: p.name, text: p.prompt || p.name, preset: true } : { name: v, text: v, preset: false }
}

/**
 * @param args  工具参数（prompt / situation / expression / pose / shot / light /
 *              characters / outfits / scene / props / extra_images / aspect）
 * @returns {{ selected, refs, finalPrompt, aspect, notes, unresolved, keywords }}
 */
export function compose(args, cfg, lib = scanAll(), presets = getPresets()) {
  const notes = []
  const unresolved = []
  const prompt = String(args.prompt ?? '').trim()

  // ---- 关键词 ----
  const situation = keyword('situation', args.situation, presets)
  const sit = situation && situation.preset ? findPreset('situation', situation.name, presets) : null
  const kw = {}
  for (const g of ['expression', 'pose', 'shot', 'light']) {
    const k = keyword(g, args[g], presets)
    if (k) kw[g] = k
  }
  if (!kw.light && sit && sit.light) kw.light = keyword('light', sit.light, presets)

  // ---- 库条目 ----
  const pickMany = (category, refs) => {
    const out = []
    for (const r of refs) {
      const e = resolveRef(category, r, lib)
      if (e === null) unresolved.push(`${CATEGORY_LABEL[category]}「${r}」`)
      else if (!out.includes(e)) out.push(e)
    }
    return out
  }
  const characters = pickMany('characters', asList(args.characters))
  const outfits = pickMany('outfits', asList(args.outfits))
  const scenes = pickMany('scenes', asList(args.scene))
  const props = pickMany('props', asList(args.props))
  if (scenes.length > 1) notes.push(`场景只能用一个，已用「${scenes[0].name}」`)
  let scene = scenes[0] || null
  const textOnly = [] // 库里没有、只能写成文字的搭配

  // 情境的默认场景
  if (scene === null && sit && sit.scene) {
    const e = resolveRef('scenes', sit.scene, lib)
    if (e) { scene = e; notes.push(`情境「${sit.name}」→ 场景「${e.name}」`) } else textOnly.push(`场景：${sit.scene}`)
  }

  // 自动认出画面描述里提到的条目
  const auto = []
  if (cfg.compose.autoMatch && prompt !== '') {
    for (const e of mentionedIn('characters', prompt, lib)) if (!characters.includes(e)) { characters.push(e); auto.push(e) }
    for (const e of mentionedIn('outfits', prompt, lib)) if (!outfits.includes(e)) { outfits.push(e); auto.push(e) }
    if (scene === null) {
      const hits = mentionedIn('scenes', prompt, lib)
      if (hits.length) { scene = hits[0]; auto.push(hits[0]) }
    }
    for (const e of mentionedIn('props', prompt, lib)) if (!props.includes(e)) { props.push(e); auto.push(e) }
  }
  if (auto.length) notes.push(`从画面描述里自动认出：${auto.map((e) => `${CATEGORY_LABEL[e.category]}「${e.name}」`).join('、')}`)

  // 服饰兜底：人物的情境穿搭 > 情境默认 > 场景默认 > 人物默认
  if (outfits.length === 0 && cfg.compose.useDefaultOutfit) {
    for (const c of characters) {
      const candidates = [
        sit && c.situationOutfits && c.situationOutfits[sit.name] ? [c.situationOutfits[sit.name], `「${c.name}」在情境「${sit.name}」的穿搭`] : null,
        sit && sit.outfit ? [sit.outfit, `情境「${sit.name}」的默认服饰`] : null,
        scene && scene.defaultOutfit ? [scene.defaultOutfit, `场景「${scene.name}」的默认服饰`] : null,
        c.defaultOutfit ? [c.defaultOutfit, `「${c.name}」的默认服饰`] : null,
      ].filter(Boolean)
      for (const [name, why] of candidates) {
        const o = resolveRef('outfits', name, lib)
        if (o) {
          if (!outfits.includes(o)) outfits.push(o)
          notes.push(`${why}「${o.name}」`)
          break
        }
        if (name) {
          textOnly.push(`${c.name}穿着${name}`)
          notes.push(`${why}「${name}」库里没有，只按文字描述`)
          break
        }
      }
    }
  }

  // ---- 挑参考图 ----
  const extrasRaw = asList(args.extra_images)
  const extras = extrasRaw.map(resolveExtra)
  extras.forEach((x, i) => { if (x === null) unresolved.push(`参考图「${extrasRaw[i]}」`) })
  const extraRefs = extras.filter(Boolean)

  const ordered = [...characters, ...outfits, ...(scene ? [scene] : []), ...props]
  const quota = (e) => (e.category === 'characters' ? cfg.compose.refsPerCharacter : cfg.compose.refsPerOther)
  const budget = Math.max(0, cfg.compose.maxRefs - extraRefs.length)
  const chosen = new Map(ordered.map((e) => [e, []]))
  let used = 0
  for (let round = 0; round < 6 && used < budget; round++) {
    for (const e of ordered) {
      if (used >= budget) break
      const picked = chosen.get(e)
      if (picked.length > round || picked.length >= quota(e)) continue
      const img = e.images[round]
      if (!img) continue
      picked.push(img.file)
      used++
    }
  }
  const dropped = ordered.filter((e) => e.images.length > 0 && chosen.get(e).length === 0)
  if (dropped.length) notes.push(`参考图超过上限 ${cfg.compose.maxRefs} 张，没放进去：${dropped.map((e) => e.name).join('、')}（只按文字描述）`)

  const refs = []
  for (const x of extraRefs) refs.push({ kind: 'extra', label: x.label, absPath: x.absPath })
  for (const e of ordered) {
    for (const f of chosen.get(e)) {
      refs.push({ kind: 'entry', category: e.category, entryId: e.id, name: e.name, file: f, absPath: entryImagePath(e, f) })
    }
  }

  // ---- 写提示词 ----
  const loose = cfg.compose.identityOnly !== false
  const single = characters.length === 1 ? characters[0] : null
  const hint = loose
    ? {
      characters: '只用来确定长相：脸型五官、发型发色、瞳色、体型比例和标志性特征。参考图里的姿势、表情、视角和背景都不要照搬。',
      outfits: single ? `只参考服装设计（款式、颜色、材质、细节），穿在「${single.name}」身上，随动作自然起褶变形。` : '只参考服装设计（款式、颜色、材质、细节），随人物动作自然起褶变形。',
      scenes: '只参考空间、陈设、配色与风格；镜头角度和取景按上面的描述重新安排。',
      props: '只参考外形、材质与配色。',
    }
    : {
      characters: '外貌（脸、发型发色、体型、标志性特征）严格以参考图为准。',
      outfits: single ? `给「${single.name}」穿上这套服饰，款式、材质与配色按参考图还原。` : '服饰款式、材质与配色按参考图还原。',
      scenes: '画面发生在这个场景里，空间布局、陈设与光线氛围参考此图。',
      props: '道具外形按参考图还原。',
    }

  const parts = []
  if (cfg.compose.stylePrompt.trim()) parts.push(`【画风】${cfg.compose.stylePrompt.trim()}`)
  parts.push(`【画面】${prompt}`)
  if (situation) {
    const extra = sit && sit.prompt ? `：${sit.prompt}` : ''
    parts.push(`【情境】${situation.name}${extra}`)
  }
  for (const g of ['expression', 'pose', 'shot', 'light']) {
    if (kw[g]) parts.push(`【${g === 'light' ? '光线氛围' : PRESET_LABEL[g]}】${kw[g].text}`)
  }
  const traits = characters.filter((c) => c.traits && c.traits.trim())
  if (traits.length) parts.push(`【人物神态特点】\n${traits.map((c) => `${c.name}：${oneLine(c.traits)}`).join('\n')}`)
  if (textOnly.length) parts.push(`【搭配】${textOnly.join('；')}`)

  const lines = []
  let n = 0
  const range = (count) => {
    const a = n + 1
    n += count
    return count === 1 ? `图${a}` : `图${a}–${n}`
  }
  if (extraRefs.length) lines.push(`${range(extraRefs.length)}：${extraRefs.map((x) => x.label).join('、')}——在它的基础上按要求修改，没提到要改的部分保持不变。`)
  const noImage = []
  for (const e of ordered) {
    const cnt = chosen.get(e).length
    const desc = e.description ? oneLine(e.description) : ''
    if (cnt === 0) {
      noImage.push(`${CATEGORY_LABEL[e.category]}「${e.name}」：${desc || '（无描述）'}`)
      continue
    }
    lines.push(`${range(cnt)}：${CATEGORY_LABEL[e.category]}「${e.name}」——${hint[e.category]}${desc ? `\n  外观：${desc}` : ''}`)
  }
  if (lines.length) parts.push(`【参考图说明（按上传顺序编号）】\n${lines.join('\n')}`)
  if (noImage.length) parts.push(`【没有参考图、只按文字描述的元素】\n${noImage.join('\n')}`)
  if (lines.length) {
    parts.push(loose
      ? '要求：画一张全新的画面，不要把参考图拼贴、并排或作为画中画放进去。参考图只负责「长得像」：脸、发型发色、体型、标志性特征、服装款式与配色必须一致。构图、视角、景别、姿势、动作、手势、朝向、表情、光线方向和背景陈设，一律按上面的【画面】【情境】【神态】【动作】【镜头】【光线氛围】重新安排，不要沿用任何一张参考图里的站姿、坐姿、表情或取景；两者冲突时以文字为准。'
      : '要求：把以上参考融合成一张完整、自然的新画面，不要把参考图拼贴、并排或作为画中画放进画面；人物外貌必须与参考图一致。')
  }

  const keywords = {}
  if (situation) keywords.situation = situation.name
  for (const g of ['expression', 'pose', 'shot', 'light']) if (kw[g]) keywords[g] = kw[g].name

  return {
    selected: { characters, outfits, scene, props },
    refs,
    finalPrompt: parts.join('\n\n'),
    aspect: normalizeAspect(args.aspect, cfg.api.defaultAspect),
    notes,
    unresolved,
    keywords,
  }
}
