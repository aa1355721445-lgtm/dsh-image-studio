/**
 * dsh-image-studio —— 生图 API 适配层。
 *
 *   65535-tasks    65535 原生异步任务：POST /v1/tasks → 轮询 GET /v1/tasks/{id}
 *                  参考图以 data URI 放进 input.image_urls（最多 16 张）。
 *                  只有成功才扣费；result_urls 有有效期，所以完成后立刻下载到本地。
 *   openai-images  通用 OpenAI 兼容：无参考图走 /v1/images/generations，
 *                  有参考图走 /v1/images/edits（multipart，多张用 image[]）。
 *
 * 用 Node 自带 fetch，不引任何依赖。所有等待都遵守 signal（会话里点停止会立即中断）。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { mimeOf, sniffImage } from './library.js'

export class ApiError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'ApiError'
    Object.assign(this, extra)
  }
}

const FRIENDLY = {
  400: '参数有误',
  401: 'API Key 无效或已过期',
  402: '余额不足或 Key 配额用尽',
  403: '没有权限（模型 / 分组不对，或被内容审核拦下）',
  404: '接口或任务不存在（检查 Base URL）',
  409: '同一请求还在处理中',
  413: '请求太大（参考图太多或太大）',
  429: '请求太频繁，被限流了',
  502: '上游暂时不可用',
  503: '队列繁忙或暂无可用渠道',
  524: '网关超时（国际线路别用同步接口）',
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

async function readError(res) {
  let body = ''
  try { body = await res.text() } catch {}
  let msg = ''
  try {
    const j = JSON.parse(body)
    msg = j?.error?.message || j?.message || j?.error || ''
    if (typeof msg !== 'string') msg = JSON.stringify(msg)
  } catch {
    msg = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  }
  const head = FRIENDLY[res.status] ? `${FRIENDLY[res.status]}（HTTP ${res.status}）` : `HTTP ${res.status}`
  return new ApiError(msg ? `${head}：${msg}` : head, { status: res.status })
}

function v1(base) {
  const b = String(base || '').replace(/\/+$/, '')
  if (b === '') throw new ApiError('还没填 Base URL（设置页 → 接口）')
  return /\/v1$/.test(b) ? b : `${b}/v1`
}

function authHeaders(cfg) {
  if (!cfg.api.apiKey) throw new ApiError('还没填 API Key（设置页 → 接口）')
  return { Authorization: `Bearer ${cfg.api.apiKey}` }
}

async function toDataUri(absPath) {
  const buf = await readFile(absPath)
  const ext = sniffImage(buf) || path.extname(absPath).toLowerCase()
  return `data:${mimeOf(`x${ext}`)};base64,${buf.toString('base64')}`
}

async function download(url, signal) {
  if (url.startsWith('data:')) {
    const m = /^data:[^;,]+;base64,(.*)$/s.exec(url)
    if (!m) throw new ApiError('结果是无法解析的 data URI')
    return Buffer.from(m[1], 'base64')
  }
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: withTimeout(signal, 120_000) })
      if (!res.ok) throw await readError(res)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (signal?.aborted) throw e
      lastErr = e
      await sleep(1500 * (attempt + 1), signal)
    }
  }
  throw new ApiError(`图片已生成，但下载失败：${lastErr?.message || lastErr}（可稍后在设置页「生成记录」里重新取回）`, { downloadFailed: true })
}

function packImages(buffers) {
  return buffers.map((data) => ({ data, ext: sniffImage(data) || '.png' }))
}

// ---- 65535 原生异步任务 ------------------------------------------------------

async function run65535({ cfg, prompt, refs, aspect, signal, onEvent }) {
  const base = v1(cfg.api.baseUrl)
  const headers = { ...authHeaders(cfg), 'Content-Type': 'application/json' }
  const input = { prompt, n: 1 }
  if (aspect) input.size = aspect
  if (cfg.api.resolution && /^\d+:\d+$/.test(aspect || '')) input.resolution = cfg.api.resolution
  if (cfg.api.quality) input.quality = cfg.api.quality
  if (refs.length) input.image_urls = await Promise.all(refs.map(toDataUri))
  const body = JSON.stringify({ kind: 'image', model: cfg.api.model, input })

  const idem = `dsh-image-studio-${randomUUID()}`
  let created = null
  for (let attempt = 0; attempt < 3 && created === null; attempt++) {
    let res
    try {
      res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': idem },
        body,
        signal: withTimeout(signal, 120_000),
      })
    } catch (e) {
      if (signal?.aborted) throw e
      if (attempt === 2) throw new ApiError(`连不上生图接口：${e?.message || e}`)
      await sleep(2000, signal)
      continue
    }
    if (res.status === 429 || res.status === 503 || res.status === 409) {
      if (attempt === 2) throw await readError(res)
      await sleep(3000 * (attempt + 1), signal)
      continue
    }
    if (!res.ok) throw await readError(res)
    created = await res.json()
  }
  const taskId = created?.id
  if (typeof taskId !== 'string' || taskId === '') throw new ApiError('接口没有返回任务 ID')
  onEvent?.({ type: 'submitted', taskId })
  return poll65535({ cfg, taskId, signal, onEvent })
}

export async function poll65535({ cfg, taskId, signal, onEvent, timeoutSec }) {
  const base = v1(cfg.api.baseUrl)
  const headers = authHeaders(cfg)
  const deadline = Date.now() + (timeoutSec ?? cfg.api.timeoutSec) * 1000
  let interval = 2000
  let lastStatus = ''
  while (Date.now() < deadline) {
    await sleep(interval, signal)
    let res
    try {
      res = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers, signal: withTimeout(signal, 30_000) })
    } catch (e) {
      if (signal?.aborted) throw e
      interval = Math.min(interval * 1.5, 8000)
      continue
    }
    if (res.status === 429) { interval = Math.min(interval * 2, 15000); continue }
    if (res.status >= 500) { interval = Math.min(interval * 1.5, 8000); continue }
    if (!res.ok) {
      const err = await readError(res)
      err.taskId = taskId
      throw err
    }
    const task = await res.json()
    if (task.status !== lastStatus) {
      lastStatus = task.status
      onEvent?.({ type: 'status', taskId, status: task.status })
    }
    if (task.status === 'done') {
      let buffers = []
      const urls = Array.isArray(task.result_urls) ? task.result_urls.filter((u) => typeof u === 'string' && u) : []
      if (urls.length) {
        for (const u of urls) buffers.push(await download(u, signal))
      } else if (Array.isArray(task?.result?.data)) {
        buffers = task.result.data.filter((d) => d && d.b64_json).map((d) => Buffer.from(d.b64_json, 'base64'))
      }
      if (buffers.length === 0) throw new ApiError('任务完成了，但没有返回图片', { taskId })
      return {
        images: packImages(buffers),
        meta: { taskId, model: task.model || cfg.api.model, size: task.size || '', cost: task.cost_usd ?? null, remoteUrls: urls },
      }
    }
    if (task.status === 'failed') {
      const code = task.error_code ? `${task.error_code}：` : ''
      throw new ApiError(`生成失败（不扣费）：${code}${task.error_message || '未知原因'}`, { taskId, code: task.error_code })
    }
    interval = Math.min(interval * 1.25, 5000)
  }
  throw new ApiError(`等了 ${timeoutSec ?? cfg.api.timeoutSec} 秒还没出图（任务 ${taskId} 可能仍在跑，稍后可在设置页「生成记录」里取回）`, { taskId, timedOut: true })
}

// ---- OpenAI 兼容 images -------------------------------------------------------

function pixelSize(aspect) {
  if (/^\d{3,4}x\d{3,4}$/.test(aspect || '')) return aspect
  const m = /^(\d+):(\d+)$/.exec(aspect || '')
  if (!m) return undefined
  const r = Number(m[1]) / Number(m[2])
  if (r > 1.15) return '1536x1024'
  if (r < 0.87) return '1024x1536'
  return '1024x1024'
}

async function runOpenAI({ cfg, prompt, refs, aspect, signal }) {
  const base = v1(cfg.api.baseUrl)
  const headers = authHeaders(cfg)
  const size = pixelSize(aspect)
  const timeout = withTimeout(signal, cfg.api.timeoutSec * 1000)
  let res
  try {
    if (refs.length === 0) {
      const body = { model: cfg.api.model, prompt, n: 1 }
      if (size) body.size = size
      if (cfg.api.quality) body.quality = cfg.api.quality
      res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeout,
      })
    } else {
      const form = new FormData()
      form.append('model', cfg.api.model)
      form.append('prompt', prompt)
      form.append('n', '1')
      if (size) form.append('size', size)
      if (cfg.api.quality) form.append('quality', cfg.api.quality)
      const field = refs.length > 1 ? 'image[]' : 'image'
      for (const p of refs) {
        const buf = await readFile(p)
        const ext = sniffImage(buf) || path.extname(p)
        form.append(field, new Blob([buf], { type: mimeOf(`x${ext}`) }), `ref${ext}`)
      }
      res = await fetch(`${base}/images/edits`, { method: 'POST', headers, body: form, signal: timeout })
    }
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ApiError(`请求失败：${e?.name === 'TimeoutError' ? `超过 ${cfg.api.timeoutSec} 秒` : e?.message || e}`)
  }
  if (!res.ok) throw await readError(res)
  const json = await res.json()
  const data = Array.isArray(json?.data) ? json.data : []
  const buffers = []
  for (const d of data) {
    if (d?.b64_json) buffers.push(Buffer.from(d.b64_json, 'base64'))
    else if (typeof d?.url === 'string') buffers.push(await download(d.url, signal))
  }
  if (buffers.length === 0) throw new ApiError('接口返回里没有图片')
  return { images: packImages(buffers), meta: { taskId: '', model: cfg.api.model, size: size || '', cost: null, remoteUrls: [] } }
}

// ---- 入口 ---------------------------------------------------------------------

/**
 * @param {{ cfg, prompt: string, refs: string[] (绝对路径), aspect: string, signal?: AbortSignal, onEvent? }} opts
 * @returns {Promise<{ images: {data: Buffer, ext: string}[], meta }>}
 */
export function generateImage(opts) {
  if (opts.cfg.api.provider === 'openai-images') return runOpenAI(opts)
  return run65535(opts)
}

/** 拉取当前 Key 可用的生图模型（设置页「测试连接」用）。 */
export async function listModels(cfg, signal) {
  const base = v1(cfg.api.baseUrl)
  let res
  try {
    res = await fetch(`${base}/models`, { headers: authHeaders(cfg), signal: withTimeout(signal, 20_000) })
  } catch (e) {
    throw new ApiError(`连不上 ${base}：${e?.message || e}`)
  }
  if (!res.ok) throw await readError(res)
  const json = await res.json()
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const ids = []
  for (const m of list) {
    const id = typeof m === 'string' ? m : m?.id
    if (typeof id !== 'string') continue
    const caps = Array.isArray(m?.capabilities) ? m.capabilities : null
    if (caps !== null && !caps.includes('image')) continue
    if (caps === null && !/image|dall|flux|seedream|banana|imagen|sd|kolors|grok-imagine/i.test(id)) continue
    ids.push(id)
  }
  return ids
}
