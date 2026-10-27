// v0.3 冒烟测试：文生素材（一段文字 → 扩写条目 → 按描述画三视图 → 入库）。
// 用法：node tests/smoke-host-v3.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-is3-'))
process.env.DSH_HOME = tmp
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const FIELDS = { name: '黑色双排扣风衣', aliases: ['风衣'], tags: ['通勤', '秋冬', '黑色'], description: '黑色及膝长款风衣，双排扣，宽翻领，腰间系同色腰带，内搭白色高领毛衣，脚穿黑色短靴。' }

const seen = { tasks: [], chats: [] }
let failTasks = false
const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (req.url.startsWith('/out/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
    if (req.method === 'POST' && req.url === '/v1/tasks') { if (failTasks) return json(402, { error: { message: 'insufficient balance' } }); seen.tasks.push(JSON.parse(body)); return json(202, { id: 'img_' + seen.tasks.length }) }
    if (req.method === 'GET' && req.url.startsWith('/v1/tasks/')) { const id = req.url.split('/').pop(); return json(200, { id, status: 'done', result_urls: [`http://127.0.0.1:${api.address().port}/out/${id}.png`] }) }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') { const j = JSON.parse(body); seen.chats.push(j); return json(200, { choices: [{ message: { content: JSON.stringify({ ...FIELDS, name: 'OpenAI起的名' }) } }] }) }
    json(404, {})
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const API = `http://127.0.0.1:${api.address().port}`

const llmCalls = []
let saveImagesCalls = 0
let llmMode = 'ok'
let handler = null
const ctx = {
  logger: { info() {}, warn() {} },
  tools: { register() { return () => {} } },
  systemPrompt: { context() { return () => {} } },
  webServer: { register(r) { handler = r.handler; return () => {} } },
  effect(fn) { return fn() },
  get(name) {
    if (name === 'attachments') return { async saveImages(x) { saveImagesCalls++; return x.map((_, i) => ({ id: 'a' + i })) } }
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'deepseek-official' }],
        // 服务端列表不标模态：纯文字任务照样能用第一个模型
        listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'Pro' }],
        stream: async function* (opts) {
          llmCalls.push(opts)
          if (llmMode === 'error') { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }; return }
          yield { type: 'text-delta', index: 0, text: JSON.stringify(FIELDS) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    }
    return undefined
  },
}
const store = await import('../lib/store.js')
const plugin = await import('../lib/index.js')
plugin.apply(ctx)
store.updateConfig({ api: { baseUrl: API, apiKey: 'k' } })

const srv = http.createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const B = `http://127.0.0.1:${srv.address().port}/api/image-studio`
const j = async (p, body) => { const r = await fetch(B + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
const waitJob = async (id) => { for (let i = 0; i < 60; i++) { await new Promise((s) => setTimeout(s, 400)); const r = (await j('/job?id=' + id)).json; if (r.status !== 'running') return r } throw new Error('job timeout') }

// 1. 正常：扩写（宿主模型、纯文字、不存附件）+ 服装三视图（无参考图）
const TEXT = '黑色长款风衣，双排扣，腰间系同色腰带'
let r = await j('/create/start', { category: 'outfits', text: TEXT, hint: '画风偏日系' })
assert.equal(r.status, 200, JSON.stringify(r.json))
let job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.result.mode, 'text')
assert.deepEqual(job.result.fields, FIELDS)
assert.deepEqual(job.result.sources, [])
assert.equal(saveImagesCalls, 0, 'no attachments for text-only')
assert.equal(llmCalls.at(-1).model, 'deepseek-v4-pro', 'falls back to first model for text')
assert.equal(llmCalls.at(-1).messages[0].content.length, 1)
assert.match(llmCalls.at(-1).messages[0].content[0].text, /服装设计助手[\s\S]*用户描述：黑色长款风衣[\s\S]*补充要求：画风偏日系/)
let task = seen.tasks.at(-1)
assert.equal(task.input.image_urls, undefined, 'text sheet has no reference images')
assert.match(task.input.prompt, /根据下面的服装设定，设计这套服装/)
assert.match(task.input.prompt, /设定：黑色及膝长款风衣/)
assert.match(task.input.prompt, /用户的原始要求（必须满足）：黑色长款风衣/)
assert.match(task.input.prompt, /补充要求（优先遵守）：画风偏日系/)
assert.equal(task.input.size, '16:9')
console.log('--- text sheet prompt ---\n' + task.input.prompt + '\n-------------------------')
// 重新生成（文字模式不需要原图）
const importId = r.json.importId
r = await j('/import/sheet', { importId, description: '改成深灰色', hint: '' })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.match(seen.tasks.at(-1).input.prompt, /设定：改成深灰色/)
// 入库：三视图做封面
r = await j('/import/commit', { importId, fields: FIELDS, sheetId: job.result.sheet.id, useSheet: true, useOriginals: true })
assert.equal(r.status, 200, JSON.stringify(r.json))
assert.deepEqual(r.json.entry.images.map((i) => i.file), ['三视图.png'])
assert.equal(r.json.entry.name, FIELDS.name)
assert.ok(!existsSync(path.join(tmp, 'image-studio', 'staging', importId)))

// 2. 扩写失败：用原话兜底；人物用「原创角色」提示词
llmMode = 'error'
r = await j('/create/start', { category: 'characters', text: '银白短发的狼耳少女，金色竖瞳', name: '阿银' })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.match(job.result.analysisError, /rate limited/)
assert.equal(job.result.fields.name, '阿银')
assert.equal(job.result.fields.description, '银白短发的狼耳少女，金色竖瞳')
assert.match(seen.tasks.at(-1).input.prompt, /原创这个角色[\s\S]*A 字站姿[\s\S]*设定：银白短发的狼耳少女/)
llmMode = 'ok'

// 3. 生图失败但扩写成功：照样返回，可只存文字条目
failTasks = true
r = await j('/create/start', { category: 'props', text: '鲸鱼造型的蓝色马克杯' })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.result.sheet, null)
assert.match(job.result.sheetError, /余额不足/)
r = await j('/import/commit', { importId: r.json.importId, fields: { ...FIELDS, name: '鲸鱼杯' }, sheetId: '', useSheet: false, useOriginals: true })
assert.equal(r.status, 200, JSON.stringify(r.json))
assert.equal(r.json.entry.images.length, 0)
assert.equal(r.json.entry.name, '鲸鱼杯')
// 4. 扩写和生图都失败 → 任务失败
llmMode = 'error'
r = await j('/create/start', { category: 'scenes', text: '海边咖啡馆' })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'failed')
assert.match(job.error, /rate limited/)
failTasks = false
llmMode = 'ok'

// 5. 空描述被拒；OpenAI 兼容扩写（纯文字 content）
r = await j('/create/start', { category: 'props', text: '   ' })
assert.equal(r.status, 400)
store.updateConfig({ vision: { source: 'openai', baseUrl: API, model: 'gpt-x' } })
r = await j('/create/start', { category: 'scenes', text: '海边咖啡馆，傍晚', sheet: false })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.result.fields.name, 'OpenAI起的名')
assert.equal(typeof seen.chats.at(-1).messages[0].content, 'string')
assert.equal(seen.chats.at(-1).model, 'gpt-x')

srv.close(); api.close()
console.log('ALL V3 HOST TESTS PASSED')
