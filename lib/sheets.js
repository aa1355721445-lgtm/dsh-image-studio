/**
 * dsh-image-studio —— 「参考图 → 三视图」与图片导入。
 *
 * 导入流程：上传图片（暂存到 staging/<importId>/）→ 识图整理名字 / 别名 / 标签 / 外观描述
 * → 以原图为参考生成三视图（场景是设定图）→ 设置页里确认、可改 → 存进参考库（三视图做封面）。
 * 已有条目也可以单独「生成三视图」「识别补全描述」。
 *
 * 三视图是中性站姿、白底、无表情的设定图，拿它当人物 / 服饰参考，生图时更不容易照抄姿势。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { outputAbs, runRawGeneration, startTask } from './engine.js'
import { addImages, imagePath, saveEntry, scanAll, sniffImage } from './library.js'
import { CATEGORIES, CATEGORY_LABEL, findHistory, getConfig, newId, stagingRoot } from './store.js'
import { analyzeImages, expandText } from './vision.js'

export const SHEET_ASPECT = { characters: '16:9', outfits: '16:9', props: '16:9', scenes: '4:3' }
export const SHEET_LABEL = { characters: '角色三视图', outfits: '服装三视图', props: '道具三视图', scenes: '场景设定图' }
const SHEET_FILE = { characters: '三视图', outfits: '三视图', props: '三视图', scenes: '设定图' }

const SHEET_PROMPTS = {
  characters: [
    '根据参考图中的角色，画一张标准的角色设定三视图（character turnaround sheet）。',
    '· 同一个角色的正面、侧面（面朝右）、背面三个全身像，从左到右横向等距排列；三个视图大小一致，头顶和脚底对齐，全身完整入画、不被裁切。',
    '· 姿势统一为自然站立的 A 字站姿：双臂自然下垂、微微离开身体，双脚与肩同宽；表情平静中性，目视前方。',
    '· 严格还原参考图中角色的脸型五官、发型发色、瞳色、肤色、体型比例和所有标志性特征（如兽耳、尾巴、饰品），以及身上的服装与配饰；参考图里看不到的部分（背面、侧面）按同一设计合理补全，三个视图之间保持完全一致。',
    '· 纯白背景；不要场景、道具、文字、标注、尺寸线或分格框线；均匀柔和的平光，没有强烈阴影。',
    '· 保持参考图原本的画风与上色方式。',
  ],
  outfits: [
    '根据参考图中的服装，画一张服装设计三视图（fashion design sheet）。',
    '· 只展示这套服装本身：把它穿在一个没有五官和发型的浅灰色素体人台上，不要出现参考图里模特的长相、姿势或背景。',
    '· 正面、侧面、背面三个全身视图从左到右横向等距排列，大小一致、上下对齐，整套服装完整入画。',
    '· 准确还原版型、长度、颜色、图案、面料质感和所有结构细节（领口、袖口、腰线、裙摆、褶裥、纽扣拉链、蕾丝花边等），连同鞋袜和配饰；参考图看不到的背面、侧面按同一款式合理补全。',
    '· 纯白背景；不要文字、标注或分格框线；均匀柔和的光照。',
  ],
  props: [
    '根据参考图中的物品，画一张道具设计三视图（prop design sheet）。',
    '· 只画这个物品本身，去掉拿着它的手、人物和周围的杂物。',
    '· 正面、侧面、背面三个视图，再加一个 45° 斜侧透视图，从左到右横向排列，比例一致、底部对齐。',
    '· 准确还原外形结构、比例、颜色、材质质感、纹理图案和细节；看不到的部分按同一设计合理补全。',
    '· 纯白背景，只保留极淡的接触阴影；不要文字、标注或分格框线；均匀柔和的光照。',
  ],
  scenes: [
    '根据参考图中的场景，画一张场景设定图（environment design sheet），之后会在这个场景里画角色。',
    '· 去掉画面里所有的人物和动物，只保留空间本身。',
    '· 版式：上方是一张宽幅的主视角全景；下方左边是从相反方向看过去的反向视角，右边是一张俯视的平面布局示意图（简洁的线条加色块）。三格之间用细白边分隔。',
    '· 准确还原空间结构、门窗位置、主要家具和陈设、材质、配色、光线氛围与时代风格；参考图看不到的部分按同一风格合理延伸，三个视角之间的家具位置要对得上。',
    '· 不要文字和标注；保持参考图的画风。',
  ],
}

// 没有参考图、只凭文字设计时用的版本
const TEXT_SHEET_PROMPTS = {
  characters: [
    '根据下面的角色设定，原创这个角色，画一张标准的角色设定三视图（character turnaround sheet）。',
    '· 同一个角色的正面、侧面（面朝右）、背面三个全身像，从左到右横向等距排列；三个视图大小一致，头顶和脚底对齐，全身完整入画、不被裁切。',
    '· 姿势统一为自然站立的 A 字站姿：双臂自然下垂、微微离开身体，双脚与肩同宽；表情平静中性，目视前方。',
    '· 按设定画出脸型五官、发型发色、瞳色、肤色、体型比例、标志性特征和服装配饰；设定没写到的细节自行合理设计，三个视图之间保持完全一致。',
    '· 纯白背景；不要场景、道具、文字、标注、尺寸线或分格框线；均匀柔和的平光，没有强烈阴影。',
    '· 画风：干净精致的二次元角色设定图，线条清晰、配色明快（设定或补充要求里指定了画风时以那个为准）。',
  ],
  outfits: [
    '根据下面的服装设定，设计这套服装，画一张服装设计三视图（fashion design sheet）。',
    '· 把服装穿在一个没有五官和发型的浅灰色素体人台上展示。',
    '· 正面、侧面、背面三个全身视图从左到右横向等距排列，大小一致、上下对齐，整套服装完整入画。',
    '· 画清楚版型、长度、颜色、图案、面料质感和结构细节（领口、袖口、腰线、裙摆、褶裥、纽扣拉链、花边等），连同鞋袜和配饰；设定没写到的部分按整体风格合理设计，三个视图保持一致。',
    '· 纯白背景；不要文字、标注或分格框线；均匀柔和的光照。',
    '· 画风：干净精致的二次元服装设定图（另有指定时以指定为准）。',
  ],
  props: [
    '根据下面的道具设定，设计这个物品，画一张道具设计三视图（prop design sheet）。',
    '· 只画这个物品本身。',
    '· 正面、侧面、背面三个视图，再加一个 45° 斜侧透视图，从左到右横向排列，比例一致、底部对齐。',
    '· 画清楚外形结构、比例、颜色、材质质感、纹理图案和细节；设定没写到的部分合理设计，各视图保持一致。',
    '· 纯白背景，只保留极淡的接触阴影；不要文字、标注或分格框线；均匀柔和的光照。',
    '· 画风：干净精致的二次元道具设定图（另有指定时以指定为准）。',
  ],
  scenes: [
    '根据下面的场景设定，设计这个空间，画一张场景设定图（environment design sheet），之后会在这个场景里画角色。',
    '· 画面里不要出现人物和动物。',
    '· 版式：上方是一张宽幅的主视角全景；下方左边是从相反方向看过去的反向视角，右边是一张俯视的平面布局示意图（简洁的线条加色块）。三格之间用细白边分隔。',
    '· 画清楚空间结构、门窗位置、主要家具和陈设、材质、配色、光线氛围与风格；三个视角之间的家具位置要对得上。',
    '· 不要文字和标注。',
    '· 画风：精致的二次元背景美术（另有指定时以指定为准）。',
  ],
}

export function textSheetPrompt(category, description, userText, hint) {
  const lines = [...(TEXT_SHEET_PROMPTS[category] || TEXT_SHEET_PROMPTS.props)]
  const d = String(description || '').replace(/\s+/g, ' ').trim()
  const t = String(userText || '').replace(/\s+/g, ' ').trim()
  if (d) lines.push(`设定：${d}`)
  if (t && t !== d) lines.push(`用户的原始要求（必须满足）：${t}`)
  if (hint && hint.trim()) lines.push(`补充要求（优先遵守）：${hint.trim()}`)
  return lines.join('\n')
}

export function sheetPrompt(category, description, hint) {
  const lines = [...(SHEET_PROMPTS[category] || SHEET_PROMPTS.props)]
  if (description && description.trim()) lines.push(`参考描述（帮助还原细节）：${description.replace(/\s+/g, ' ').trim()}`)
  if (hint && hint.trim()) lines.push(`补充要求（优先遵守）：${hint.trim()}`)
  return lines.join('\n')
}

// ---- 暂存区 -------------------------------------------------------------------

function importDir(importId) {
  if (!/^imp-[\w-]+$/.test(String(importId))) throw Object.assign(new Error('导入编号无效'), { status: 400 })
  return path.join(stagingRoot(), importId)
}

function readImportMeta(importId) {
  const dir = importDir(importId)
  try { return JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch {
    throw Object.assign(new Error('这次导入已经过期或被清理了，请重新上传'), { status: 404 })
  }
}

function sourcePaths(importId) {
  const meta = readImportMeta(importId)
  return meta.sources.map((f) => path.join(importDir(importId), f)).filter((p) => existsSync(p))
}

/** 暂存区里的原图绝对路径（设置页预览用）。 */
export function stagedFile(importId, file) {
  if (!/^src-\d+\.(png|jpe?g|webp|gif)$/i.test(String(file))) return null
  const p = path.join(importDir(importId), file)
  return existsSync(p) ? p : null
}

