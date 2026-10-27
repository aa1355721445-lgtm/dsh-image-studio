// 宿主半冒烟测试：模拟 DSH ctx（tools / systemPrompt / webServer）+ 假的 65535 /v1/tasks 接口。
// 用法：node tests/smoke-host.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-is-'))
process.env.DSH_HOME = tmp

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

// ---- 假接口 ----
const seen = { posts: [], polls: 0 }
const api = http.createServer((req, res) => {
  const auth = req.headers.authorization
  if (req.url.startsWith('/out/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
  if (auth !== 'Bearer test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}') }
  if (req.method === 'POST' && req.url === '/v1/tasks') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const j = JSON.parse(body)
      seen.posts.push({ body: j, idem: req.headers['idempotency-key'] })
      if (j.input.prompt.includes('FAILME')) { res.writeHead(202, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'img_fail', status: 'pending' })) }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'img_ok' + seen.posts.length, status: 'pending' }))
    })
    return
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/tasks/')) {
    seen.polls++
    const id = req.url.split('/').pop()
    res.writeHead(200, { 'content-type': 'application/json' })
    if (id === 'img_fail') return res.end(JSON.stringify({ id, status: 'failed', error_code: 'content_policy', error_message: 'blocked' }))
    if (seen.polls % 2 === 1) return res.end(JSON.stringify({ id, status: 'running' }))
    return res.end(JSON.stringify({ id, status: 'done', model: 'gpt-image-2', size: '1536x2048', cost_usd: 0.04, result_urls: [`http://127.0.0.1:${api.address().port}/out/${id}.png`] }))
  }
  if (req.method === 'GET' && req.url.startsWith('/out/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
  if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'gpt-image-2', capabilities: ['image'] }, { id: 'gpt-5', capabilities: ['chat'] }] })) }
  res.writeHead(404); res.end()
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const API = `http://127.0.0.1:${api.address().port}`

// ---- 假 ctx ----
const tools = new Map()
const contexts = []
let handler = null
const ctx = {
  logger: () => ({ info() {}, warn() {} }),
  tools: { register(def) { if (tools.has(def.name)) throw new Error(`tool ${def.name} already registered`); tools.set(def.name, def); return () => tools.delete(def.name) } },
  systemPrompt: { context(c) { contexts.push(c); return () => {} } },
  webServer: { register(r) { handler = r.handler; return () => {} } },
  effect(fn) { return fn() },
  get() { return undefined },
}
ctx.logger = { info() {}, warn() {} }

const store = await import('../lib/store.js')
const lib = await import('../lib/library.js')
const plugin = await import('../lib/index.js')
plugin.apply(ctx)
assert.ok(tools.has('image_generate') && tools.has('image_library'), 'two tools registered')
assert.equal(contexts.length, 1)
assert.ok(handler)
// 第二次装配不应抛
plugin.apply(ctx)

store.updateConfig({ api: { baseUrl: API, apiKey: 'test-key' }, policy: { cooldownMin: 5 } })

// ---- 建库 ----
const xy = lib.saveEntry('characters', { name: '小鱼', aliases: ['大肥鱼'], description: '蓝紫渐变长发、呆毛、鲸鱼尾巴', persona: '嘴硬心软', defaultOutfit: '女仆装' })
lib.addImages('characters', xy.id, [{ name: 'front.png', data: PNG }, { name: 'side.png', data: PNG }, { name: 'back.png', data: PNG }])
const maid = lib.saveEntry('outfits', { name: '女仆装', description: '深蓝白色女仆裙配鲸鱼围裙' })
lib.addImages('outfits', maid.id, [{ name: 'maid.png', data: PNG }])
const room = lib.saveEntry('scenes', { name: '卧室', aliases: ['房间'], description: '暖光小卧室' })
lib.addImages('scenes', room.id, [{ name: 'room.png', data: PNG }])
const bed = lib.saveEntry('props', { name: '床', description: '白色铁艺单人床' })
lib.addImages('props', bed.id, [{ name: 'bed.png', data: PNG }])
assert.throws(() => lib.addImages('props', bed.id, [{ name: 'x.txt', data: Buffer.from('hello world!!') }]), /不是支持的图片/)

// ---- 提示词注入 ----
const guide = contexts[0].text({})
assert.match(guide, /image_generate/)
assert.match(guide, /小鱼/)
assert.match(guide, /卧室/)
assert.ok(!guide.includes('{{'))
console.log('--- guide ---\n' + guide + '\n-------------')

