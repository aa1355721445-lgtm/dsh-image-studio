// 浏览器半冒烟测试：用宿主半造出真实形状的数据，再把 client.js 的每个页面 / 状态「渲染」一遍。
// 用法：node tests/smoke-client.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import FakeReact, { render } from './fake-react.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-isc-'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAJJRU5ErkJggg==', 'base64')

// ---- 宿主半：造数据 ----
const store = await import('../lib/store.js')
const lib = await import('../lib/library.js')
const { createHandler } = await import('../lib/http.js')
store.loadConfig(); store.ensureDirs()
const c = lib.saveEntry('characters', { name: '小鱼', tags: '主角', description: '蓝发', persona: '嘴硬', defaultOutfit: '女仆装' })
lib.addImages('characters', c.id, [{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }])
lib.saveEntry('outfits', { name: '女仆装' })
const handler = createHandler()
const srv = http.createServer(handler)
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}/api/image-studio`
const state = await (await fetch(base + '/state')).json()
const library = await (await fetch(base + '/library')).json()
srv.close()

// ---- 加载 client.js ----
let def = null
const styles = []
const fakeDoc = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, set textContent(v) { styles.push(v) } }),
  head: { appendChild() {} },
}
const sandbox = { window: { __ModuleLoader__: { load(d) { def = d } } }, document: fakeDoc, console, URL, Promise, Map, setTimeout, clearTimeout }
vm.runInNewContext(readFileSync(path.join(here, '../lib/client.js'), 'utf8'), sandbox)
assert.equal(def.id, 'dsh-image-studio')
const mod = def.factory((name) => { if (name === 'react') return FakeReact; throw new Error('unexpected require ' + name) })
assert.equal(mod.name, 'image-studio')
assert.equal(JSON.stringify(mod.inject), '["slots"]')

// apply：两个 slot 注册
const regs = []
const ctx = {
  effect(fn) { return fn() },
  slots: { inject(name, fn) { const r = fn(); return r }, register(opts, comp) { regs.push({ opts, comp }); return () => {} } },
}
sandbox.document = fakeDoc
mod.apply(ctx)
assert.deepEqual(regs.map((r) => r.opts.name), ['settings.section', 'tool.call.toolview'])
assert.equal(regs[0].opts.label(), '生图工作室')
assert.equal(regs[1].opts.key, 'image_generate')
assert.ok(styles[0].includes('.is-root'))

const T = mod.__test
const h = FakeReact.createElement
const txt = (el) => render(el).join(' ')
const toast = () => {}

// 设置页外壳首帧
assert.match(txt(regs[0].comp({})), /加载中/)

// 素材库
let out = txt(h(T.LibraryTab, { lib: library, setLib() {}, reloadLib: () => Promise.resolve(), toast }))
assert.match(out, /人物/); assert.match(out, /小鱼/); assert.match(out, /2 张图/); assert.match(out, /新建人物/)
// 空库
const emptyLib = { dirs: library.dirs, categories: { characters: [], outfits: [], scenes: [], props: [] } }
assert.match(txt(h(T.LibraryTab, { lib: emptyLib, setLib() {}, reloadLib: () => Promise.resolve(), toast })), /库还是空的/)

// 条目编辑：已有 / 新建
const entry = library.categories.characters[0]
out = txt(h(T.EntryEditor, { category: 'characters', entry, outfits: library.categories.outfits, toast, onBack() {}, onSaved: () => Promise.resolve(), onDeleted: () => Promise.resolve() }))
assert.match(out, /封面/); assert.match(out, /\[input:小鱼\]/); assert.match(out, /人设/); assert.match(out, /默认服饰/); assert.match(out, /女仆装/)
out = txt(h(T.EntryEditor, { category: 'scenes', entry: null, outfits: [], toast, onBack() {}, onSaved: () => Promise.resolve(), onDeleted: () => Promise.resolve() }))
assert.match(out, /新建场景/); assert.match(out, /先起个名字/); assert.ok(!/人设/.test(out))

// 试生成：空闲 / 进行中 / 完成 / 失败
const draft0 = { prompt: '', characters: [], outfits: [], scene: '', props: [], aspect: '3:4', job: null }
out = txt(h(T.CreateTab, { lib: library, config: state.config, draft: draft0, setDraft() {}, toast }))
assert.match(out, /还没填 API Key/); assert.match(out, /画幅/)
const cfgWithKey = { ...state.config, api: { ...state.config.api, hasKey: true } }
out = txt(h(T.CreateTab, { lib: library, config: cfgWithKey, draft: { ...draft0, prompt: 'x', job: { id: 'j', status: 'running', stage: '排队中', elapsedMs: 4200 } }, setDraft() {}, toast }))
assert.match(out, /排队中 · 4 秒/)
const record = { id: 'img-1', status: 'done', files: ['2026-10/img-1.png'], prompt: 'p', finalPrompt: 'FP', model: 'gpt-image-2', size: '1024x1536', aspect: '3:4', ms: 31000, cost: 0.04, refs: [{ kind: 'entry', category: 'characters', name: '小鱼', count: 2 }], notes: ['n1'], unresolved: ['场景「X」'] }
out = txt(h(T.CreateTab, { lib: library, config: cfgWithKey, draft: { ...draft0, prompt: 'x', job: { id: 'j', status: 'done', record } }, setDraft() {}, toast }))
assert.match(out, /人物「小鱼」×2/); assert.match(out, /31 秒/); assert.match(out, /库里没找到：场景「X」/); assert.match(out, /FP/)
out = txt(h(T.CreateTab, { lib: library, config: cfgWithKey, draft: { ...draft0, prompt: 'x', job: { id: 'j', status: 'failed', error: '余额不足', record: { ...record, status: 'failed', files: [] } } }, setDraft() {}, toast }))
assert.match(out, /余额不足/)

// 生成记录首帧
assert.match(txt(h(T.HistoryTab, { version: 0, toast })), /加载中/)

// 设置
out = txt(h(T.SettingsTab, { state, onState() {}, toast }))
assert.match(out, /生图接口/); assert.match(out, /大陆优化线路/); assert.match(out, /适度（推荐）/); assert.match(out, /\[input:gpt-image-2\]/); assert.match(out, /参考图组合/); assert.match(out, /设置已是最新/)

// 聊天卡片：准备 / 运行 / 成功 / 冷却 / 报错 / 停止
const row = (block) => txt(h(T.ImageGenRow, { block }))
assert.match(row({ phase: 'preparing', argsRaw: '{"prompt":"小鱼在', args: { text: (k) => (k === 'prompt' ? '小鱼在' : undefined), complete: () => false } }), /小鱼在.*正在构思画面/)
assert.match(row({ phase: 'start', argsRaw: '{"prompt":"小鱼睡觉"}' }), /正在画/)
out = row({ kind: 'result', call: { argsRaw: '{"prompt":"小鱼睡觉","caption":"午睡"}' }, isError: false, content: [{ type: 'text', text: '已生成图片 img-1' }], meta: { studio: 'image-studio', ok: true, id: 'img-1', refs: '人物「小鱼」' } })
assert.match(out, /午睡/); assert.match(out, /参考：人物「小鱼」/); assert.match(out, /img-1/)
assert.match(row({ kind: 'result', isError: false, content: [{ type: 'text', text: '冷却中' }], meta: { studio: 'image-studio', ok: false, message: '主动发图冷却中' } }), /主动发图冷却中/)
assert.match(row({ kind: 'result', isError: true, content: [{ type: 'text', text: 'Error: 余额不足（HTTP 402）\nmore' }] }), /余额不足（HTTP 402）/)
assert.match(row({ kind: 'result', isError: true, error: { code: 'interrupted' }, content: [] }), /已停止/)
// 没有 meta（老记录）时从文本里认编号
assert.match(row({ kind: 'result', isError: false, content: [{ type: 'text', text: '已生成图片 img-20261027-1-ab（x）' }] }), /img-20261027-1-ab/)

console.log('ALL CLIENT TESTS PASSED')

// ======================= v0.2：关键词 / 导入 / 识图设置 =======================
{
  const srv2 = http.createServer(createHandler())
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
  const b2 = `http://127.0.0.1:${srv2.address().port}/api/image-studio`
  const presets = (await (await fetch(b2 + '/presets')).json()).presets
  const state2 = await (await fetch(b2 + '/state')).json()
  srv2.close()
  const cfgKey = { ...state2.config, api: { ...state2.config.api, hasKey: true } }

  // 关键词页：情境带场景 / 服饰 / 光线三个输入
  let o = txt(h(T.KeywordsTab, { presets, onPresets() {}, lib: library, toast }))
  assert.match(o, /\[input:在家休息\]/); assert.match(o, /\[input:卧室\]/); assert.match(o, /\[input:午后暖阳\]/); assert.match(o, /添加情境/); assert.match(o, /恢复默认/)

  // 素材库：有「从图片导入」
  o = txt(h(T.LibraryTab, { lib: library, setLib() {}, reloadLib: () => Promise.resolve(), toast, presets, config: cfgKey }))
  assert.match(o, /从图片导入/)

  // 人物编辑：神态特点 + 情境穿搭（每个情境一行）+ 两个 AI 按钮
  const ent = { ...library.categories.characters[0], traits: '开心时尾巴会摇', situationOutfits: { 在家休息: '女仆装' } }
  o = txt(h(T.EntryEditor, { category: 'characters', entry: ent, outfits: library.categories.outfits, presets, config: cfgKey, toast, onBack() {}, onSaved: () => Promise.resolve(), onDeleted: () => Promise.resolve() }))
  assert.match(o, /神态特点/); assert.match(o, /\[textarea:开心时尾巴会摇\]/); assert.match(o, /情境穿搭/); assert.match(o, /刚睡醒/); assert.match(o, /用情境默认：居家针织服/)
  assert.match(o, /生成三视图/); assert.match(o, /识别补全/)
  // 场景编辑：有默认服饰、按钮叫「设定图」、没有人设和情境穿搭
  const sc = { id: 'x', category: 'scenes', kind: 'folder', name: '卧室', aliases: [], tags: [], description: '', persona: '', traits: '', defaultOutfit: '女仆装', situationOutfits: {}, cover: 'a.png', images: [{ file: 'a.png', size: 1, mtime: 1 }] }
  o = txt(h(T.EntryEditor, { category: 'scenes', entry: sc, outfits: library.categories.outfits, presets, config: cfgKey, toast, onBack() {}, onSaved: () => Promise.resolve(), onDeleted: () => Promise.resolve() }))
  assert.match(o, /默认服饰/); assert.match(o, /生成设定图/); assert.ok(!/神态特点|性格、说话方式|用情境默认/.test(o))

  // 导入：选图 / 进行中 / 确认
  o = txt(h(T.ImportPanel, { category: 'outfits', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /从图片导入/); assert.match(o, /把图片拖到这里/); assert.match(o, /生成服装三视图/); assert.match(o, /只要这件外套/)
  FakeReact.__override(['outfits', 'running', [], '', true, true, { stage: '生成服装三视图', elapsedMs: 42000 }])
  o = txt(h(T.ImportPanel, { category: 'outfits', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /生成服装三视图 · 42 秒/)
  const result = { importId: 'imp-1', category: 'outfits', sources: ['src-1.png'], fields: { name: '蓝白女仆装', aliases: [], tags: ['女仆'], description: 'desc' }, analysisError: '', sheet: { id: 'img-9', file: '2026-10/img-9.png' }, sheetError: '' }
  FakeReact.__override(['outfits', 'review', [], '', true, true, null, result, { name: '蓝白女仆装', aliases: '', tags: '女仆', description: 'desc' }, true, true, '', '', '', false])
  o = txt(h(T.ImportPanel, { category: 'outfits', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /服装三视图/); assert.match(o, /识别结果/); assert.match(o, /\[input:蓝白女仆装\]/); assert.match(o, /存入服装三视图并设为封面/); assert.match(o, /加到已有：女仆装/); assert.match(o, /保存到库/)
  // 识图失败 + 没出三视图
  FakeReact.__override(['characters', 'review', [], '', true, true, null, { ...result, category: 'characters', sheet: null, sheetError: '余额不足', analysisError: 'model overloaded' }, { name: '', aliases: '', tags: '', description: '' }, false, true, '', '', '', false])
  o = txt(h(T.ImportPanel, { category: 'characters', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /三视图没生成出来：余额不足/); assert.match(o, /识图没成功：model overloaded/)

  // 试生成：关键词选择
  o = txt(h(T.CreateTab, { lib: library, config: cfgKey, presets, draft: { prompt: 'x', characters: [], outfits: [], scene: '', props: [], aspect: '3:4', situation: '在家休息', expression: '', pose: '', shot: '', light: '', job: null }, setDraft() {}, toast }))
  assert.match(o, /关键词/); assert.match(o, /害羞/); assert.match(o, /抱膝坐/); assert.match(o, /自拍/); assert.match(o, /夜晚台灯/)

  // 设置：识图面板（两种来源）+ 只还原长相开关
  o = txt(h(T.SettingsTab, { state: state2, onState() {}, toast }))
  assert.match(o, /识图/); assert.match(o, /DSH 自带模型/); assert.match(o, /留空 = 自动（第一个支持图片的模型）/); assert.match(o, /参考图只用来还原长相和服装设计/)
  const st3 = { ...state2, config: { ...state2.config, vision: { ...state2.config.vision, source: 'openai' } } }
  o = txt(h(T.SettingsTab, { state: st3, onState() {}, toast }))
  assert.match(o, /65535 对话 · 大陆优化/); assert.match(o, /留空则用生图的 Key/)

  // 聊天卡片显示关键词；生成记录显示关键词
  o = row({ kind: 'result', isError: false, content: [{ type: 'text', text: '已生成图片 img-1' }], meta: { studio: 'image-studio', ok: true, id: 'img-1', refs: '人物「小鱼」', keywords: { situation: '在家休息', expression: '害羞' } } })
  assert.match(o, /情境「在家休息」 · 神态「害羞」/)
  o = txt(h(T.CreateTab, { lib: library, config: cfgKey, presets, draft: { ...draft0, prompt: 'x', job: { id: 'j', status: 'done', record: { ...record, keywords: { pose: '托腮' } } } }, setDraft() {}, toast }))
  assert.match(o, /关键词：动作「托腮」/)

  // 外壳：五个页签 regs[0] 首帧仍是加载中
  console.log('ALL V2 CLIENT TESTS PASSED')

  // ======================= v0.3：文字生成 =======================
  // 素材库有「文字生成」按钮
  o = txt(h(T.LibraryTab, { lib: library, setLib() {}, reloadLib: () => Promise.resolve(), toast, presets, config: cfgKey }))
  assert.match(o, /文字生成/)
  // 文字模式第一步：描述框 + 名字 + 扩写开关，没有拖拽区
  o = txt(h(T.ImportPanel, { category: 'outfits', mode: 'text', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /用文字生成/); assert.match(o, /黑色长款风衣/); assert.match(o, /让模型扩写成详细描述/); assert.match(o, /和小鱼同一种画风/)
  assert.ok(!/把图片拖到这里/.test(o))
  // 图片模式默认不变
  o = txt(h(T.ImportPanel, { category: 'outfits', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /把图片拖到这里/); assert.match(o, /用文字描述/)
  // 文字模式确认页：没有原图区，显示原话；没三视图时提示只存文字条目
  const tres = { importId: 'imp-2', category: 'props', mode: 'text', text: '鲸鱼马克杯', sources: [], fields: { name: '鲸鱼杯', aliases: [], tags: [], description: 'd' }, analysisError: 'rate limited', sheet: null, sheetError: '余额不足' }
  FakeReact.__override(['props', 'review', [], '', true, true, null, tres, { name: '鲸鱼杯', aliases: '', tags: '', description: 'd' }, false, true, '', '', '', false, 'text', '', ''])
  o = txt(h(T.ImportPanel, { category: 'props', mode: 'text', lib: library, config: cfgKey, toast, onBack() {}, onDone: () => Promise.resolve() }))
  assert.match(o, /扩写结果/); assert.match(o, /扩写没成功：rate limited/); assert.match(o, /你的原话：鲸鱼马克杯/); assert.match(o, /只有文字描述的条目/)
  assert.ok(!/同时保存原图/.test(o))
  console.log('ALL V3 CLIENT TESTS PASSED')
}