/** 清理两天前的暂存。 */
export function cleanupStaging(maxAgeMs = 2 * 24 * 3600 * 1000) {
  let names = []
  try { names = readdirSync(stagingRoot()) } catch { return }
  for (const n of names) {
    const p = path.join(stagingRoot(), n)
    try { if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true }) } catch {}
  }
}

function assertCategory(category) {
  if (!CATEGORIES.includes(category)) throw Object.assign(new Error(`未知的库：${category}`), { status: 400 })
}

const emptyFields = () => ({ name: '', aliases: [], tags: [], description: '' })

async function makeSheet({ category, refPaths, description, hint, name, signal, userText }) {
  const rec = await runRawGeneration({
    prompt: refPaths.length ? sheetPrompt(category, description, hint) : textSheetPrompt(category, description, userText, hint),
    refPaths,
    aspect: SHEET_ASPECT[category],
    source: 'sheet',
    label: `${SHEET_LABEL[category]}${name ? `「${name}」` : ''}`,
    refs: refPaths.map((p, i) => ({ kind: 'extra', label: `原图 ${i + 1}` })),
  }, { signal })
  return { id: rec.id, file: rec.files[0] }
}

// ---- 导入 ---------------------------------------------------------------------

/**
 * @param ctx 插件 ctx（识图要用宿主的 llm / attachments）
 * @param o { category, files: [{ name, data: Buffer }], hint, analyze, sheet }
 * @returns {{ jobId, importId }}
 */
