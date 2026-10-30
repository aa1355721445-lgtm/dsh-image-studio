/**
 * dsh-image-studio —— 设置页用的同源 HTTP 接口（/api/image-studio/*）。
 * 浏览器半侧只走 fetch：桌面版的页面是 file:// 加载、fetch 经 IPC 桥接，
 * 所以图片也用 fetch → blob 取，不直接写 <img src="/api/...">。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { cancelJob, deleteHistory, getJob, outputAbs, retrieve, startJob } from './engine.js'
import {
  addImages, imagePath, invalidate, mimeOf, removeEntry, removeImage, saveEntry, scanAll,
} from './library.js'
import { getPresets, PRESET_GROUPS, PRESET_LABEL, resetGroup, savePresets } from './presets.js'
import { listModels } from './providers.js'
import {
  commitImport, discardImport, SHEET_LABEL, stagedFile, startEntryAnalyze, startEntrySheet, startImport, startImportSheet, startTextCreate,
} from './sheets.js'
import { listHostVisionModels } from './vision.js'
import {
  ASPECTS, CATEGORIES, CATEGORY_LABEL, POLICY_MODES, PROVIDERS, RESOLUTIONS,
  categoryDir, defaultCategoryDir, findHistory, getConfig, outputsRoot, publicConfig,
  readHistory, studioRoot, updateConfig,
} from './store.js'

export const API_PREFIX = '/api/image-studio'
const MAX_BODY = 80 * 1024 * 1024

export const bridge = { lastSeen: null, count: 0 }

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

function sendImage(res, file, asJson) {
  const data = readFileSync(file)
  if (asJson) return sendJson(res, 200, { mime: mimeOf(file), b64: data.toString('base64') })
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'content-length': String(data.length),
    'cache-control': 'private, max-age=300',
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(Object.assign(new Error('请求体过大（单次上传请控制在 50MB 内）'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function openPath(target, select) {
  const plat = process.platform
  const cmd = plat === 'win32' ? 'explorer' : plat === 'darwin' ? 'open' : 'xdg-open'
  const args = plat === 'win32' ? (select ? ['/select,', target] : [target]) : plat === 'darwin' ? (select ? ['-R', target] : [target]) : [select ? path.dirname(target) : target]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    const timer = setTimeout(() => { try { child.unref() } catch {} resolve() }, 2500)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })
}

function pickFolder(title) {
  return new Promise((resolve, reject) => {
    const plat = process.platform
    let cmd
    let args
    if (plat === 'win32') {
      cmd = 'powershell'
      const t = String(title).replace(/'/g, "''")
      args = ['-NoProfile', '-STA', '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms | Out-Null; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${t}'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }`]
    } else if (plat === 'darwin') {
      cmd = 'osascript'
      args = ['-e', `POSIX path of (choose folder with prompt "${String(title).replace(/"/g, '')}")`]
    } else {
      cmd = 'zenity'
      args = ['--file-selection', '--directory', `--title=${title}`]
    }
    let out = ''
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false })
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.on('error', reject)
    child.on('exit', () => resolve(out.trim().replace(/[\\/]+$/, '') || ''))
  })
}

function decodeUpload(f) {
  const raw = String(f?.data ?? '')
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(raw)
  return { name: String(f?.name ?? 'image'), data: Buffer.from(m ? m[1] : raw, 'base64') }
}

function libraryPayload(force) {
  const lib = scanAll(force)
  const cfg = getConfig()
  return {
    dirs: Object.fromEntries(CATEGORIES.map((c) => [c, { path: categoryDir(c), custom: cfg.dirs[c] !== '', exists: existsSync(categoryDir(c)) }])),
    categories: lib,
  }
}

function statePayload() {
  const cfg = getConfig()
  const lib = scanAll()
  return {
    config: publicConfig(cfg),
    counts: Object.fromEntries(CATEGORIES.map((c) => [c, (lib[c] || []).length])),
    labels: CATEGORY_LABEL,
    root: studioRoot(),
    outputs: outputsRoot(),
    providers: PROVIDERS,
    options: { policyModes: POLICY_MODES, resolutions: RESOLUTIONS, aspects: ASPECTS },
    presetGroups: PRESET_GROUPS,
    presetLabels: PRESET_LABEL,
    sheetLabels: SHEET_LABEL,
    bridge,
    build: 'v0.5.0',
  }
}

export function createHandler(ctx = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const q = url.searchParams
    const m = req.method
    try {
      if (route === '/state' && m === 'GET') {
        bridge.lastSeen = new Date().toISOString()
        bridge.count += 1
        return sendJson(res, 200, statePayload())
      }
      if (route === '/config' && m === 'POST') {
        const body = await readBody(req)
        const patch = body && typeof body === 'object' ? body : {}
        // apiKey 留空 = 不改；要清空传 clearKey: true
        if (patch.api && typeof patch.api === 'object') {
          if (patch.api.apiKey === '' || patch.api.apiKey === undefined) delete patch.api.apiKey
          if (patch.clearKey === true) patch.api.apiKey = ''
        }
        if (patch.vision && typeof patch.vision === 'object') {
          if (patch.vision.apiKey === '' || patch.vision.apiKey === undefined) delete patch.vision.apiKey
          if (patch.clearVisionKey === true) patch.vision.apiKey = ''
          delete patch.vision.hasKey
          delete patch.vision.keyHint
        }
        delete patch.clearKey
        delete patch.clearVisionKey
        delete patch.dirs
        updateConfig(patch)
        return sendJson(res, 200, statePayload())
      }
      if (route === '/test' && m === 'POST') {
        const models = await listModels(getConfig())
        return sendJson(res, 200, { ok: true, models })
      }
      if (route === '/library' && m === 'GET') {
        return sendJson(res, 200, libraryPayload(q.get('force') === '1'))
      }
      if (route === '/rescan' && m === 'POST') {
        invalidate()
        return sendJson(res, 200, libraryPayload(true))
      }
      if (route === '/entry' && m === 'POST') {
        const body = await readBody(req)
        const entry = saveEntry(String(body.category), body)
        return sendJson(res, 200, { entry })
      }
      if (route === '/entry/delete' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, removeEntry(String(body.category), String(body.id)))
      }
      if (route === '/upload' && m === 'POST') {
        const body = await readBody(req)
        const files = Array.isArray(body.files) ? body.files.map(decodeUpload) : []
        if (files.length === 0) throw bad('没有收到图片')
        return sendJson(res, 200, addImages(String(body.category), String(body.id), files))
      }
      if (route === '/image/delete' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { entry: removeImage(String(body.category), String(body.id), String(body.file)) })
      }
      if (route === '/dir' && m === 'POST') {
        const body = await readBody(req)
        const c = String(body.category)
        if (!CATEGORIES.includes(c)) throw bad('未知的库')
        const p = String(body.path ?? '').trim()
        if (p !== '') {
          if (!path.isAbsolute(p)) throw bad('请填绝对路径（例如 D:\\素材\\人物）')
          if (!existsSync(p)) {
            if (body.create === true) mkdirSync(p, { recursive: true })
            else throw bad(`目录不存在：${p}`)
          } else if (!statSync(p).isDirectory()) throw bad(`不是文件夹：${p}`)
        } else {
          mkdirSync(defaultCategoryDir(c), { recursive: true })
        }
        const cfg = getConfig()
        updateConfig({ dirs: { ...cfg.dirs, [c]: p } })
        invalidate()
        return sendJson(res, 200, libraryPayload(true))
      }
      if (route === '/pick' && m === 'POST') {
        const body = await readBody(req)
        const label = CATEGORY_LABEL[body.category] || ''
        try {
          const picked = await pickFolder(label ? `选择「${label}」参考库的目录` : '选择文件夹')
          return sendJson(res, 200, { picked })
        } catch (e) {
          throw bad(`打不开系统文件夹选择器：${e?.message || e}；可以直接把路径粘进输入框。`, 500)
        }
      }
      if (route === '/open' && m === 'POST') {
        const body = await readBody(req)
        let target = ''
        let select = false
        if (body.category && CATEGORIES.includes(body.category)) {
          target = categoryDir(body.category)
          if (body.id) {
            const e = (scanAll()[body.category] || []).find((x) => x.id === body.id)
            if (e) { target = e.kind === 'file' ? path.join(target, e.file) : path.join(target, e.id); select = e.kind === 'file' }
          }
        } else if (body.historyId) {
          const h = findHistory(String(body.historyId))
          if (h?.files?.length) { target = outputAbs(h.files[0]); select = true }
        } else if (body.target === 'outputs') target = outputsRoot()
        else if (body.target === 'root') target = studioRoot()
        if (!target || !existsSync(target)) throw bad('要打开的位置不存在', 404)
        await openPath(target, select)
        return sendJson(res, 200, { ok: true, opened: target })
      }
      if (route === '/file' && m === 'GET') {
        const asJson = q.get('b64') === '1'
        if (q.get('s')) {
          const abs = stagedFile(q.get('s'), q.get('f') || '')
          if (!abs) throw bad('图片不存在', 404)
          return sendImage(res, abs, asJson)
        }
        if (q.get('h')) {
          const h = findHistory(q.get('h'))
          const i = Math.max(0, Number(q.get('i') || 0) | 0)
          const rel = h?.files?.[i]
          if (!rel) throw bad('图片不存在', 404)
          const abs = outputAbs(rel)
          if (!abs.startsWith(outputsRoot()) || !existsSync(abs)) throw bad('图片文件不见了', 404)
          return sendImage(res, abs, asJson)
        }
        const c = q.get('c') || ''
        if (!CATEGORIES.includes(c)) throw bad('未知的库')
        const abs = imagePath(c, q.get('id') || '', q.get('f') || '')
        if (!abs || !existsSync(abs)) throw bad('图片不存在', 404)
        return sendImage(res, abs, asJson)
      }
      if (route === '/history' && m === 'GET') {
        const limit = Math.min(500, Math.max(1, Number(q.get('limit') || 60) | 0))
        const items = readHistory(limit + 50).filter((e) => e.status !== 'deleted').slice(0, limit)
        return sendJson(res, 200, { items })
      }
      if (route === '/history/delete' && m === 'POST') {
        const body = await readBody(req)
        deleteHistory(String(body.id))
        return sendJson(res, 200, { ok: true })
      }
      if (route === '/retrieve' && m === 'POST') {
        const body = await readBody(req)
        const record = await retrieve(String(body.id))
        return sendJson(res, 200, { record })
      }
      if (route === '/generate' && m === 'POST') {
        const body = await readBody(req)
        if (!String(body.prompt ?? '').trim()) throw bad('先写一下要画什么')
        return sendJson(res, 200, { jobId: startJob(body) })
      }
      if (route === '/job' && m === 'GET') {
        const job = getJob(q.get('id') || '')
        if (!job) throw bad('任务不存在（可能已过期）', 404)
        return sendJson(res, 200, job)
      }
      if (route === '/job/cancel' && m === 'POST') {
        const body = await readBody(req)
        cancelJob(String(body.id))
        return sendJson(res, 200, { ok: true })
      }
      // ---- 关键词 ----
      if (route === '/presets' && m === 'GET') {
        return sendJson(res, 200, { presets: getPresets(), groups: PRESET_GROUPS, labels: PRESET_LABEL })
      }
      if (route === '/presets' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { presets: savePresets(body.presets) })
      }
      if (route === '/presets/reset' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { presets: resetGroup(String(body.group)) })
      }
      // ---- 图片导入 / 三视图 / 识图 ----
      if (route === '/import/start' && m === 'POST') {
        const body = await readBody(req)
        const files = Array.isArray(body.files) ? body.files.map(decodeUpload) : []
        return sendJson(res, 200, startImport(ctx, { category: String(body.category), files, hint: body.hint, analyze: body.analyze, sheet: body.sheet }))
      }
      if (route === '/create/start' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, startTextCreate(ctx, { category: String(body.category), text: body.text, name: body.name, hint: body.hint, expand: body.expand, sheet: body.sheet }))
      }
      if (route === '/import/sheet' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { jobId: startImportSheet(ctx, { importId: String(body.importId), hint: body.hint, description: body.description, name: body.name }) })
      }
      if (route === '/import/commit' && m === 'POST') {
        const body = await readBody(req)
        const entry = commitImport({ importId: String(body.importId), fields: body.fields, sheetId: body.sheetId, useSheet: body.useSheet, useOriginals: body.useOriginals, targetId: body.targetId })
        invalidate()
        return sendJson(res, 200, { entry })
      }
      if (route === '/import/discard' && m === 'POST') {
        const body = await readBody(req)
        discardImport(String(body.importId))
        return sendJson(res, 200, { ok: true })
      }
      if (route === '/entry/sheet' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { jobId: startEntrySheet(ctx, { category: String(body.category), id: String(body.id), file: body.file, hint: body.hint }) })
      }
      if (route === '/entry/analyze' && m === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { jobId: startEntryAnalyze(ctx, { category: String(body.category), id: String(body.id), hint: body.hint }) })
      }
      if (route === '/vision/models' && m === 'GET') {
        let models = []
        let error = ''
        try { models = await listHostVisionModels(ctx) } catch (e) { error = String(e?.message || e) }
        return sendJson(res, 200, { models, error })
      }
      return sendJson(res, 404, { error: `未知接口：${route}` })
    } catch (error) {
      const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500
      return sendJson(res, status, { error: String(error?.message || error) })
    }
  }
}
