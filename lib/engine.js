/**
 * dsh-image-studio —— 一次生图的完整流程（工具与设置页共用）：
 * 组合参考 → 记一条「进行中」→ 调接口 → 把结果存到 outputs/ → 记「完成 / 失败」。
 */
import { mkdirSync, renameSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { compose } from './compose.js'
import { scanAll } from './library.js'
import { generateImage, poll65535 } from './providers.js'
import { appendHistory, findHistory, getConfig, newId, outputsRoot, trashRoot } from './store.js'

function monthDir() {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`
}

/** 存结果图，返回相对 outputs/ 的路径（正斜杠）。 */
function saveOutputs(id, images) {
  const month = monthDir()
  const dir = path.join(outputsRoot(), month)
  mkdirSync(dir, { recursive: true })
  return images.map((img, i) => {
    const file = `${id}${images.length > 1 ? `-${i + 1}` : ''}${img.ext}`
    writeFileSync(path.join(dir, file), img.data)
    return `${month}/${file}`
  })
}

export const outputAbs = (rel) => path.join(outputsRoot(), ...String(rel).split('/'))

function refSummary(refs) {
  const out = []
  for (const r of refs) {
    if (r.kind === 'extra') { out.push({ kind: 'extra', label: r.label }); continue }
    const last = out[out.length - 1]
    if (last && last.kind === 'entry' && last.category === r.category && last.id === r.entryId) last.count++
    else out.push({ kind: 'entry', category: r.category, id: r.entryId, name: r.name, file: r.file, count: 1 })
  }
  return out
}

/**
 * @param args  { prompt, characters, outfits, scene, props, extra_images, aspect, caption }
 * @param opts  { signal, source: 'tool'|'ui', sessionId, onEvent }
 * @returns 完整的历史记录对象（status: 'done'）
 * @throws  ApiError / Error，带 historyId
 */
export async function runGeneration(args, opts = {}) {
  const cfg = getConfig()
  const prompt = String(args?.prompt ?? '').trim()
  if (prompt === '') throw new Error('prompt 不能为空：写一下这张图要画什么')
  const plan = compose({ ...args, prompt }, cfg, scanAll())
  const id = newId('img-')
  const started = Date.now()
  const base = {
    id,
    at: new Date().toISOString(),
    source: opts.source || 'tool',
    sessionId: opts.sessionId || '',
    status: 'running',
    prompt,
    caption: String(args?.caption ?? '').slice(0, 300),
    finalPrompt: plan.finalPrompt,
    aspect: plan.aspect,
    refs: refSummary(plan.refs),
    provider: cfg.api.provider,
    model: cfg.api.model,
    notes: plan.notes,
    unresolved: plan.unresolved,
    keywords: plan.keywords,
  }
  return execute(base, plan.finalPrompt, plan.refs.map((r) => r.absPath), plan.aspect, opts, started)
}

/**
 * 不经过参考库组合、直接用给定提示词和参考图生图（三视图 / 设定图用）。
 * @param o { prompt, refPaths, aspect, source, label, refs }
 */
export async function runRawGeneration(o, opts = {}) {
  const cfg = getConfig()
  const id = newId('img-')
  const base = {
    id,
    at: new Date().toISOString(),
    source: o.source || 'sheet',
    sessionId: '',
    status: 'running',
    prompt: o.label || o.prompt.slice(0, 120),
    caption: '',
    finalPrompt: o.prompt,
    aspect: o.aspect || '',
    refs: o.refs || o.refPaths.map((p) => ({ kind: 'extra', label: path.basename(p) })),
    provider: cfg.api.provider,
    model: cfg.api.model,
    notes: [],
    unresolved: [],
  }
  return execute(base, o.prompt, o.refPaths, o.aspect, opts, Date.now())
}

async function execute(base, finalPrompt, refPaths, aspect, opts, started) {
  const cfg = getConfig()
  const id = base.id
  appendHistory(base)
  opts.onEvent?.({ type: 'planned', record: base })
  try {
    const result = await generateImage({
      cfg,
      prompt: finalPrompt,
      refs: refPaths,
      aspect,
      signal: opts.signal,
      onEvent: (ev) => {
        if (ev.type === 'submitted') appendHistory({ id, taskId: ev.taskId })
        opts.onEvent?.(ev)
      },
    })
    const files = saveOutputs(id, result.images)
    const done = {
      id,
      status: 'done',
      files,
      taskId: result.meta.taskId || '',
      model: result.meta.model || cfg.api.model,
      size: result.meta.size || '',
      cost: result.meta.cost,
      ms: Date.now() - started,
    }
    appendHistory(done)
    return { ...base, ...done }
  } catch (e) {
    const aborted = opts.signal?.aborted === true
    const status = aborted ? 'cancelled' : e?.timedOut || e?.downloadFailed ? 'pending' : 'failed'
    appendHistory({ id, status, error: aborted ? '已取消' : String(e?.message || e), taskId: e?.taskId || findHistory(id)?.taskId || '', ms: Date.now() - started })
    if (e && typeof e === 'object') e.historyId = id
    throw e
  }
}

/** 对超时 / 下载失败的记录重新取回结果（仅 65535 异步任务）。 */
export async function retrieve(id, signal) {
  const h = findHistory(id)
  if (!h) throw Object.assign(new Error(`找不到记录 ${id}`), { status: 404 })
  if (h.status === 'done') return h
  if (!h.taskId) throw Object.assign(new Error('这条记录没有任务 ID，无法取回'), { status: 400 })
  const cfg = getConfig()
  if (cfg.api.provider !== '65535-tasks') throw Object.assign(new Error('只有 65535 异步任务支持取回'), { status: 400 })
  try {
    const result = await poll65535({ cfg, taskId: h.taskId, signal, timeoutSec: 60 })
    const files = saveOutputs(id, result.images)
    const done = { id, status: 'done', files, model: result.meta.model, size: result.meta.size, cost: result.meta.cost, error: '' }
    appendHistory(done)
    return { ...h, ...done }
  } catch (e) {
    appendHistory({ id, status: e?.timedOut ? 'pending' : 'failed', error: String(e?.message || e) })
    throw e
  }
}

/** 删除一条记录：图片挪进 .trash，记录标记 deleted。 */
export function deleteHistory(id) {
  const h = findHistory(id)
  if (!h) throw Object.assign(new Error(`找不到记录 ${id}`), { status: 404 })
  const dst = path.join(trashRoot(), 'outputs')
  mkdirSync(dst, { recursive: true })
  for (const rel of h.files || []) {
    const src = outputAbs(rel)
    if (existsSync(src)) {
      try { renameSync(src, path.join(dst, path.basename(src))) } catch {}
    }
  }
  appendHistory({ id, status: 'deleted' })
}

// ---- 设置页发起的生成：后台任务 + 轮询 --------------------------------------

const jobs = new Map()

/**
 * 通用后台任务（导入、三视图、识图……）。fn({ signal, stage }) 返回结果对象。
 * 设置页用 GET /job 轮询 status / stage / result。
 */
export function startTask(kind, fn, firstStage = '准备中') {
  const jobId = newId('job-')
  const ctrl = new AbortController()
  const job = { id: jobId, kind, status: 'running', stage: firstStage, record: null, result: null, error: '', startedAt: Date.now(), ctrl }
  jobs.set(jobId, job)
  Promise.resolve().then(() => fn({ signal: ctrl.signal, stage: (s) => { job.stage = s }, job })).then((result) => {
    job.status = 'done'
    job.result = result === undefined ? null : result
  }).catch((e) => {
    job.status = 'failed'
    job.error = ctrl.signal.aborted ? '已取消' : String(e?.message || e)
  }).finally(() => {
    job.finishedAt = Date.now()
    setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000).unref?.()
  })
  return jobId
}

export function startJob(args) {
  const jobId = newId('job-')
  const ctrl = new AbortController()
  const job = { id: jobId, kind: 'generate', status: 'running', stage: '组合参考图', record: null, result: null, error: '', startedAt: Date.now(), ctrl }
  jobs.set(jobId, job)
  runGeneration(args, {
    source: 'ui',
    signal: ctrl.signal,
    onEvent: (ev) => {
      if (ev.type === 'planned') { job.record = ev.record; job.stage = '提交任务' }
      if (ev.type === 'submitted') job.stage = '排队中'
      if (ev.type === 'status') job.stage = ev.status === 'running' ? '生成中' : ev.status === 'pending' ? '排队中' : ev.status
    },
  }).then((record) => {
    job.status = 'done'
    job.record = record
  }).catch((e) => {
    job.status = 'failed'
    job.error = String(e?.message || e)
    if (e?.historyId) job.record = findHistory(e.historyId)
  }).finally(() => {
    job.finishedAt = Date.now()
    setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000).unref?.()
  })
  return jobId
}

export function getJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return null
  const { ctrl, ...rest } = job
  return { ...rest, elapsedMs: (job.finishedAt || Date.now()) - job.startedAt }
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId)
  if (job && job.status === 'running') job.ctrl.abort(new Error('已取消'))
}

export function abortAllJobs() {
  for (const job of jobs.values()) if (job.status === 'running') job.ctrl.abort(new Error('插件已卸载'))
}