export function startImport(ctx, o) {
  assertCategory(o.category)
  const files = (o.files || []).slice(0, 4)
  if (!files.length) throw Object.assign(new Error('没有收到图片'), { status: 400 })
  const importId = newId('imp-')
  const dir = importDir(importId)
  mkdirSync(dir, { recursive: true })
  const sources = []
  files.forEach((f, i) => {
    const ext = sniffImage(f.data)
    if (!ext) throw Object.assign(new Error(`「${f.name}」不是支持的图片（PNG / JPEG / WebP / GIF）`), { status: 400 })
    const name = `src-${i + 1}${ext}`
    writeFileSync(path.join(dir, name), f.data)
    sources.push(name)
  })
  const hint = String(o.hint || '').slice(0, 500)
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ category: o.category, hint, sources, createdAt: new Date().toISOString() }), 'utf8')
  const analyze = o.analyze !== false
  const sheet = o.sheet !== false
  const jobId = startTask('import', async ({ signal, stage }) => {
    const paths = sources.map((s) => path.join(dir, s))
    let fields = null
    let analysisError = ''
    if (analyze) {
      stage('识别图片')
      try { fields = await analyzeImages({ ctx, cfg: getConfig(), paths, category: o.category, hint, signal }) } catch (e) {
        if (signal.aborted) throw e
        analysisError = String(e?.message || e)
      }
    }
    let sheetRef = null
    let sheetError = ''
    if (sheet) {
      stage(`生成${SHEET_LABEL[o.category]}`)
      try { sheetRef = await makeSheet({ category: o.category, refPaths: paths, description: fields?.description, hint, name: fields?.name, signal }) } catch (e) {
        if (signal.aborted) throw e
        sheetError = String(e?.message || e)
      }
    }
    if (!fields && !sheetRef && (analyze || sheet)) throw new Error([analysisError, sheetError].filter(Boolean).join('；') || '识图和生成都没有成功')
    return { importId, category: o.category, hint, sources, fields: fields || emptyFields(), analysisError, sheet: sheetRef, sheetError }
  }, analyze ? '识别图片' : `生成${SHEET_LABEL[o.category]}`)
  return { jobId, importId }
}

