// v0.2 冒烟测试：关键词库 / 情境搭配 / 新提示词结构 / 识图（宿主 llm + OpenAI 兼容）/ 导入三视图 / 已有条目补三视图。
// 用法：node tests/smoke-host-v2.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-is2-'))
process.env.DSH_HOME = tmp
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const FIELDS = { name: '蓝白女仆装', aliases: ['女仆服'], tags: ['女仆', '蓝白', '洛丽塔'], description: '深蓝与白色相间的女仆连衣裙，白色荷叶边围裙，蓝色蝴蝶结。' }

// ---- 假接口：65535 任务 + OpenAI chat ----
const seen = { tasks: [], chats: [] }
const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (req.url.startsWith('/out/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
    if (req.method === 'POST' && req.url === '/v1/tasks') { seen.tasks.push(JSON.parse(body)); return json(202, { id: 'img_' + seen.tasks.length }) }
    if (req.method === 'GET' && req.url.startsWith('/v1/tasks/')) { const id = req.url.split('/').pop(); return json(200, { id, status: 'done', model: 'gpt-image-2', size: '2048x1152', result_urls: [`http://127.0.0.1:${api.address().port}/out/${id}.png`] }) }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') { const j = JSON.parse(body); seen.chats.push(j); return json(200, { choices: [{ message: { content: '```json\n' + JSON.stringify({ ...FIELDS, name: '来自OpenAI' }) + '\n```' } }] }) }
    json(404, {})
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const API = `http://127.0.0.1:${api.address().port}`

// ---- 假 ctx（含 llm / attachments）----
const tools = new Map()
const contexts = []
let handler = null
const llmCalls = []
let llmMode = 'ok'
const ctx = {
  logger: { info() {}, warn() {} },
  tools: { register(def) { tools.set(def.name, def); return () => {} } },
  systemPrompt: { context(c) { contexts.push(c); return () => {} } },
  webServer: { register(r) { handler = r.handler; return () => {} } },
  effect(fn) { return fn() },
  get(name) {
    if (name === 'attachments') return { imageLimits: { maxImageBytes: 20 << 20 }, async saveImages(inputs) { return inputs.map((x, i) => ({ id: 'att-' + i, mediaType: x.mediaType })) } }
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'deepseek-official' }],
        listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'Pro', inputModalities: ['text'] }, { provider: 'deepseek-official', id: 'deepseek-flash', name: 'Flash', inputModalities: ['text', 'image'] }],
        stream: async function* (opts) {
          llmCalls.push(opts)
          if (llmMode === 'error') { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model overloaded' } } }; return }
          const text = JSON.stringify(FIELDS)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          for (let i = 0; i < text.length; i += 17) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 17) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    }
    return undefined
  },
}

const store = await import('../lib/store.js')
const lib = await import('../lib/library.js')
const presets = await import('../lib/presets.js')
const { compose } = await import('../lib/compose.js')
const plugin = await import('../lib/index.js')
plugin.apply(ctx)
store.updateConfig({ api: { baseUrl: API, apiKey: 'k' }, policy: { cooldownMin: 0 } })
assert.ok(existsSync(path.join(tmp, 'image-studio', 'presets.json')), 'presets.json written on first run')

// ---- 库 ----
const xy = lib.saveEntry('characters', { name: '小鱼', description: '蓝发鲸鱼娘', traits: '开心时尾巴会左右摇摆', situationOutfits: { 在家休息: '睡衣' }, defaultOutfit: '女仆装' })
lib.addImages('characters', xy.id, [{ name: 'a.png', data: PNG }])
for (const n of ['睡衣', '女仆装', '通勤休闲装']) lib.addImages('outfits', lib.saveEntry('outfits', { name: n }).id, [{ name: 'o.png', data: PNG }])
lib.addImages('scenes', lib.saveEntry('scenes', { name: '卧室', defaultOutfit: '女仆装' }).id, [{ name: 's.png', data: PNG }])
lib.addImages('scenes', lib.saveEntry('scenes', { name: '客厅', defaultOutfit: '通勤休闲装' }).id, [{ name: 's.png', data: PNG }])
const cfg = store.getConfig()
const L = lib.scanAll(true)

