/**
 * dsh-image-studio —— 本地参考库（人物 / 服饰 / 场景 / 道具，四个独立目录）。
 *
 * 目录约定（对手工整理也友好）：
 *   <库目录>/<条目名>/entry.json  + 若干参考图   ← 设置页新建的条目都是这种
 *   <库目录>/<条目名>/若干参考图（没有 entry.json）  ← 直接拖一个文件夹进来也算一条
 *   <库目录>/<图片>.png                            ← 散图也算一条（名字 = 文件名）
 * 以 . 开头的文件/目录忽略。设置页编辑散图条目时，会先把它收进同名文件夹。
 *
 * entry.json：
 *   { name, aliases[], tags[], description, persona, traits, defaultOutfit, situationOutfits{}, cover, createdAt, updatedAt }
 *   description      = 外观/视觉描述（会写进生图提示词）
 *   persona          = 人设（只给对话模型参考，不发给生图 API）
 *   traits           = 神态 / 小动作特点（人物；会写进生图提示词，例如「开心时尾巴会摇」）
 *   defaultOutfit    = 默认服饰（人物：没指定时穿；场景：在这个场景里默认穿）
 *   situationOutfits = 人物在各「情境」下穿什么：{ 情境名: 服饰名 }
 */
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { CATEGORIES, categoryDir, trashRoot } from './store.js'

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const META = 'entry.json'
const CACHE_TTL_MS = 30_000

export function mimeOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

/** 按文件头判断图片类型，返回扩展名；不是图片返回 ''。 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (buf.toString('ascii', 0, 3) === 'GIF') return '.gif'
  return ''
}

const isImage = (f) => IMAGE_EXT.includes(path.extname(f).toLowerCase())
const natural = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 文件夹/文件名清洗：去掉 Windows 非法字符与首尾点空格。 */
export function safeName(name) {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return `${cleaned}_`
  return cleaned
}

/** id 只能是单段名字，防目录穿越。 */
function assertSegment(seg, what) {
  if (typeof seg !== 'string' || seg === '' || seg === '.' || seg === '..' || /[\\/]/.test(seg) || seg.includes('\0')) {
    const err = new Error(`非法的${what}：${String(seg)}`)
    err.status = 400
    throw err
  }
}
function assertCategory(category) {
  if (!CATEGORIES.includes(category)) {
    const err = new Error(`未知的库：${String(category)}`)
    err.status = 400
    throw err
  }
}

function readMeta(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, META), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeMeta(dir, meta) {
  const file = path.join(dir, META)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

const strList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、\n]/) : [])
  .map((s) => String(s).trim()).filter((s) => s !== '').slice(0, 30)
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
function outfitMap(v) {
  const out = {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, val] of Object.entries(v).slice(0, 60)) {
    const key = String(k).trim().slice(0, 40)
    const value = typeof val === 'string' ? val.trim().slice(0, 80) : ''
    if (key && value) out[key] = value
  }
  return out
}

function statImage(dir, file) {
  try {
    const st = statSync(path.join(dir, file))
    return st.isFile() ? { file, size: st.size, mtime: st.mtimeMs } : null
  } catch {
    return null
  }
}

function folderEntry(category, root, dirName) {
  const dir = path.join(root, dirName)
  const meta = readMeta(dir)
  let files = []
  try { files = readdirSync(dir).filter((f) => !f.startsWith('.') && isImage(f)) } catch {}
  files.sort((a, b) => natural.compare(a, b))
  let images = files.map((f) => statImage(dir, f)).filter(Boolean)
  const cover = typeof meta.cover === 'string' && images.some((i) => i.file === meta.cover) ? meta.cover : (images[0]?.file ?? '')
  if (cover) images = [images.find((i) => i.file === cover), ...images.filter((i) => i.file !== cover)]
  return {
    id: dirName,
    category,
    kind: 'folder',
    name: text(meta.name, 80).trim() || dirName,
    aliases: strList(meta.aliases),
    tags: strList(meta.tags),
    description: text(meta.description, 4000),
    persona: text(meta.persona, 8000),
    traits: text(meta.traits, 2000),
    defaultOutfit: text(meta.defaultOutfit, 120),
    situationOutfits: outfitMap(meta.situationOutfits),
    cover,
    images,
    createdAt: meta.createdAt || '',
    updatedAt: meta.updatedAt || '',
  }
}

function fileEntry(category, root, file, id) {
  const img = statImage(root, file)
  if (!img) return null
  return {
    id,
    category,
    kind: 'file',
    name: path.basename(file, path.extname(file)),
    aliases: [],
    tags: [],
    description: '',
    persona: '',
    traits: '',
    defaultOutfit: '',
    situationOutfits: {},
    cover: file,
    images: [img],
    file,
    createdAt: '',
    updatedAt: '',
  }
}

