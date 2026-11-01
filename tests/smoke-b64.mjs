// 65535 取图方式冒烟测试：提交时要 b64_json，优先用查询结果里的图片数据；没有才下载 result_urls；下载失败时报清楚原因。
// 用法：node tests/smoke-b64.mjs
import assert from 'node:assert/strict'
import http from 'node:http'

import { generateImage } from '../lib/providers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
// 一个肯定连不上的地址：借一个端口再马上关掉（9、1 这类端口会被 fetch 当成禁用端口，测不到真实的连接错误）
const net = await import('node:net')
const freePort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const DEAD = `http://127.0.0.1:${freePort}/out/x.png`

let mode = 'b64'
const seen = { posts: [], downloads: 0 }
const api = http.createServer((req, res) => {
  if (req.url.startsWith('/out/')) { seen.downloads++; res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
  if (req.method === 'POST' && req.url === '/v1/tasks') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.posts.push(JSON.parse(body))
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `img_${mode}`, status: 'pending' }))
    })
    return
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/tasks/')) {
    const id = req.url.split('/').pop()
    const live = `http://127.0.0.1:${api.address().port}/out/${id}.png`
    const doc = { id, status: 'done', model: 'gpt-image-2.5', size: '1024x1024' }
    if (mode === 'b64') Object.assign(doc, { result_urls: [DEAD], result: { data: [{ b64_json: PNG.toString('base64') }] } })
    if (mode === 'url') Object.assign(doc, { result_urls: [live] })
    if (mode === 'dead') Object.assign(doc, { result_urls: [DEAD] })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(doc))
  }
  res.writeHead(404); res.end()
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const cfg = { api: { provider: '65535-tasks', baseUrl: `http://127.0.0.1:${api.address().port}`, apiKey: 'k', model: 'gpt-image-2.5', timeoutSec: 60, resolution: '', quality: '' } }

// 1. 查询结果里带了图片数据：直接用，不去碰（连不上的）result_urls
mode = 'b64'
let r = await generateImage({ cfg, prompt: 'p', refs: [], aspect: '1:1' })
assert.equal(seen.posts.at(-1).input.response_format, 'b64_json', '提交时要带 response_format: b64_json')
assert.equal(r.images.length, 1)
assert.ok(r.images[0].data.equals(PNG))
assert.equal(seen.downloads, 0)

// 2. 没带图片数据（旧任务 / 模型不支持）：照旧下载 result_urls
mode = 'url'
r = await generateImage({ cfg, prompt: 'p', refs: [], aspect: '1:1' })
assert.ok(r.images[0].data.equals(PNG))
assert.equal(seen.downloads, 1)

// 3. 没数据、链接又连不上：报错里写清是哪个地址、什么原因
mode = 'dead'
await assert.rejects(generateImage({ cfg, prompt: 'p', refs: [], aspect: '1:1' }), (e) => {
  assert.equal(e.downloadFailed, true)
  assert.ok(e.message.includes(`127.0.0.1:${freePort}`))
  assert.match(e.message, /连接被拒绝|连接超时|连接中断/)
  assert.match(e.message, /TUN/)
  return true
})

api.close()
console.log('ALL B64 TESTS PASSED')
