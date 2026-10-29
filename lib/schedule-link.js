/**
 * dsh-image-studio —— 读「大肥鱼全天日程」插件（dsh-daily-schedule）此刻的那一段，
 * 让没指定服饰的生图沿用日程里她此刻的穿着，同一天里前后出的图衣服对得上。
 *
 * 只读文件，不依赖那个插件是否装着：<DSH_HOME>/daily-schedule/config.json + days/<今天>.json。
 * 读不到、没开联动、此刻那段没写穿搭，都返回 null，照旧走默认服饰的规则。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { resolveRef } from './library.js'
import { dshHome } from './store.js'

let rootOverride = ''
/** 测试用：把日程插件的数据目录指到别处。 */
export function __setScheduleRootForTest(dir) { rootOverride = dir }
export function scheduleRoot() { return rootOverride || path.join(dshHome(), 'daily-schedule') }

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null } catch { return null }
}

function systemTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

function zonedNow(tz, now) {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    return zonedNow('UTC', now)
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, minute: (Number(p.hour) % 24) * 60 + Number(p.minute) }
}

function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const v = Number(m[1]) * 60 + Number(m[2])
  return v >= 0 && v <= 1440 ? v : null
}

/**
 * 日程此刻的那一段。
 * @returns {{ date, item, cfg } | null}
 */
export function currentScheduleItem(now = new Date()) {
  const root = scheduleRoot()
  const cfg = readJson(path.join(root, 'config.json'))
  if (!cfg || cfg.enabled === false || cfg.imageStudio === false) return null
  if (cfg.link && cfg.link.outfits === false) return null
  const { date, minute } = zonedNow(cfg.timeZone || systemTimeZone(), now)
  const day = readJson(path.join(root, 'days', `${date}.json`))
  if (!day || !Array.isArray(day.items)) return null
  const item = day.items.find((it) => {
    const a = parseClock(it.start)
    const b = parseClock(it.end)
    return a !== null && b !== null && a <= minute && minute < b
  })
  return item ? { date, item, cfg } : null
}

/** 日程里的「她」对应人物库哪一条：指定的人物 > 按名字 / 别名 > 库里只有一个人。 */
export function scheduleCharacter(cfg, lib) {
  if (cfg.imageCharacter) {
    const e = resolveRef('characters', cfg.imageCharacter, lib)
    if (e) return e
  }
  if (cfg.characterName) {
    const e = resolveRef('characters', cfg.characterName, lib)
    if (e) return e
  }
  const all = (lib && lib.characters) || []
  return all.length === 1 ? all[0] : null
}

/**
 * 给 compose 用：这张图里的人物 c 是不是日程里的她、此刻穿什么。
 * scene = 这次显式指定的场景；和日程此刻的场景不一样，说明画的不是「此刻」，不跟。
 * @returns {{ outfit: entry|null, text: string, why: string } | null}
 */
export function scheduleOutfitFor(c, { lib, scene, now } = {}) {
  const cur = currentScheduleItem(now)
  if (!cur) return null
  const { item, cfg } = cur
  const her = scheduleCharacter(cfg, lib)
  if (!her || her.id !== c.id) return null
  if (scene && item.scene) {
    const s = resolveRef('scenes', item.scene, lib)
    if (s && s.id !== scene.id) return null
  }
  const name = String(item.outfit || '').trim()
  const note = String(item.outfitNote || '').trim()
  if (!name && !note) return null
  const o = name ? resolveRef('outfits', name, lib) : null
  const text = [o ? '' : name, note].filter(Boolean).join('，')
  const why = `日程此刻（${item.start}–${item.end} ${item.activity || ''}）`.replace(/ ）$/, '）')
  return { outfit: o, text, why }
}