export function scanCategory(category) {
  assertCategory(category)
  const root = categoryDir(category)
  let names = []
  try {
    mkdirSync(root, { recursive: true })
    names = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const folders = new Set()
  const entries = []
  for (const d of names) {
    if (d.name.startsWith('.')) continue
    if (d.isDirectory()) {
      folders.add(d.name)
      entries.push(folderEntry(category, root, d.name))
    }
  }
  for (const d of names) {
    if (d.name.startsWith('.') || !d.isFile() || !isImage(d.name)) continue
    const stem = path.basename(d.name, path.extname(d.name))
    const id = folders.has(stem) || entries.some((e) => e.id === stem) ? d.name : stem
    const e = fileEntry(category, root, d.name, id)
    if (e) entries.push(e)
  }
  entries.sort((a, b) => natural.compare(a.name, b.name))
  return entries
}

let cache = null
let cacheAt = 0

export function invalidate() { cache = null }

/** 全部四个库（带 30s 缓存；设置页改动后会主动失效）。同步，注入提示词时也能用。 */
export function scanAll(force = false) {
  if (!force && cache !== null && Date.now() - cacheAt < CACHE_TTL_MS) return cache
  const out = {}
  for (const c of CATEGORIES) {
    try { out[c] = scanCategory(c) } catch { out[c] = [] }
  }
  cache = out
  cacheAt = Date.now()
  return out
}

export function getEntry(category, id) {
  assertCategory(category)
  return scanAll()[category].find((e) => e.id === id) || null
}

function entryDir(category, id) {
  assertCategory(category)
  assertSegment(id, '条目')
  return path.join(categoryDir(category), id)
}

/** 散图条目 → 收进同名文件夹，返回新 id。 */
function ensureFolder(category, entry) {
  if (entry.kind === 'folder') return entry.id
  const root = categoryDir(category)
  let id = safeName(entry.name) || 'untitled'
  let n = 2
  while (existsSync(path.join(root, id))) id = `${safeName(entry.name)}-${n++}`
  const dir = path.join(root, id)
  mkdirSync(dir, { recursive: true })
  renameSync(path.join(root, entry.file), path.join(dir, entry.file))
  writeMeta(dir, { name: entry.name, cover: entry.file, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  invalidate()
  return id
}

/**
 * 新建或更新条目。data.id 为空 = 新建。
 * 返回最新的条目对象。
 */
export function saveEntry(category, data) {
  assertCategory(category)
  const now = new Date().toISOString()
  const name = text(data.name, 80).trim()
  let id = typeof data.id === 'string' ? data.id : ''
  if (id === '') {
    if (name === '') {
      const err = new Error('名字不能为空')
      err.status = 400
      throw err
    }
    const root = categoryDir(category)
    mkdirSync(root, { recursive: true })
    const base = safeName(name) || 'untitled'
    id = base
    let n = 2
    while (existsSync(path.join(root, id))) id = `${base}-${n++}`
    mkdirSync(path.join(root, id))
    writeMeta(path.join(root, id), { name, createdAt: now, updatedAt: now })
  } else {
    assertSegment(id, '条目')
    const existing = scanAll(true)[category].find((e) => e.id === id)
    if (!existing) {
      const err = new Error(`条目不存在：${id}`)
      err.status = 404
      throw err
    }
    id = ensureFolder(category, existing)
  }
  const dir = entryDir(category, id)
  const prev = readMeta(dir)
  const next = { ...prev }
  if (name !== '') next.name = name
  if (data.aliases !== undefined) next.aliases = strList(data.aliases)
  if (data.tags !== undefined) next.tags = strList(data.tags)
  if (data.description !== undefined) next.description = text(data.description, 4000)
  if (data.persona !== undefined) next.persona = text(data.persona, 8000)
  if (data.defaultOutfit !== undefined) next.defaultOutfit = text(data.defaultOutfit, 120)
  if (data.traits !== undefined) next.traits = text(data.traits, 2000)
  if (data.situationOutfits !== undefined) next.situationOutfits = outfitMap(data.situationOutfits)
  if (data.cover !== undefined) {
    const cover = text(data.cover, 255)
    if (cover === '' || (isImage(cover) && existsSync(path.join(dir, path.basename(cover))))) next.cover = path.basename(cover)
  }
  next.createdAt = prev.createdAt || now
  next.updatedAt = now
  writeMeta(dir, next)
  invalidate()
  return scanAll(true)[category].find((e) => e.id === id)
}

/** 往条目里加参考图。files: [{ name, data: Buffer }]。opts.asCover = 把第一张新图设为封面。返回新条目。 */
export function addImages(category, id, files, opts = {}) {
  assertCategory(category)
  assertSegment(id, '条目')
  const existing = scanAll(true)[category].find((e) => e.id === id)
  if (!existing) {
    const err = new Error(`条目不存在：${id}`)
    err.status = 404
    throw err
  }
  const realId = ensureFolder(category, existing)
  const dir = entryDir(category, realId)
  const added = []
  for (const f of files) {
    const ext = sniffImage(f.data)
    if (ext === '') {
      const err = new Error(`「${String(f.name)}」不是支持的图片（PNG / JPEG / WebP / GIF）`)
      err.status = 400
      throw err
    }
    const stem = safeName(path.basename(String(f.name || 'image'), path.extname(String(f.name || '')))) || 'image'
    let file = `${stem}${ext}`
    let n = 2
    while (existsSync(path.join(dir, file))) file = `${stem}-${n++}${ext}`
    writeFileSync(path.join(dir, file), f.data)
    added.push(file)
  }
  const meta = readMeta(dir)
  if ((!meta.cover || opts.asCover === true) && added.length) {
    meta.cover = added[0]
    meta.updatedAt = new Date().toISOString()
    writeMeta(dir, meta)
  }
  invalidate()
  return { entry: scanAll(true)[category].find((e) => e.id === realId), added }
}

function moveToTrash(src, label) {
  const root = trashRoot()
  mkdirSync(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dst = path.join(root, `${stamp}-${safeName(label) || 'item'}`)
  try {
    renameSync(src, dst)
  } catch (e) {
    // 库目录在别的盘时 rename 会 EXDEV：先复制再删
    if (e && e.code === 'EXDEV') {
      const st = statSync(src)
      if (st.isDirectory()) cpSync(src, dst, { recursive: true })
      else copyFileSync(src, dst)
      rmSync(src, { recursive: true, force: true })
    } else {
      throw e
    }
  }
  return dst
}

export function removeImage(category, id, file) {
  assertSegment(file, '文件名')
  const entry = scanAll(true)[category]?.find((e) => e.id === id)
  if (!entry) {
    const err = new Error(`条目不存在：${id}`)
    err.status = 404
    throw err
  }
  if (entry.kind === 'file') return removeEntry(category, id)
  const dir = entryDir(category, id)
  const target = path.join(dir, file)
  if (!existsSync(target)) {
    const err = new Error(`图片不存在：${file}`)
    err.status = 404
    throw err
  }
  moveToTrash(target, `${category}-${id}-${file}`)
  const meta = readMeta(dir)
  if (meta.cover === file) {
    delete meta.cover
    writeMeta(dir, meta)
  }
  invalidate()
  return scanAll(true)[category].find((e) => e.id === id) || null
}

export function removeEntry(category, id) {
  const entry = scanAll(true)[category]?.find((e) => e.id === id)
  if (!entry) {
    const err = new Error(`条目不存在：${id}`)
    err.status = 404
    throw err
  }
  const src = entry.kind === 'file' ? path.join(categoryDir(category), entry.file) : entryDir(category, id)
  const dst = moveToTrash(src, `${category}-${id}`)
  invalidate()
  return { trashedTo: dst }
}

/** 条目里某张图的绝对路径（校验存在）。 */
export function imagePath(category, id, file) {
  assertCategory(category)
  assertSegment(file, '文件名')
  const entry = scanAll()[category].find((e) => e.id === id) || scanAll(true)[category].find((e) => e.id === id)
  if (!entry) return null
  if (!entry.images.some((i) => i.file === file)) return null
  return entry.kind === 'file' ? path.join(categoryDir(category), entry.file) : path.join(categoryDir(category), entry.id, file)
}

// ---- 名字解析 ---------------------------------------------------------------

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')

/**
 * 把模型给的引用（id / 名字 / 别名）解析成条目。
 * 先精确（id、名字、别名），再唯一的包含匹配；解析不了返回 null。
 */
export function resolveRef(category, ref, lib = scanAll()) {
  const key = norm(ref)
  if (key === '') return null
  const list = lib[category] || []
  const exact = list.find((e) => norm(e.id) === key)
    || list.find((e) => norm(e.name) === key)
    || list.find((e) => e.aliases.some((a) => norm(a) === key))
  if (exact) return exact
  const loose = list.filter((e) => [e.name, ...e.aliases].some((n) => {
    const nn = norm(n)
    return nn.length >= 1 && (key.includes(nn) || nn.includes(key))
  }))
  return loose.length === 1 ? loose[0] : null
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/

/** 在一段文字里找出提到的条目（名字 / 别名）。英文名至少 3 个字母且按词边界匹配。 */
export function mentionedIn(category, textValue, lib = scanAll()) {
  const hay = String(textValue ?? '')
  const low = hay.toLowerCase()
  const hits = []
  for (const e of lib[category] || []) {
    const names = [e.name, ...e.aliases].map((n) => String(n).trim()).filter(Boolean)
    const ok = names.some((n) => {
      if (CJK.test(n)) return hay.includes(n)
      if (n.length < 3) return false
      const re = new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`)
      return re.test(low)
    })
    if (ok) hits.push(e)
  }
  return hits
}
