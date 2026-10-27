/**
 * dsh-image-studio —— 关键词库（情境 / 神态 / 动作 / 镜头 / 光线）。
 *
 * 模型调用 image_generate 时只需填关键词的名字（如 expression: "害羞"），插件把它展开成
 * 一段具体的画面描述再拼进提示词——这样神态、动作、取景由文字决定，不再被参考图带偏。
 * 「情境」是一组搭配：选「在家休息」会自动带上对应的场景、服饰（人物可单独设）和光线。
 *
 * 存在 <DSH_HOME>/image-studio/presets.json；第一次运行写入下面的默认值，设置页可改。
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'

import { presetsPath, studioRoot } from './store.js'

export const PRESET_GROUPS = ['situation', 'expression', 'pose', 'shot', 'light']
export const PRESET_LABEL = { situation: '情境', expression: '神态', pose: '动作', shot: '镜头', light: '光线' }

const P = (name, aliases, prompt) => ({ name, aliases, prompt })

export const DEFAULT_PRESETS = {
  situation: [
    { name: '在家休息', aliases: ['在家', '宅家', '休息', '放松', '居家'], scene: '卧室', outfit: '居家针织服', light: '午后暖阳', prompt: '放松慵懒的居家氛围，周围有生活感的小物件' },
    { name: '睡前', aliases: ['睡觉', '晚安', '熬夜'], scene: '卧室', outfit: '居家针织服', light: '夜晚台灯', prompt: '夜深了，准备睡觉，被子和枕头有些凌乱，安静温馨' },
    { name: '刚睡醒', aliases: ['起床', '早安', '赖床'], scene: '卧室', outfit: '居家针织服', light: '清晨柔光', prompt: '刚睡醒，头发有点乱，还带着困意' },
    { name: '客厅放松', aliases: ['看电视', '沙发', '窝沙发'], scene: '客厅', outfit: '居家针织服', light: '午后暖阳', prompt: '窝在沙发上，悠闲自在' },
    { name: '工作学习', aliases: ['上班', '工作', '学习', '干活', '写代码'], scene: '', outfit: '通勤休闲装', light: '', prompt: '在电脑或书桌前专注做事，桌上有电脑、笔记和一杯饮料' },
    { name: '外出', aliases: ['出门', '逛街', '约会', '散步'], scene: '', outfit: '复古', light: '午后暖阳', prompt: '在户外，轻松愉快，背景是街道或公园' },
    { name: '吃东西', aliases: ['吃饭', '下午茶', '零食', '吃饭饭'], scene: '', outfit: '', light: '', prompt: '面前摆着诱人的食物，正准备开动或吃得很满足' },
    { name: '下雨天', aliases: ['下雨', '雨天'], scene: '', outfit: '', light: '阴雨天', prompt: '窗外在下雨，玻璃上有雨痕，氛围安静' },
  ],
  expression: [
    P('开心', ['高兴', '愉快', '笑'], '眼睛弯成月牙，露出灿烂的笑容，神情明亮有活力'),
    P('微笑', ['温柔'], '嘴角轻轻上扬的温柔微笑，眼神柔和'),
    P('害羞', ['脸红', '不好意思'], '脸颊泛起红晕，眼神躲闪、微微低头，嘴角含着不好意思的笑'),
    P('得意', ['骄傲', '神气'], '扬起下巴，眯着眼露出得意的坏笑，一副「快夸我」的神气'),
    P('撒娇', ['卖萌'], '歪着头，眼睛亮晶晶地往上看，嘴角带着讨好的笑'),
    P('委屈', ['可怜'], '眉头微蹙，嘴巴瘪起，眼里含着要掉不掉的泪光'),
    P('生气', ['气鼓鼓', '不满'], '鼓起腮帮子，眉毛竖起，气呼呼地瞪着前方'),
    P('惊讶', ['吃惊', '震惊'], '眼睛睁大，嘴巴微张成 O 形，眉毛高高扬起'),
    P('困倦', ['困', '犯困', '没睡醒'], '半睁着惺忪的睡眼，打着哈欠或眼皮打架，神情迷糊'),
    P('认真', ['专注'], '神情专注，目光坚定，嘴唇轻抿'),
    P('平静', ['放空', '发呆'], '表情放松平和，目光自然或有点出神'),
    P('难过', ['伤心', '失落'], '眼神低垂黯淡，嘴角下撇，带着淡淡的忧伤'),
    P('无语', ['无奈', '白眼'], '半眯着眼，嘴角抽动，一脸「真拿你没办法」的无奈'),
    P('紧张', ['慌张'], '额角冒出细汗，眼神慌乱，嘴唇紧抿'),
  ],
  pose: [
    P('站着', ['站立'], '自然地站着，重心落在一条腿上，身体略微侧转'),
    P('坐着', ['坐'], '自然地坐着，身体放松，双手放在膝上或身侧'),
    P('抱膝坐', ['抱膝'], '坐在地上或床上，双臂环抱膝盖，下巴搁在膝头'),
    P('躺着', ['躺', '躺平'], '侧身或仰面躺着，身体舒展放松'),
    P('趴着', ['趴'], '趴在床上或桌上，双手托着下巴，小腿向上翘起'),
    P('伸懒腰', [], '双臂高举过头伸懒腰，身体舒展'),
    P('托腮', ['撑脸'], '一只手托着脸颊，手肘撑在桌面上'),
    P('挥手', ['打招呼'], '抬起一只手朝镜头挥手打招呼'),
    P('回头', ['回眸'], '背对镜头，转过头回眸看向镜头'),
    P('比耶', ['剪刀手'], '一只手在脸旁比出 V 字手势'),
    P('抱着东西', ['抱着'], '双手把东西抱在怀里'),
    P('看书', ['读书'], '低着头专注地看着手里的书'),
    P('喝饮料', ['喝咖啡', '捧着杯子'], '双手捧着杯子，小口喝着热饮'),
    P('奔跑', ['跑'], '向前小跑，头发和衣摆随动作飘起'),
  ],
  shot: [
    P('自拍', ['自拍照'], '手机自拍视角：人物一只手臂伸向镜头举着手机（手机在画面外），轻微俯拍，脸离镜头较近'),
    P('特写', ['大头'], '面部特写，聚焦表情和眼神'),
    P('近景', ['胸像'], '胸口以上的近景，人物占画面大部分'),
    P('半身', [], '腰部以上的半身构图'),
    P('全身', [], '全身入镜，能看清完整的姿势和服装'),
    P('远景', ['大场景'], '人物在画面中较小，突出环境与氛围'),
    P('俯视', ['俯拍'], '从高处向下俯拍的视角'),
    P('仰视', ['仰拍'], '从低处向上仰拍的视角'),
    P('第一人称', ['POV', '主观视角'], '第一人称视角，观看者就在人物面前，人物与镜头有互动'),
  ],
  light: [
    P('午后暖阳', ['午后', '阳光'], '午后温暖的阳光从窗户斜照进来，有柔和的光斑，整体暖色调'),
    P('清晨柔光', ['清晨', '早上'], '清晨柔和的自然光，色调清新明亮'),
    P('黄昏逆光', ['黄昏', '夕阳'], '黄昏的橙色逆光，人物轮廓镶着一圈金边'),
    P('夜晚台灯', ['夜晚', '晚上', '台灯'], '夜晚的室内，只有暖黄的台灯照明，周围偏暗，温馨安静'),
    P('霓虹夜景', ['霓虹', '夜景'], '夜晚街头的霓虹灯光，蓝紫与粉色的光影交错'),
    P('阴雨天', ['阴天', '雨天光'], '阴天或下雨，光线柔和偏冷，氛围安静'),
    P('月光', [], '夜晚冷蓝色的月光，静谧'),
  ],
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、\n]/) : [])
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 12)

function normItem(group, raw) {
  if (!isObj(raw)) return null
  const name = txt(raw.name, 40)
  if (!name) return null
  const item = { name, aliases: list(raw.aliases), prompt: txt(raw.prompt, 600) }
  if (group === 'situation') {
    item.scene = txt(raw.scene, 80)
    item.outfit = txt(raw.outfit, 80)
    item.light = txt(raw.light, 80)
  }
  return item
}

export function normalizePresets(raw) {
  const r = isObj(raw) ? raw : {}
  const out = {}
  for (const g of PRESET_GROUPS) {
    const seen = new Set()
    out[g] = (Array.isArray(r[g]) ? r[g] : DEFAULT_PRESETS[g]).map((x) => normItem(g, x)).filter((x) => {
      if (!x || seen.has(x.name)) return false
      seen.add(x.name)
      return true
    }).slice(0, 80)
  }
  return out
}

let presets = normalizePresets(DEFAULT_PRESETS)

export function getPresets() { return presets }

function write(next) {
  mkdirSync(studioRoot(), { recursive: true })
  const tmp = `${presetsPath()}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, presetsPath())
}

/** 读 presets.json；不存在时写入默认值。坏文件不覆盖，退回默认值继续工作。 */
export function loadPresets() {
  let raw = null
  try { raw = readFileSync(presetsPath(), 'utf8') } catch {
    presets = normalizePresets(DEFAULT_PRESETS)
    try { write(presets) } catch {}
    return presets
  }
  try { presets = normalizePresets(JSON.parse(raw)) } catch { presets = normalizePresets(DEFAULT_PRESETS) }
  return presets
}

export function savePresets(next) {
  presets = normalizePresets(next)
  write(presets)
  return presets
}

export function resetGroup(group) {
  if (!PRESET_GROUPS.includes(group)) throw Object.assign(new Error(`未知的关键词分组：${group}`), { status: 400 })
  return savePresets({ ...presets, [group]: DEFAULT_PRESETS[group] })
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')

/** 按名字 / 别名找关键词；再退一步找唯一的包含匹配。找不到返回 null。 */
export function findPreset(group, ref, p = presets) {
  const key = norm(ref)
  if (!key) return null
  const items = p[group] || []
  const exact = items.find((x) => norm(x.name) === key) || items.find((x) => x.aliases.some((a) => norm(a) === key))
  if (exact) return exact
  const loose = items.filter((x) => [x.name, ...x.aliases].some((n) => { const nn = norm(n); return nn.length >= 2 && (key.includes(nn) || nn.includes(key)) }))
  return loose.length === 1 ? loose[0] : null
}