/**
 * 文生素材：一段文字 → 扩写成条目（名字 / 别名 / 标签 / 描述）→ 按描述画三视图。
 * 结果形状和图片导入一样，之后同样走 startImportSheet / commitImport。
 * @param o { category, text, name, hint, expand, sheet }
 */
export function startTextCreate(ctx, o) {
  assertCategory(o.category)
  const text = String(o.text || '').trim().slice(0, 2000)
  if (!text) throw Object.assign(new Error('先写一下要生成什么'), { status: 400 })
  const name = String(o.name || '').trim().slice(0, 40)
  const hint = String(o.hint || '').slice(0, 500)
  const importId = newId('imp-')
  const dir = importDir(importId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ category: o.category, mode: 'text', text, name, hint, sources: [], createdAt: new Date().toISOString() }), 'utf8')
  const expand = o.expand !== false
  const sheet = o.sheet !== false
  const jobId = startTask('text-create', async ({ signal, stage }) => {
    let fields = null
    let analysisError = ''
    if (expand) {
      stage('扩写描述')
      try { fields = await expandText({ ctx, cfg: getConfig(), category: o.category, text, name, hint, signal }) } catch (e) {
        if (signal.aborted) throw e
        analysisError = String(e?.message || e)
      }
    }
    if (!fields) fields = { name: name || text.replace(/[，。,.!！?？\s].*$/s, '').slice(0, 10), aliases: [], tags: [], description: text }
    let sheetRef = null
    let sheetError = ''
    if (sheet) {
      stage(`生成${SHEET_LABEL[o.category]}`)
      try { sheetRef = await makeSheet({ category: o.category, refPaths: [], description: fields.description, userText: text, hint, name: fields.name, signal }) } catch (e) {
        if (signal.aborted) throw e
        sheetError = String(e?.message || e)
      }
    }
    if (sheet && !sheetRef && (!expand || analysisError)) throw new Error([analysisError, sheetError].filter(Boolean).join('；'))
    return { importId, category: o.category, mode: 'text', text, hint, sources: [], fields, analysisError, sheet: sheetRef, sheetError }
  }, expand ? '扩写描述' : `生成${SHEET_LABEL[o.category]}`)
  return { jobId, importId }
}

/** 用暂存的原图重新生成三视图（可以换补充要求）。 */
export function startImportSheet(ctx, o) {
  const meta = readImportMeta(o.importId)
  const textMode = meta.mode === 'text'
  const paths = textMode ? [] : sourcePaths(o.importId)
  if (!textMode && !paths.length) throw Object.assign(new Error('暂存的原图不见了，请重新上传'), { status: 404 })
  if (textMode && !String(o.description || meta.text || '').trim()) throw Object.assign(new Error('描述是空的，没法生成'), { status: 400 })
  return startTask('import-sheet', async ({ signal }) => {
    const sheet = await makeSheet({ category: meta.category, refPaths: paths, description: o.description || meta.text, userText: meta.text, hint: o.hint ?? meta.hint, name: o.name, signal })
    return { sheet }
  }, `生成${SHEET_LABEL[meta.category]}`)
}

