// v0.4 冒烟测试：生图跟着「大肥鱼全天日程」此刻的穿搭走。
// 用法：node tests/smoke-schedule-link.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-is4-'))
process.env.DSH_HOME = tmp
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const store = await import('../lib/store.js')
const lib = await import('../lib/library.js')
const { getPresets } = await import('../lib/presets.js')
const { compose } = await import('../lib/compose.js')
const link = await import('../lib/schedule-link.js')
store.loadConfig()

// ---- 库（和用户的库同一个样子）----
const add = (cat, data) => { const e = lib.saveEntry(cat, data); lib.addImages(cat, e.id, [{ name: 'a.png', data: PNG }]); return e }
add('characters', { name: '鱼鱼', aliases: ['小鱼', '大肥鱼'], defaultOutfit: '通勤休闲装' })
add('characters', { name: 'Q版小鱼' })
for (const n of ['JK短裙', '居家针织服', '通勤休闲装', '复古']) add('outfits', { name: n })
for (const n of ['卧室', '客厅', '江畔暖灯咖啡屋']) add('scenes', { name: n })
const L = lib.scanAll(true)
const P = getPresets()

// ---- 日程插件的数据 ----
const sroot = path.join(tmp, 'daily-schedule')
mkdirSync(path.join(sroot, 'days'), { recursive: true })
const writeCfg = (extra = {}) => writeFileSync(path.join(sroot, 'config.json'), JSON.stringify({ enabled: true, characterName: '小鱼', imageStudio: true, timeZone: 'Australia/Sydney', imageCharacter: '', link: { outfits: true, scenes: true, props: true, people: true }, ...extra }))
writeCfg()
writeFileSync(path.join(sroot, 'days', '2026-10-29.json'), JSON.stringify({
  date: '2026-10-29',
  items: [
    { start: '00:00', end: '09:00', activity: '睡觉', scene: '卧室', outfitNote: '睡衣' },
    { start: '09:00', end: '12:00', activity: '窝沙发', scene: '客厅', outfit: '居家针织服' },
    { start: '12:00', end: '16:00', activity: '咖啡馆', scene: '江畔暖灯咖啡屋', outfit: 'JK短裙', outfitNote: '外面加了件开衫' },
    { start: '16:00', end: '24:00', activity: '回家', location: '路上' },
  ],
}))
// 悉尼 10/29 是夏令时（UTC+11）
const at = (hm) => { const [h, m] = hm.split(':').map(Number); return new Date(Date.UTC(2026, 9, 28, h + 13, m)) }
const names = (plan) => plan.refs.filter((r) => r.category === 'outfits').map((r) => r.name)
const cfg = () => store.getConfig()
const run = (args, hm) => compose({ prompt: '她在画面里', ...args }, cfg(), L, P, { now: at(hm) })

// 此刻那一段
const cur = link.currentScheduleItem(at('14:10'))
assert.equal(cur.date, '2026-10-29'); assert.equal(cur.item.activity, '咖啡馆')
assert.equal(link.scheduleCharacter(cur.cfg, L).name, '鱼鱼', '小鱼 是 鱼鱼 的别名')

// 1. 没指定服饰 → 跟日程：库里的服饰 + 细节
let plan = run({ characters: ['鱼鱼'] }, '14:10')
assert.deepEqual(names(plan), ['JK短裙'])
assert.match(plan.finalPrompt, /鱼鱼的穿着细节：外面加了件开衫/)
assert.ok(plan.notes.some((n) => /按日程此刻（12:00–16:00 咖啡馆）的穿搭「JK短裙」（外面加了件开衫）/.test(n)), plan.notes.join('\n'))
// 用别名指人物也认
assert.deepEqual(names(run({ characters: ['小鱼'] }, '14:10')), ['JK短裙'])

// 2. 显式指定服饰 → 不动
assert.deepEqual(names(run({ characters: ['鱼鱼'], outfits: ['复古'] }, '14:10')), ['复古'])

// 3. 场景和日程此刻不一样 → 画的不是此刻，按默认规则
assert.deepEqual(names(run({ characters: ['鱼鱼'], scene: '卧室' }, '14:10')), ['通勤休闲装'])
// 场景一致 → 跟
assert.deepEqual(names(run({ characters: ['鱼鱼'], scene: '江畔暖灯咖啡屋' }, '14:10')), ['JK短裙'])

// 4. 日程只写了文字（库里没有的睡衣）→ 只按文字，不再套默认服饰
plan = run({ characters: ['鱼鱼'] }, '03:00')
assert.deepEqual(names(plan), [])
assert.match(plan.finalPrompt, /【搭配】鱼鱼穿着睡衣/)
assert.ok(plan.notes.some((n) => /按日程此刻（00:00–09:00 睡觉）的穿搭：睡衣（库里没有/.test(n)))

// 5. 这一段没写穿搭 → 默认规则
assert.deepEqual(names(run({ characters: ['鱼鱼'] }, '17:00')), ['通勤休闲装'])

// 6. 别的人物不受影响
assert.deepEqual(names(run({ characters: ['Q版小鱼'] }, '14:10')), [])

// 7. 日程里指定「她」是 Q版小鱼
writeCfg({ imageCharacter: 'Q版小鱼' })
assert.deepEqual(names(run({ characters: ['Q版小鱼'] }, '14:10')), ['JK短裙'])
assert.deepEqual(names(run({ characters: ['鱼鱼'] }, '14:10')), ['通勤休闲装'])
writeCfg()

// 8. 日程那边关了穿搭联动 / 关了日程 → 不跟
writeCfg({ link: { outfits: false } })
assert.deepEqual(names(run({ characters: ['鱼鱼'] }, '14:10')), ['通勤休闲装'])
writeCfg({ enabled: false })
assert.deepEqual(names(run({ characters: ['鱼鱼'] }, '14:10')), ['通勤休闲装'])
writeCfg()

// 9. 这边关掉开关 → 不跟；配置能存
assert.equal(cfg().compose.followSchedule, true)
store.updateConfig({ compose: { followSchedule: false } })
assert.equal(cfg().compose.followSchedule, false)
assert.deepEqual(names(run({ characters: ['鱼鱼'] }, '14:10')), ['通勤休闲装'])
store.updateConfig({ compose: { followSchedule: true } })

// 10. 没有那天的日程 / 文件坏了 → 照旧
assert.equal(link.currentScheduleItem(at('14:10').getTime() + 86400000 * 3 && new Date(Date.UTC(2026, 10, 2, 3))), null)
writeFileSync(path.join(sroot, 'config.json'), '{坏了')
assert.deepEqual(names(run({ characters: ['鱼鱼'] }, '14:10')), ['通勤休闲装'])

console.log('ALL SCHEDULE-LINK TESTS PASSED')