// ---- 情境搭配 ----
let plan = compose({ prompt: '窝在床上玩手机', characters: ['小鱼'], situation: '在家', expression: '害羞', shot: '自拍' }, cfg, L)
assert.equal(plan.selected.scene.name, '卧室', 'situation scene')
assert.deepEqual(plan.selected.outfits.map((o) => o.name), ['睡衣'], 'character situation outfit beats scene default')
assert.match(plan.finalPrompt, /【情境】在家休息：/)
assert.match(plan.finalPrompt, /【神态】脸颊泛起红晕/)
assert.match(plan.finalPrompt, /【镜头】手机自拍视角/)
assert.match(plan.finalPrompt, /【光线氛围】午后温暖的阳光/, 'situation default light')
assert.match(plan.finalPrompt, /【人物神态特点】\n小鱼：开心时尾巴会左右摇摆/)
assert.match(plan.finalPrompt, /不要沿用任何一张参考图里的站姿/)
assert.deepEqual(plan.keywords, { situation: '在家休息', expression: '害羞', shot: '自拍', light: '午后暖阳' })
console.log('--- situation prompt ---\n' + plan.finalPrompt + '\n------------------------')
// 情境默认服饰（人物没设）→ 库里有
plan = compose({ prompt: '敲键盘', characters: ['小鱼'], situation: '上班' }, cfg, L)
assert.deepEqual(plan.selected.outfits.map((o) => o.name), ['通勤休闲装'])
// 情境默认服饰库里没有 → 文字兜底
plan = compose({ prompt: '在床上', characters: ['小鱼'], situation: '睡前' }, cfg, L)
assert.deepEqual(plan.selected.outfits.map((o) => o.name), [])
assert.match(plan.finalPrompt, /【搭配】小鱼穿着居家针织服/)
// 没有情境 → 场景默认服饰 > 人物默认
plan = compose({ prompt: '看电视', characters: ['小鱼'], scene: '客厅' }, cfg, L)
assert.deepEqual(plan.selected.outfits.map((o) => o.name), ['通勤休闲装'])
plan = compose({ prompt: '散步', characters: ['小鱼'] }, cfg, L)
assert.deepEqual(plan.selected.outfits.map((o) => o.name), ['女仆装'])
// 显式指定永远优先；未收录的关键词原样使用
plan = compose({ prompt: 'x', characters: ['小鱼'], outfits: ['女仆装'], situation: '在家', expression: '眼睛眯成一条缝偷笑' }, cfg, L)
assert.deepEqual(plan.selected.outfits.map((o) => o.name), ['女仆装'])
assert.match(plan.finalPrompt, /【神态】眼睛眯成一条缝偷笑/)
// 严格模式
plan = compose({ prompt: 'x', characters: ['小鱼'] }, { ...cfg, compose: { ...cfg.compose, identityOnly: false } }, L)
assert.match(plan.finalPrompt, /严格以参考图为准/)

// ---- 系统提示 ----
const guide = contexts[0].text({})
assert.match(guide, /可用关键词/)
assert.match(guide, /情境（situation）：在家休息、睡前/)
assert.match(guide, /神态（expression）：开心/)

// ---- 工具带关键词 ----
const v = await tools.get('image_generate').execute({ prompt: '伸懒腰', characters: ['小鱼'], situation: '刚睡醒', expression: '困倦', user_requested: true }, { signal: new AbortController().signal, agent: { session: { header: { id: 'S' } } } })
assert.equal(v.ok, true)
assert.deepEqual(v.keywords, { situation: '刚睡醒', expression: '困倦', light: '清晨柔光' })
assert.match(tools.get('image_generate').output.render({}, v)[0].text, /关键词：情境「刚睡醒」/)
assert.deepEqual(tools.get('image_generate').output.presentationMeta({}, v).keywords, v.keywords)