/**
 * 确认入库。
 * @param o { importId, fields, sheetId, useSheet, useOriginals, targetId }
 * @returns 新（或更新后的）条目
 */
export function commitImport(o) {
  const meta = readImportMeta(o.importId)
  const category = meta.category
  const files = []
  if (o.useSheet !== false && o.sheetId) {
    const h = findHistory(String(o.sheetId))
    const rel = h && h.files && h.files[0]
    if (!rel || !existsSync(outputAbs(rel))) throw Object.assign(new Error('三视图文件不见了，重新生成一次'), { status: 404 })
    files.push({ name: SHEET_FILE[category], data: readFileSync(outputAbs(rel)) })
  }
  if (o.useOriginals !== false) {
    for (const p of sourcePaths(o.importId)) files.push({ name: '原图', data: readFileSync(p) })
  }
  const fields = o.fields && typeof o.fields === 'object' ? o.fields : {}
  if (!files.length && (o.targetId || meta.mode !== 'text')) throw Object.assign(new Error('没有要存的图片（三视图和原图都没勾）'), { status: 400 })
  let entry
  if (o.targetId) {
    const existing = scanAll(true)[category].find((e) => e.id === o.targetId)
    if (!existing) throw Object.assign(new Error(`条目不存在：${o.targetId}`), { status: 404 })
    entry = addImages(category, existing.id, files, { asCover: o.useSheet !== false && !!o.sheetId }).entry
    const patch = { id: entry.id }
    if (!entry.description && fields.description) patch.description = fields.description
    const tags = [...new Set([...(entry.tags || []), ...(Array.isArray(fields.tags) ? fields.tags : [])])]
    if (tags.length !== entry.tags.length) patch.tags = tags
    if (Object.keys(patch).length > 1) entry = saveEntry(category, patch)
  } else {
    const name = String(fields.name || '').trim() || `新${CATEGORY_LABEL[category]}`
    entry = saveEntry(category, { name, aliases: fields.aliases || [], tags: fields.tags || [], description: fields.description || '' })
    if (files.length) entry = addImages(category, entry.id, files, { asCover: true }).entry
  }
  discardImport(o.importId)
  return entry
}

export function discardImport(importId) {
  try { rmSync(importDir(importId), { recursive: true, force: true }) } catch {}
}

// ---- 已有条目 -----------------------------------------------------------------

function entryOf(category, id) {
  assertCategory(category)
  const e = scanAll(true)[category].find((x) => x.id === id)
  if (!e) throw Object.assign(new Error(`条目不存在：${id}`), { status: 404 })
  return e
}

/** 以条目的某张图（默认封面）为参考生成三视图，存进条目并设为封面。 */
export function startEntrySheet(ctx, o) {
  const e = entryOf(o.category, String(o.id))
  const file = o.file || e.cover || (e.images[0] && e.images[0].file)
  const ref = file ? imagePath(o.category, e.id, file) : null
  if (!ref) throw Object.assign(new Error('这个条目还没有参考图'), { status: 400 })
  return startTask('entry-sheet', async ({ signal }) => {
    const sheet = await makeSheet({ category: o.category, refPaths: [ref], description: e.description, hint: o.hint, name: e.name, signal })
    const data = readFileSync(outputAbs(findHistory(sheet.id).files[0]))
    const r = addImages(o.category, e.id, [{ name: SHEET_FILE[o.category], data }], { asCover: true })
    return { entry: r.entry, sheet }
  }, `生成${SHEET_LABEL[o.category]}`)
}

/** 识别条目的图片，返回建议的名字 / 别名 / 标签 / 描述（由设置页决定怎么填）。 */
export function startEntryAnalyze(ctx, o) {
  const e = entryOf(o.category, String(o.id))
  const paths = e.images.slice(0, 3).map((i) => imagePath(o.category, e.id, i.file)).filter(Boolean)
  if (!paths.length) throw Object.assign(new Error('这个条目还没有参考图'), { status: 400 })
  return startTask('entry-analyze', async ({ signal }) => {
    const fields = await analyzeImages({ ctx, cfg: getConfig(), paths, category: o.category, hint: o.hint, signal })
    return { fields }
  }, '识别图片')
}