// ---- 工具：自动匹配 + 默认服饰 ----
const gen = tools.get('image_generate')
const exec = { signal: new AbortController().signal, agent: { session: { header: { id: 'S1' } } } }
const t0 = Date.now()
const v = await gen.execute({ prompt: '小鱼在房间里、在床上抱着枕头休息，午后暖光，近景', aspect: '3:4', user_requested: true }, exec)
console.log('generate took', Date.now() - t0, 'ms')
assert.equal(v.ok, true, JSON.stringify(v))
const post = seen.posts.at(-1).body
assert.equal(post.kind, 'image')
assert.equal(post.model, 'gpt-image-2')
assert.equal(post.input.size, '3:4')
assert.equal(post.input.resolution, '2k')
assert.equal(post.input.image_urls.length, 5, 'character×2 + outfit + scene + prop')
assert.ok(post.input.image_urls.every((u) => u.startsWith('data:image/png;base64,')))
assert.match(post.input.prompt, /图1–2：人物「小鱼」/)
assert.match(post.input.prompt, /图3：服饰「女仆装」——只参考服装设计.*穿在「小鱼」身上/)
assert.match(post.input.prompt, /图4：场景「卧室」/)
assert.match(post.input.prompt, /图5：道具「床」/)
assert.ok(seen.posts.at(-1).idem.startsWith('dsh-image-studio-'))
console.log('--- final prompt ---\n' + post.input.prompt + '\n--------------------')
const text = gen.output.render({}, v)[0].text
assert.match(text, /已生成图片 img-/)
console.log('--- tool result ---\n' + text + '\n-------------------')
const meta = gen.output.presentationMeta({}, v)
assert.equal(meta.ok, true)
assert.equal(meta.id, v.id)

// ---- 冷却：没有 user_requested 时被拦 ----
const v2 = await gen.execute({ prompt: '小鱼伸懒腰' }, exec)
assert.equal(v2.ok, false)
assert.match(v2.message, /冷却/)

// ---- 显式指定 + 参考图上限 + 未知名字 ----
store.updateConfig({ compose: { maxRefs: 2 } })
const v3 = await gen.execute({ prompt: '站在窗边', characters: ['大肥鱼'], scene: '不存在的场景', user_requested: true, extra_images: [v.id] }, exec)
assert.equal(v3.ok, true)
const p3 = seen.posts.at(-1).body.input
assert.equal(p3.image_urls.length, 2)
assert.match(p3.prompt, /图1：上一张生成图/)
assert.match(p3.prompt, /图2：人物「小鱼」/)
assert.deepEqual(v3.unresolved, ['场景「不存在的场景」'])
store.updateConfig({ compose: { maxRefs: 8 } })

// ---- 失败任务 ----
await assert.rejects(gen.execute({ prompt: 'FAILME', user_requested: true }, exec), /生成失败（不扣费）：content_policy：blocked/)

// ---- image_library ----
const libText = await tools.get('image_library').execute({ id: '小鱼' })
assert.match(libText, /人设：\n嘴硬心软/)
assert.match(await tools.get('image_library').execute({ query: '床' }), /道具/)

// ---- HTTP ----
const srv = http.createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const B = `http://127.0.0.1:${srv.address().port}/api/image-studio`
const j = async (p, body) => { const r = await fetch(B + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
let r = await j('/state')
assert.equal(r.status, 200)
assert.equal(r.json.config.api.apiKey, '')
assert.equal(r.json.config.api.hasKey, true)
assert.equal(r.json.counts.characters, 1)
r = await j('/library')
assert.equal(r.json.categories.characters[0].images.length, 3)
const img = r.json.categories.characters[0].images[0]
let fr = await fetch(`${B}/file?c=characters&id=${encodeURIComponent(xy.id)}&f=${encodeURIComponent(img.file)}`)
assert.equal(fr.status, 200)
assert.equal(fr.headers.get('content-type'), 'image/png')
fr = await fetch(`${B}/file?c=characters&id=..&f=..%2F..%2Fconfig.json`)
assert.equal(fr.status, 400)
r = await j('/history')
assert.ok(r.json.items.length >= 3)
assert.ok(r.json.items.some((i) => i.status === 'failed'))
fr = await fetch(`${B}/file?h=${v.id}&b64=1`)
assert.equal((await fr.json()).mime, 'image/png')
r = await j('/config', { api: { model: 'gpt-image-2-eco', apiKey: '' }, policy: { mode: 'manual' } })
assert.equal(r.json.config.api.model, 'gpt-image-2-eco')
assert.equal(r.json.config.api.hasKey, true, 'empty apiKey keeps the old key')
assert.match(contexts[0].text({}), /只在用户明确要图时调用/)
r = await j('/test', {})
assert.deepEqual(r.json.models, ['gpt-image-2'])
r = await j('/entry', { category: 'props', name: '枕头', tags: '软, 白色' })
assert.deepEqual(r.json.entry.tags, ['软', '白色'])
r = await j('/upload', { category: 'props', id: r.json.entry.id, files: [{ name: 'p.png', data: 'data:image/png;base64,' + PNG.toString('base64') }] })
assert.equal(r.json.entry.images.length, 1)
r = await j('/entry/delete', { category: 'props', id: '枕头' })
assert.ok(r.json.trashedTo)
r = await j('/generate', { prompt: '小鱼在卧室看书', aspect: '1:1' })
const jobId = r.json.jobId
let job
for (let i = 0; i < 30; i++) { await new Promise((s) => setTimeout(s, 500)); job = (await j(`/job?id=${jobId}`)).json; if (job.status !== 'running') break }
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.record.files.length, 1)
r = await j('/dir', { category: 'scenes', path: path.join(tmp, 'elsewhere'), create: true })
assert.equal(r.json.dirs.scenes.custom, true)
assert.equal(r.json.categories.scenes.length, 0)
r = await j('/dir', { category: 'scenes', path: 'relative/path' })
assert.equal(r.status, 400)
r = await j('/dir', { category: 'scenes', path: '' })
assert.equal(r.json.categories.scenes.length, 1)

srv.close(); api.close()
console.log('ALL HOST TESTS PASSED · data dir', tmp)