// ---- HTTP ----
const srv = http.createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const B = `http://127.0.0.1:${srv.address().port}/api/image-studio`
const j = async (p, body) => { const r = await fetch(B + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
const waitJob = async (id) => { for (let i = 0; i < 60; i++) { await new Promise((s) => setTimeout(s, 400)); const r = (await j('/job?id=' + id)).json; if (r.status !== 'running') return r } throw new Error('job timeout') }
const b64 = 'data:image/png;base64,' + PNG.toString('base64')

let r = await j('/presets')
assert.ok(r.json.presets.expression.length > 10)
const edited = { ...r.json.presets, expression: [...r.json.presets.expression, { name: '社死', aliases: ['尴尬'], prompt: '捂着脸蹲下，耳朵通红' }] }
r = await j('/presets', { presets: edited })
assert.equal(presets.findPreset('expression', '尴尬').name, '社死')
r = await j('/presets/reset', { group: 'expression' })
assert.equal(presets.findPreset('expression', '尴尬'), null)
r = await j('/state')
assert.equal(r.json.build, 'v0.2.0')
assert.equal(r.json.config.vision.source, 'dsh')
r = await j('/vision/models')
assert.deepEqual(r.json.models, [{ route: 'deepseek-official/deepseek-flash', name: 'Flash' }])

// 导入：识图（宿主 llm）+ 服装三视图
r = await j('/import/start', { category: 'outfits', files: [{ name: 'dress.png', data: b64 }], hint: '只要裙子' })
const { jobId, importId } = r.json
let job = await waitJob(jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.deepEqual(job.result.fields, FIELDS)
assert.equal(llmCalls.at(-1).provider, 'deepseek-official')
assert.equal(llmCalls.at(-1).model, 'deepseek-flash')
assert.equal(llmCalls.at(-1).messages[0].content.filter((c) => c.type === 'image').length, 1)
assert.match(llmCalls.at(-1).messages[0].content[0].text, /服装设计整理助手[\s\S]*只要裙子/)
const sheetTask = seen.tasks.at(-1)
assert.match(sheetTask.input.prompt, /服装设计三视图/)
assert.match(sheetTask.input.prompt, /补充要求（优先遵守）：只要裙子/)
assert.match(sheetTask.input.prompt, /参考描述（帮助还原细节）：深蓝与白色/)
assert.equal(sheetTask.input.size, '16:9')
assert.equal(sheetTask.input.image_urls.length, 1)
assert.ok(job.result.sheet.id)
let fr = await fetch(`${B}/file?s=${importId}&f=src-1.png`)
assert.equal(fr.status, 200)
fr = await fetch(`${B}/file?s=${importId}&f=../meta.json`)
assert.equal(fr.status, 404)
// 重新生成三视图
r = await j('/import/sheet', { importId, hint: '加上鞋子' })
const job2 = await waitJob(r.json.jobId)
assert.match(seen.tasks.at(-1).input.prompt, /补充要求（优先遵守）：加上鞋子/)
// 入库
r = await j('/import/commit', { importId, fields: { ...FIELDS, name: '我的女仆裙' }, sheetId: job2.result.sheet.id, useSheet: true, useOriginals: true })
assert.equal(r.status, 200, JSON.stringify(r.json))
assert.equal(r.json.entry.name, '我的女仆裙')
assert.deepEqual(r.json.entry.images.map((i) => i.file), ['三视图.png', '原图.png'])
assert.equal(r.json.entry.cover, '三视图.png')
assert.deepEqual(r.json.entry.tags, FIELDS.tags)
assert.ok(!existsSync(path.join(tmp, 'image-studio', 'staging', importId)), 'staging cleaned')

// 识图失败也照样出三视图；人物用角色三视图提示词
llmMode = 'error'
r = await j('/import/start', { category: 'characters', files: [{ name: 'oc.png', data: b64 }] })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done')
assert.match(job.result.analysisError, /model overloaded/)
assert.ok(job.result.sheet)
assert.match(seen.tasks.at(-1).input.prompt, /角色设定三视图[\s\S]*A 字站姿/)
// 加到已有条目
r = await j('/import/commit', { importId: r.json.importId, fields: job.result.fields, sheetId: job.result.sheet.id, useSheet: true, useOriginals: false, targetId: xy.id })
assert.equal(r.json.entry.cover, '三视图.png')
assert.equal(r.json.entry.images.length, 2)
llmMode = 'ok'

// 已有条目：补三视图 / 识别补全；场景是设定图
const sceneId = L.scenes.find((e) => e.name === '卧室').id
r = await j('/entry/sheet', { category: 'scenes', id: sceneId })
job = await waitJob(r.json.jobId)
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.result.entry.cover, '设定图.png')
assert.match(seen.tasks.at(-1).input.prompt, /场景设定图/)
assert.equal(seen.tasks.at(-1).input.size, '4:3')
r = await j('/entry/analyze', { category: 'scenes', id: sceneId })
job = await waitJob(r.json.jobId)
assert.equal(job.result.fields.name, FIELDS.name)
assert.equal(llmCalls.at(-1).messages[0].content.filter((c) => c.type === 'image').length, 2)

// OpenAI 兼容识图 + 识图 Key 处理
r = await j('/config', { vision: { source: 'openai', baseUrl: API, model: 'gpt-x', apiKey: 'vk-1234' } })
assert.equal(r.json.config.vision.hasKey, true)
assert.equal(r.json.config.vision.keyHint, '••••1234')
assert.equal(r.json.config.vision.apiKey, '')
r = await j('/config', { vision: { source: 'openai', apiKey: '' } })
assert.equal(r.json.config.vision.hasKey, true, 'empty vision key keeps old one')
r = await j('/entry/analyze', { category: 'scenes', id: sceneId })
job = await waitJob(r.json.jobId)
assert.equal(job.result.fields.name, '来自OpenAI')
assert.equal(seen.chats.at(-1).model, 'gpt-x')
assert.ok(seen.chats.at(-1).messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'))

// 历史里能看到三视图记录
r = await j('/history')
assert.ok(r.json.items.some((i) => i.source === 'sheet' && /三视图|设定图/.test(i.prompt)))

srv.close(); api.close()
console.log('ALL V2 HOST TESTS PASSED')
