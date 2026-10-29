/**
 * dsh-image-studio —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建工具）。
 *
 *   设置 → 生图工作室（slot: settings.section）
 *     素材库：四个库分页、改目录、新建条目、拖拽上传参考图、设封面、写外观描述 / 人设
 *     试生成：挑条目 + 写画面 → 直接出图，调参考图和提示词用
 *     生成记录：最近出的图，超时的任务可以取回
 *     设置：接口（65535 / OpenAI 兼容）、发图策略、组合规则
 *   聊天里的出图卡片（slot: tool.call.toolview，key = image_generate）
 *
 * 与宿主只走同源 fetch（/api/image-studio/*）。桌面版页面是 file:// 加载、fetch 走 IPC 桥，
 * 所以图片一律 fetch → blob URL，不直接写 <img src="/api/...">。
 * 修改后用 `node --check lib/client.js` 验证语法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-studio',
  factory: function (require) {
    var module = { exports: {} }

    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    var API = '/api/image-studio'
    var NS = 'dsh-image-studio'
    var CATS = ['characters', 'outfits', 'scenes', 'props']
    var CAT_LABEL = { characters: '人物', outfits: '服饰', scenes: '场景', props: '道具' }
    var CAT_HINT = {
      characters: '角色的立绘、三视图、表情参考。给每个人物写外观描述和人设。',
      outfits: '服装、配饰的参考图。人物可以设一套默认服饰。',
      scenes: '房间、街道、风景等场景参考。一张图只用一个场景。',
      props: '床、武器、宠物、食物等道具参考。',
    }

    // ---- 小工具 -----------------------------------------------------------

    function cx() {
      var out = []
      for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i])
      return out.join(' ')
    }

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : 'HTTP ' + res.status)
          err.status = res.status
          throw err
        }
        return data
      })
    }
    function apiGet(path) { return fetch(API + path, { cache: 'no-store' }).then(readJson) }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function libSrc(category, id, file, ver) {
      return API + '/file?c=' + encodeURIComponent(category) + '&id=' + encodeURIComponent(id) + '&f=' + encodeURIComponent(file) + (ver ? '&v=' + encodeURIComponent(ver) : '')
    }
    function outSrc(historyId, i) {
      return API + '/file?h=' + encodeURIComponent(historyId) + '&i=' + (i || 0)
    }

    function fileToDataUrl(file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader()
        r.onload = function () { resolve(String(r.result)) }
        r.onerror = function () { reject(r.error || new Error('读取文件失败')) }
        r.readAsDataURL(file)
      })
    }

    function timeLabel(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      var d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      var pad = function (x) { return x < 10 ? '0' + x : String(x) }
      var now = new Date()
      var sameDay = d.toDateString() === now.toDateString()
      return (sameDay ? '今天 ' : (d.getMonth() + 1) + '月' + d.getDate() + '日 ') + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function errText(e) { return e && e.message ? e.message : String(e) }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
      } catch (e) { /* 忽略 */ }
      return Promise.resolve()
    }

    // ---- 图片加载：fetch → blob URL（失败退回 base64 JSON）-------------------

    var imgCache = new Map()
    function loadImage(src) {
      if (imgCache.has(src)) return imgCache.get(src)
      var p = fetch(src, { cache: 'force-cache' }).then(function (res) {
        var type = res.headers.get('content-type') || ''
        if (!res.ok || type.indexOf('image/') !== 0) throw new Error('not image')
        return res.blob()
      }).then(function (blob) {
        return URL.createObjectURL(blob)
      }).catch(function () {
        return fetch(src + (src.indexOf('?') >= 0 ? '&' : '?') + 'b64=1', { cache: 'no-store' }).then(readJson).then(function (j) {
          return 'data:' + j.mime + ';base64,' + j.b64
        })
      })
      p.catch(function () { imgCache.delete(src) })
      imgCache.set(src, p)
      if (imgCache.size > 400) {
        var first = imgCache.keys().next().value
        imgCache.delete(first)
      }
      return p
    }

    function useImageUrl(src) {
      var [state, setState] = useState({ src: '', url: '', failed: false })
      useEffect(function () {
        if (!src) return undefined
        var alive = true
        loadImage(src).then(function (url) {
          if (alive) setState({ src: src, url: url, failed: false })
        }, function () {
          if (alive) setState({ src: src, url: '', failed: true })
        })
        return function () { alive = false }
      }, [src])
      if (state.src !== src) return { url: '', failed: false }
      return state
    }

    function Img(props) {
      var r = useImageUrl(props.src)
      if (r.failed) return h('div', { className: cx('is-img-ph is-img-fail', props.className) }, '图片加载失败')
      if (!r.url) return h('div', { className: cx('is-img-ph is-shimmer', props.className) })
      return h('img', {
        className: props.className,
        src: r.url,
        alt: props.alt || '',
        draggable: false,
        onClick: props.onClick,
        style: props.onClick ? { cursor: 'zoom-in' } : undefined,
      })
    }

    // 大图预览：直接挂在 body 上（避开设置弹层的 transform / overflow）
    function openLightbox(src, caption) {
      loadImage(src).then(function (url) {
        var root = document.createElement('div')
        root.className = 'is-lightbox'
        root.setAttribute('role', 'dialog')
        var img = document.createElement('img')
        img.src = url
        img.alt = caption || ''
        root.appendChild(img)
        if (caption) {
          var cap = document.createElement('div')
          cap.className = 'is-lightbox-cap'
          cap.textContent = caption
          root.appendChild(cap)
        }
        var close = function () {
          document.removeEventListener('keydown', onKey, true)
          if (root.parentNode) root.parentNode.removeChild(root)
        }
        var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close() } }
        root.addEventListener('click', close)
        document.addEventListener('keydown', onKey, true)
        document.body.appendChild(root)
      })
    }

    // ---- 图标（线性 16px）-----------------------------------------------------

    function Icon(props) {
      var paths = ICONS[props.name] || []
      return h('svg', {
        width: props.size || 15, height: props.size || 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: cx('is-icon', props.className), 'aria-hidden': true,
      }, paths.map(function (d, i) { return h('path', { key: i, d: d }) }))
    }
    var ICONS = {
      folder: ['M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z'],
      refresh: ['M20 11a8 8 0 0 0-14.3-4.9L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.3 4.9L20 16', 'M20 20v-4h-4'],
      plus: ['M12 5v14', 'M5 12h14'],
      trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
      star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
      image: ['M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z', 'M4 16l4.5-4.5 3.5 3.5 3-3 5 5', 'M15 9.5h.01'],
      sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
      back: ['M15 5l-7 7 7 7'],
      open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
      search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z', 'M20 20l-4-4'],
      upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
      history: ['M4 12a8 8 0 1 0 2.3-5.6L4 8.7', 'M4 4v4.7h4.7', 'M12 8v4l3 2'],
      gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
      layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
      tag: ['M3.5 12.5V4h8.5l9 9-8.5 8.5z', 'M8 8.5h.01'],
    }

    // ---- 样式：全部走宿主设计令牌（--dsw-alias-*），带中性色回落 ----------------

    var MONO = 'var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)'
    var CSS = [
      '.is-root,.isv-card,.is-lightbox{',
      '--is-fg:var(--dsw-alias-label-primary,#1f1c18);',
      '--is-muted:var(--dsw-alias-label-secondary,#6f6558);',
      '--is-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));',
      '--is-card:var(--dsw-alias-bg-layer-1,#fffdf8);',
      '--is-bar:var(--dsw-alias-bg-layer-2,#f4efe4);',
      '--is-field:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));',
      '--is-line:var(--dsw-alias-border-l2,#e3daca);',
      '--is-line-soft:var(--dsw-alias-border-l1,#ece5d8);',
      '--is-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      '--is-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#3b5bdb));',
      '--is-brand-fg:var(--dsw-alias-label-primary-foreground,#ffffff);',
      '--is-brand-soft:color-mix(in srgb,var(--is-brand) 12%,transparent);',
      '--is-ok:var(--dsw-alias-state-success-primary,#2f6b46);',
      '--is-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);',
      '--is-err:var(--dsw-alias-state-error-primary,#a83a2c);',
      '--is-err-bg:color-mix(in srgb,var(--is-err) 9%,transparent);',
      '--is-err-line:color-mix(in srgb,var(--is-err) 32%,transparent);',
      '--is-shadow:0 1px 2px rgba(0,0,0,.05),0 6px 18px -8px rgba(0,0,0,.18);',
      'font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
      'color:var(--is-fg);}',
      '.is-root{display:flex;flex-direction:column;gap:14px;padding:2px;box-sizing:border-box;max-width:100%;font-size:13px;}',
      '.is-root *,.isv-card *{box-sizing:border-box;}',
      '.is-icon{flex:0 0 auto;display:block;}',
      // 头部
      '.is-head{display:flex;align-items:center;gap:12px;}',
      '.is-logo{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--is-brand-soft);color:var(--is-brand);flex:0 0 auto;}',
      '.is-head-text{flex:1 1 auto;min-width:0;}',
      '.is-h1{font-size:15px;font-weight:650;letter-spacing:.2px;line-height:1.35;}',
      '.is-sub{font-size:12px;color:var(--is-muted);margin-top:2px;line-height:1.5;}',
      '.is-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--is-line-soft);background:var(--is-bar);color:var(--is-muted);white-space:nowrap;}',
      '.is-dot{width:7px;height:7px;border-radius:50%;background:var(--is-faint);flex:0 0 auto;}',
      '.is-dot-ok{background:var(--is-ok);}.is-dot-warn{background:var(--is-warn);}.is-dot-err{background:var(--is-err);}',
      // 主页签
      '.is-tabs{display:flex;gap:2px;padding:3px;border-radius:11px;background:var(--is-bar);border:1px solid var(--is-line-soft);}',
      '.is-tab{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12.5px;padding:7px 8px;border-radius:8px;border:0;background:transparent;color:var(--is-muted);cursor:pointer;white-space:nowrap;transition:background-color .15s,color .15s;}',
      '.is-tab:hover{color:var(--is-fg);}',
      '.is-tab-on{background:var(--is-card);color:var(--is-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08);}',
      '.is-count{font-size:11px;color:var(--is-faint);font-variant-numeric:tabular-nums;}',
      // 分段（库分类、比例）
      '.is-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--is-bar);border:1px solid var(--is-line-soft);flex-wrap:wrap;}',
      '.is-seg-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;border:0;background:transparent;color:var(--is-muted);cursor:pointer;display:inline-flex;align-items:center;gap:5px;}',
      '.is-seg-btn:hover{color:var(--is-fg);}',
      '.is-seg-on{background:var(--is-card);color:var(--is-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.07);}',
      // 按钮
      '.is-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:6px 11px;border-radius:8px;border:1px solid var(--is-line);background:var(--is-card);color:var(--is-fg);cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s,opacity .15s;}',
      '.is-btn:hover:not(:disabled){background:var(--is-hover);}',
      '.is-btn:disabled{opacity:.45;cursor:default;}',
      '.is-btn-primary,.is-btn-primary:hover:not(:disabled){background:var(--is-brand);border-color:var(--is-brand);color:var(--is-brand-fg);font-weight:600;}',
      '.is-btn-primary:hover:not(:disabled){filter:brightness(1.06);}',
      '.is-btn-ghost{border-color:transparent;background:transparent;color:var(--is-muted);}',
      '.is-btn-ghost:hover:not(:disabled){color:var(--is-fg);}',
      '.is-btn-danger{color:var(--is-err);}',
      '.is-btn-sm{font-size:11.5px;padding:4px 8px;border-radius:7px;}',
      '.is-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.is-grow{flex:1 1 auto;min-width:0;}',
      // 目录条
      '.is-dirbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--is-bar);border:1px solid var(--is-line-soft);}',
      '.is-dirbar-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:' + MONO + ';font-size:11.5px;color:var(--is-fg);direction:rtl;text-align:left;}',
      '.is-tag{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--is-card);border:1px solid var(--is-line-soft);color:var(--is-faint);white-space:nowrap;}',
      '.is-tag-brand{background:var(--is-brand-soft);border-color:transparent;color:var(--is-brand);}',
      // 输入
      '.is-input,.is-textarea,.is-select{width:100%;font:inherit;font-size:12.5px;padding:7px 10px;border-radius:8px;border:1px solid var(--is-line);background:var(--is-field);color:var(--is-fg);outline:none;transition:border-color .15s,box-shadow .15s;}',
      '.is-input:focus,.is-textarea:focus,.is-select:focus{border-color:var(--is-brand);box-shadow:0 0 0 3px var(--is-brand-soft);}',
      '.is-textarea{resize:vertical;line-height:1.65;min-height:72px;}',
      '.is-mono{font-family:' + MONO + ';font-size:12px;}',
      '.is-search{position:relative;flex:1 1 180px;min-width:140px;}',
      '.is-search .is-icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--is-faint);}',
      '.is-search .is-input{padding-left:30px;}',
      // 网格卡片
      '.is-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px;}',
      '.is-card{display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--is-line-soft);background:var(--is-card);overflow:hidden;cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,border-color .18s;text-align:left;font:inherit;color:inherit;padding:0;}',
      '.is-card:hover{transform:translateY(-2px);box-shadow:var(--is-shadow);border-color:var(--is-line);}',
      '.is-card-media{position:relative;aspect-ratio:3/4;background:var(--is-bar);overflow:hidden;}',
      '.is-card-media img,.is-card-media .is-img-ph{width:100%;height:100%;object-fit:cover;display:block;}',
      '.is-card-empty{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--is-faint);font-size:11.5px;}',
      '.is-card-badge{position:absolute;top:7px;right:7px;font-size:10.5px;padding:2px 7px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;backdrop-filter:blur(4px);}',
      '.is-card-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px;}',
      '.is-card-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.is-card-meta{font-size:11px;color:var(--is-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.is-card-new{border-style:dashed;align-items:center;justify-content:center;min-height:180px;color:var(--is-muted);gap:8px;background:transparent;}',
      '.is-card-new:hover{color:var(--is-brand);border-color:var(--is-brand);}',
      '.is-plus{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--is-brand-soft);color:var(--is-brand);}',
      // 图片占位
      '.is-img-ph{background:var(--is-bar);}',
      '.is-img-fail{display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--is-faint);}',
      '.is-shimmer{background:linear-gradient(100deg,var(--is-bar) 30%,color-mix(in srgb,var(--is-bar) 55%,var(--is-card)) 50%,var(--is-bar) 70%);background-size:200% 100%;animation:is-shimmer 1.4s linear infinite;}',
      '@keyframes is-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
      // 空状态 / 提示
      '.is-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:28px 16px;border:1px dashed var(--is-line);border-radius:12px;color:var(--is-muted);}',
      '.is-empty-title{font-size:13.5px;font-weight:600;color:var(--is-fg);}',
      '.is-empty-desc{font-size:12px;line-height:1.7;max-width:440px;}',
      '.is-note{font-size:11.5px;color:var(--is-faint);line-height:1.6;}',
      '.is-code{font-family:' + MONO + ';font-size:11px;background:var(--is-bar);border:1px solid var(--is-line-soft);border-radius:5px;padding:1px 5px;}',
      '.is-error{color:var(--is-err);background:var(--is-err-bg);border:1px solid var(--is-err-line);font-size:12.5px;border-radius:10px;padding:10px 12px;line-height:1.6;word-break:break-word;}',
      '.is-toast{position:sticky;bottom:6px;align-self:center;display:flex;align-items:center;gap:8px;font-size:12.5px;padding:8px 13px;border-radius:999px;border:1px solid var(--is-line);background:var(--is-card);box-shadow:var(--is-shadow);z-index:5;}',
      '.is-toast-err{color:var(--is-err);border-color:var(--is-err-line);}',
      // 编辑页
      '.is-detail-head{display:flex;align-items:center;gap:8px;}',
      '.is-detail-title{font-size:14.5px;font-weight:650;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.is-panel{border:1px solid var(--is-line-soft);border-radius:12px;background:var(--is-card);padding:12px 14px;display:flex;flex-direction:column;gap:12px;}',
      '.is-panel-title{font-size:12.5px;font-weight:650;display:flex;align-items:center;gap:7px;}',
      '.is-panel-title .is-note{font-weight:400;}',
      '.is-field{display:flex;flex-direction:column;gap:5px;}',
      '.is-label{font-size:12px;font-weight:600;color:var(--is-fg);display:flex;align-items:baseline;gap:8px;}',
      '.is-label .is-note{font-weight:400;}',
      '.is-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '@media (max-width:640px){.is-2col{grid-template-columns:1fr;}}',
      '.is-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;}',
      '.is-thumb{position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:var(--is-bar);border:1px solid var(--is-line-soft);}',
      '.is-thumb img,.is-thumb .is-img-ph{width:100%;height:100%;object-fit:cover;display:block;}',
      '.is-thumb-cover{outline:2px solid var(--is-brand);outline-offset:-2px;}',
      '.is-thumb-badge{position:absolute;left:6px;top:6px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--is-brand);color:var(--is-brand-fg);}',
      '.is-thumb-tools{position:absolute;right:5px;bottom:5px;display:flex;gap:4px;opacity:0;transition:opacity .15s;}',
      '.is-thumb:hover .is-thumb-tools{opacity:1;}',
      '.is-thumb-tool{width:26px;height:26px;border-radius:7px;border:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;backdrop-filter:blur(4px);}',
      '.is-thumb-tool:hover{background:rgba(0,0,0,.8);}',
      '.is-drop{border:1.5px dashed var(--is-line);border-radius:10px;aspect-ratio:1/1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--is-muted);font-size:11.5px;cursor:pointer;background:transparent;font:inherit;}',
      '.is-drop:hover,.is-drop-on{border-color:var(--is-brand);color:var(--is-brand);background:var(--is-brand-soft);}',
      '.is-dropzone-on{outline:2px dashed var(--is-brand);outline-offset:4px;border-radius:12px;}',
      '.is-savebar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--is-line);background:color-mix(in srgb,var(--is-card) 92%,transparent);backdrop-filter:blur(8px);box-shadow:var(--is-shadow);z-index:4;}',
      '.is-dirty{font-size:12px;color:var(--is-warn);}',
      // 试生成
      '.is-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.is-chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;padding:3px 10px 3px 3px;border-radius:999px;border:1px solid var(--is-line);background:var(--is-card);color:var(--is-fg);cursor:pointer;transition:all .15s;}',
      '.is-chip:hover{border-color:var(--is-brand);}',
      '.is-chip-on{background:var(--is-brand-soft);border-color:var(--is-brand);color:var(--is-brand);font-weight:600;}',
      '.is-chip-av{width:22px;height:22px;border-radius:50%;overflow:hidden;background:var(--is-bar);flex:0 0 auto;}',
      '.is-chip-av img,.is-chip-av .is-img-ph{width:100%;height:100%;object-fit:cover;display:block;}',
      '.is-chip-plain{padding:4px 10px;}',
      '.is-result{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;align-items:start;}',
      '@media (max-width:680px){.is-result{grid-template-columns:1fr;}}',
      '.is-result-img{border-radius:12px;overflow:hidden;border:1px solid var(--is-line-soft);background:var(--is-bar);}',
      '.is-result-img img{width:100%;display:block;}',
      '.is-progress{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;aspect-ratio:3/4;max-height:420px;border-radius:12px;border:1px solid var(--is-line-soft);color:var(--is-muted);font-size:12.5px;}',
      '.is-pre{white-space:pre-wrap;word-break:break-word;font-family:' + MONO + ';font-size:11.5px;line-height:1.65;background:var(--is-bar);border:1px solid var(--is-line-soft);border-radius:10px;padding:10px 12px;max-height:280px;overflow:auto;color:var(--is-muted);}',
      '.is-details summary{cursor:pointer;font-size:12px;color:var(--is-muted);}',
      // 生成记录
      '.is-hgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px;}',
      '.is-hcard{border:1px solid var(--is-line-soft);border-radius:12px;overflow:hidden;background:var(--is-card);display:flex;flex-direction:column;}',
      '.is-hcard-media{aspect-ratio:1/1;background:var(--is-bar);position:relative;overflow:hidden;}',
      '.is-hcard-media img,.is-hcard-media .is-img-ph{width:100%;height:100%;object-fit:cover;display:block;}',
      '.is-hcard-status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px;text-align:center;font-size:11.5px;color:var(--is-muted);line-height:1.5;}',
      '.is-hcard-body{padding:8px 10px 9px;display:flex;flex-direction:column;gap:4px;}',
      '.is-hcard-prompt{font-size:12px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px;}',
      '.is-hcard-foot{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--is-faint);}',
      // 设置
      '.is-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}',
      '@media (max-width:640px){.is-modes{grid-template-columns:1fr;}}',
      '.is-mode{display:flex;flex-direction:column;gap:4px;text-align:left;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--is-line);background:var(--is-card);color:var(--is-fg);cursor:pointer;transition:all .15s;}',
      '.is-mode:hover{border-color:var(--is-brand);}',
      '.is-mode-on{border-color:var(--is-brand);background:var(--is-brand-soft);box-shadow:0 0 0 1px var(--is-brand) inset;}',
      '.is-mode-title{font-size:12.5px;font-weight:650;}',
      '.is-mode-desc{font-size:11.5px;color:var(--is-muted);line-height:1.55;}',
      '.is-toggle{display:flex;align-items:flex-start;gap:9px;cursor:pointer;padding:2px 0;}',
      '.is-toggle input{margin-top:2px;accent-color:var(--is-brand);cursor:pointer;flex:0 0 auto;}',
      '.is-toggle-title{font-size:12.5px;}',
      '.is-toggle-hint{font-size:11.5px;color:var(--is-muted);line-height:1.55;margin-top:2px;}',
      '.is-num{width:84px;}',
      '.is-test-ok{font-size:12px;color:var(--is-ok);line-height:1.6;}',
      // 聊天里的出图卡片
      '.isv-card{margin:6px 0;border:1px solid var(--is-line-soft);border-radius:12px;background:var(--is-card);overflow:hidden;max-width:460px;font-size:12.5px;}',
      '.isv-head{display:flex;align-items:center;gap:7px;padding:7px 11px;color:var(--is-muted);font-size:12px;border-bottom:1px solid var(--is-line-soft);background:var(--is-bar);}',
      '.isv-head b{color:var(--is-fg);font-weight:600;}',
      '.isv-head-sum{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.isv-media{position:relative;background:var(--is-bar);}',
      '.isv-media img{width:100%;display:block;max-height:560px;object-fit:contain;}',
      '.isv-wait{aspect-ratio:3/4;max-height:380px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--is-muted);font-size:12px;}',
      '.isv-foot{padding:8px 11px;display:flex;flex-direction:column;gap:4px;}',
      '.isv-cap{font-size:12.5px;color:var(--is-fg);line-height:1.55;}',
      '.isv-refs{font-size:11px;color:var(--is-faint);line-height:1.5;}',
      '.isv-msg{padding:9px 11px;color:var(--is-muted);font-size:12px;line-height:1.6;}',
      '.isv-err{padding:9px 11px;color:var(--is-err);background:var(--is-err-bg);font-size:12px;line-height:1.6;word-break:break-word;}',
      '.isv-spin{width:22px;height:22px;border-radius:50%;border:2.5px solid color-mix(in srgb,var(--is-brand) 22%,transparent);border-top-color:var(--is-brand);animation:is-spin .9s linear infinite;}',
      '@keyframes is-spin{to{transform:rotate(360deg)}}',
      // 大图
      '.is-lightbox{position:fixed;inset:0;z-index:2147483000;background:rgba(10,10,12,.86);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;cursor:zoom-out;animation:is-fade .15s ease;}',
      '.is-lightbox img{max-width:100%;max-height:calc(100% - 40px);object-fit:contain;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.5);}',
      '.is-lightbox-cap{color:#eee;font-size:13px;max-width:760px;text-align:center;line-height:1.6;}',
      '@keyframes is-fade{from{opacity:0}to{opacity:1}}',
      // 关键词 / 导入
      '.is-kw-list{display:flex;flex-direction:column;gap:8px;}',
      '.is-kw{display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:8px;align-items:start;padding:10px 12px;border:1px solid var(--is-line-soft);border-radius:10px;background:var(--is-card);}',
      '.is-kw-side{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.is-kw-sit{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;}',
      '@media (max-width:640px){.is-kw{grid-template-columns:1fr;}.is-kw-sit{grid-template-columns:1fr;}}',
      '.is-kwpick{display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px;align-items:start;}',
      '.is-kwpick-label{font-size:12px;color:var(--is-muted);padding-top:4px;}',
      '.is-import-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:190px;padding:20px;border:1.5px dashed var(--is-line);border-radius:12px;color:var(--is-muted);cursor:pointer;text-align:center;transition:all .15s;}',
      '.is-import-drop:hover{border-color:var(--is-brand);}',
      '.is-import-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:12px;align-items:start;}',
      '@media (max-width:720px){.is-import-grid{grid-template-columns:1fr;}}',
      '.is-sheet{border-radius:10px;overflow:hidden;border:1px solid var(--is-line-soft);background:#fff;}',
      '.is-sheet img{width:100%;display:block;}',
      '.is-mini-thumbs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.is-mini-thumbs .is-thumb{width:72px;}',
      '.is-sit-table{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;align-items:center;}',
      '.is-sit-name{font-size:12px;color:var(--is-fg);white-space:nowrap;}',
      '.is-ai-job{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--is-muted);padding:6px 10px;border-radius:8px;background:var(--is-bar);}',
      '.is-ai-job .isv-spin{width:14px;height:14px;border-width:2px;}',
      '@supports not (color:color-mix(in srgb,red 10%,blue)){.is-root,.isv-card{--is-brand-soft:rgba(59,91,219,.12);--is-err-bg:rgba(168,58,44,.08);--is-err-line:rgba(168,58,44,.3);}}',
    ].join('')

    // ---- 通用小组件 -------------------------------------------------------------

    function Seg(props) {
      return h('div', { className: 'is-seg', role: 'tablist' }, props.options.map(function (o) {
        var on = o.value === props.value
        return h('button', {
          key: o.value, type: 'button', role: 'tab', 'aria-selected': on,
          className: cx('is-seg-btn', on && 'is-seg-on'),
          onClick: function () { props.onChange(o.value) },
        }, [o.label, o.count !== undefined ? h('span', { key: 'c', className: 'is-count' }, o.count) : null])
      }))
    }

    function Field(props) {
      return h('label', { className: 'is-field' }, [
        h('span', { key: 'l', className: 'is-label' }, [props.label, props.hint ? h('span', { key: 'h', className: 'is-note' }, props.hint) : null]),
        h(React.Fragment, { key: 'c' }, props.children),
      ])
    }

    function Toggle(props) {
      return h('label', { className: 'is-toggle' }, [
        h('input', { key: 'i', type: 'checkbox', checked: !!props.checked, onChange: function (e) { props.onChange(e.target.checked) } }),
        h('span', { key: 't' }, [
          h('div', { key: 'a', className: 'is-toggle-title' }, props.title),
          props.hint ? h('div', { key: 'b', className: 'is-toggle-hint' }, props.hint) : null,
        ]),
      ])
    }

    function imageFilesOf(list) {
      var out = []
      for (var i = 0; i < (list ? list.length : 0); i++) {
        var f = list[i]
        if (f && /^image\/(png|jpe?g|webp|gif)$/i.test(f.type || '')) out.push(f)
      }
      return out
    }

    // ---- 素材库：目录条 ---------------------------------------------------------

    function DirBar(props) {
      var dir = props.dir || { path: '', custom: false }
      var [draft, setDraft] = useState(null)
      var [busy, setBusy] = useState(false)
      var run = function (p) {
        setBusy(true)
        return p.then(function (r) { setBusy(false); return r }, function (e) { setBusy(false); props.toast(errText(e), true); throw e })
      }
      useEffect(function () { setDraft(null) }, [props.category])
      if (draft !== null) {
        return h('div', { className: 'is-panel' }, [
          h('div', { key: 't', className: 'is-panel-title' }, ['「' + CAT_LABEL[props.category] + '」库的目录', h('span', { key: 'n', className: 'is-note' }, '可以指向你已有的素材文件夹；子文件夹 = 一个条目，散图也算一条')]),
          h('div', { key: 'r', className: 'is-row' }, [
            h('input', { key: 'i', className: 'is-input is-mono is-grow', style: { flex: '1 1 260px' }, value: draft, placeholder: '例如 D:\\素材\\' + CAT_LABEL[props.category], onChange: function (e) { setDraft(e.target.value) } }),
            h('button', { key: 'p', type: 'button', className: 'is-btn', disabled: busy, onClick: function () {
              run(apiPost('/pick', { category: props.category })).then(function (r) { if (r && r.picked) setDraft(r.picked) }).catch(function () {})
            } }, [h(Icon, { key: 'i', name: 'folder' }), '选择…']),
          ]),
          h('div', { key: 'a', className: 'is-row' }, [
            h('button', { key: 's', type: 'button', className: 'is-btn is-btn-primary', disabled: busy || draft.trim() === '', onClick: function () {
              run(apiPost('/dir', { category: props.category, path: draft.trim(), create: true })).then(function (lib) { props.onLib(lib); setDraft(null); props.toast('目录已更新') }).catch(function () {})
            } }, '保存目录'),
            dir.custom ? h('button', { key: 'd', type: 'button', className: 'is-btn', disabled: busy, onClick: function () {
              run(apiPost('/dir', { category: props.category, path: '' })).then(function (lib) { props.onLib(lib); setDraft(null); props.toast('已恢复默认目录') }).catch(function () {})
            } }, '恢复默认') : null,
            h('button', { key: 'c', type: 'button', className: 'is-btn is-btn-ghost', onClick: function () { setDraft(null) } }, '取消'),
          ]),
        ])
      }
      return h('div', { className: 'is-dirbar' }, [
        h(Icon, { key: 'i', name: 'folder' }),
        h('span', { key: 'p', className: 'is-dirbar-path', title: dir.path }, '\u200e' + dir.path),
        h('span', { key: 't', className: cx('is-tag', dir.custom && 'is-tag-brand') }, dir.custom ? '自定义' : '默认'),
        h('button', { key: 'e', type: 'button', className: 'is-btn is-btn-sm', onClick: function () { setDraft(dir.custom ? dir.path : '') } }, '更换目录'),
        h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm', title: '在文件管理器里打开', onClick: function () {
          apiPost('/open', { category: props.category }).catch(function (e) { props.toast(errText(e), true) })
        } }, h(Icon, { name: 'open', size: 13 })),
        h('button', { key: 'r', type: 'button', className: 'is-btn is-btn-sm', title: '重新扫描目录', disabled: busy, onClick: function () {
          run(apiPost('/rescan', {})).then(function (lib) { props.onLib(lib); props.toast('已重新扫描') }).catch(function () {})
        } }, h(Icon, { name: 'refresh', size: 13 })),
      ])
    }

    function EntryCard(props) {
      var e = props.entry
      var cover = e.images[0]
      var meta = [e.images.length ? e.images.length + ' 张图' : '还没有图']
      if (e.tags.length) meta.push(e.tags.slice(0, 3).join(' · '))
      return h('button', { type: 'button', className: 'is-card', onClick: props.onClick, title: e.description || e.name }, [
        h('div', { key: 'm', className: 'is-card-media' }, [
          cover
            ? h(Img, { key: 'img', src: libSrc(e.category, e.id, cover.file, cover.mtime), alt: e.name })
            : h('div', { key: 'e', className: 'is-card-empty' }, [h(Icon, { key: 'i', name: 'image', size: 22 }), '点开添加参考图']),
          e.kind === 'file' ? h('span', { key: 'b', className: 'is-card-badge' }, '散图') : null,
        ]),
        h('div', { key: 'b', className: 'is-card-body' }, [
          h('div', { key: 'n', className: 'is-card-name' }, e.name),
          h('div', { key: 'm', className: 'is-card-meta' }, meta.join(' · ')),
        ]),
      ])
    }

    // ---- 素材库：总览 -----------------------------------------------------------

    function LibraryTab(props) {
      var lib = props.lib
      var [cat, setCat] = useState('characters')
      var [query, setQuery] = useState('')
      var [editing, setEditing] = useState(null) // { category, id } | { category, isNew: true }
      var [importing, setImporting] = useState(false)

      if (importing) {
        return h(ImportPanel, {
          category: cat, lib: lib, config: props.config, toast: props.toast, mode: importing,
          onBack: function () { setImporting(false) },
          onDone: function (entry) {
            return props.reloadLib().then(function () { setImporting(false); setCat(entry.category); setEditing({ category: entry.category, id: entry.id }) })
          },
        })
      }
      if (editing) {
        var list = (lib.categories[editing.category] || [])
        var entry = editing.isNew ? null : list.find(function (x) { return x.id === editing.id }) || null
        if (!editing.isNew && entry === null) {
          return h('div', { className: 'is-empty' }, [
            h('div', { key: 't', className: 'is-empty-title' }, '这个条目不见了'),
            h('button', { key: 'b', type: 'button', className: 'is-btn', onClick: function () { setEditing(null) } }, '返回素材库'),
          ])
        }
        return h(EntryEditor, {
          key: editing.isNew ? 'new-' + editing.category : editing.category + '/' + editing.id,
          category: editing.category,
          entry: entry,
          outfits: lib.categories.outfits || [],
          presets: props.presets,
          config: props.config,
          toast: props.toast,
          onBack: function () { setEditing(null) },
          onSaved: function (saved) {
            return props.reloadLib().then(function () { setEditing({ category: saved.category, id: saved.id }) })
          },
          onDeleted: function () {
            return props.reloadLib().then(function () { setEditing(null) })
          },
        })
      }

      var all = lib.categories[cat] || []
      var q = query.trim().toLowerCase()
      var entries = q === '' ? all : all.filter(function (e) {
        return [e.name, e.id].concat(e.aliases, e.tags, [e.description]).some(function (s) { return String(s).toLowerCase().indexOf(q) >= 0 })
      })
      var newEntry = function () { setEditing({ category: cat, isNew: true }) }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'top', className: 'is-row' }, [
          h(Seg, { key: 's', value: cat, onChange: function (v) { setCat(v); setQuery('') }, options: CATS.map(function (c) { return { value: c, label: CAT_LABEL[c], count: (lib.categories[c] || []).length } }) }),
          h('div', { key: 'q', className: 'is-search' }, [
            h(Icon, { key: 'i', name: 'search', size: 14 }),
            h('input', { key: 'in', className: 'is-input', value: query, placeholder: '搜索名字、别名、标签', onChange: function (e) { setQuery(e.target.value) } }),
          ]),
          h('button', { key: 'imp', type: 'button', className: 'is-btn', title: '上传图片，自动识别描述并生成三视图', onClick: function () { setImporting('image') } }, [h(Icon, { key: 'i', name: 'upload', size: 13 }), '从图片导入']),
          h('button', { key: 'txt', type: 'button', className: 'is-btn', title: '写一段描述，扩写成设定并生成三视图', onClick: function () { setImporting('text') } }, [h(Icon, { key: 'i', name: 'sparkle', size: 13 }), '文字生成']),
        ]),
        h(DirBar, { key: 'dir', category: cat, dir: lib.dirs[cat], onLib: props.setLib, toast: props.toast }),
        h('div', { key: 'hint', className: 'is-note' }, CAT_HINT[cat]),
        all.length === 0
          ? h('div', { key: 'empty', className: 'is-empty' }, [
            h('div', { key: 'i', className: 'is-plus' }, h(Icon, { name: 'layers', size: 18 })),
            h('div', { key: 't', className: 'is-empty-title' }, '「' + CAT_LABEL[cat] + '」库还是空的'),
            h('div', { key: 'd', className: 'is-empty-desc' }, '新建一个条目，把几张参考图拖进去；也可以直接往目录里放文件夹或图片（一个子文件夹就是一个条目），再点上面的刷新。'),
            h('div', { key: 'bb', className: 'is-row' }, [
              h('button', { key: 'i', type: 'button', className: 'is-btn is-btn-primary', onClick: function () { setImporting('image') } }, [h(Icon, { key: 'i', name: 'upload' }), '从图片导入']),
              h('button', { key: 't', type: 'button', className: 'is-btn', onClick: function () { setImporting('text') } }, [h(Icon, { key: 'i', name: 'sparkle' }), '文字生成']),
              h('button', { key: 'b', type: 'button', className: 'is-btn', onClick: newEntry }, [h(Icon, { key: 'i', name: 'plus' }), '手动新建']),
            ]),
          ])
          : h('div', { key: 'grid', className: 'is-grid' }, [
            h('button', { key: '__new', type: 'button', className: 'is-card is-card-new', onClick: newEntry }, [
              h('div', { key: 'p', className: 'is-plus' }, h(Icon, { name: 'plus', size: 18 })),
              h('span', { key: 't' }, '新建' + CAT_LABEL[cat]),
            ]),
          ].concat(entries.map(function (e) {
            return h(EntryCard, { key: e.id, entry: e, onClick: function () { setEditing({ category: cat, id: e.id }) } })
          }))),
        q !== '' && entries.length === 0 && all.length > 0 ? h('div', { key: 'nohit', className: 'is-note' }, '没有匹配「' + query + '」的条目') : null,
      ])
    }

    function formOf(entry) {
      return {
        name: entry ? entry.name : '',
        aliases: entry ? entry.aliases.join('，') : '',
        tags: entry ? entry.tags.join('，') : '',
        description: entry ? entry.description : '',
        persona: entry ? entry.persona : '',
        defaultOutfit: entry ? entry.defaultOutfit : '',
        traits: entry ? entry.traits || '' : '',
        situationOutfits: entry && entry.situationOutfits ? Object.assign({}, entry.situationOutfits) : {},
      }
    }

    function uniqJoin(cur, more) {
      var seen = []
      String(cur || '').split(/[,，、]/).concat(more || []).forEach(function (x) { var t = String(x).trim(); if (t && seen.indexOf(t) < 0) seen.push(t) })
      return seen.join('，')
    }

    // ---- 素材库：条目编辑 -------------------------------------------------------

    function EntryEditor(props) {
      var entry = props.entry
      var category = props.category
      var isNew = entry === null
      var [form, setForm] = useState(function () { return formOf(entry) })
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState('')
      var [pending, setPending] = useState([]) // 新建条目时先暂存的图片 [{ file, url }]
      var [dragOn, setDragOn] = useState(false)
      var fileRef = useRef(null)
      var pendingRef = useRef(pending)
      pendingRef.current = pending
      var formRef = useRef(form)
      formRef.current = form
      var [aiJob, setAiJob] = useState(null) // { kind: 'sheet' | 'analyze', stage, elapsedMs }
      var aiPoll = useRef(null)
      useEffect(function () { return function () { if (aiPoll.current) aiPoll.current.stop() } }, [])
      var sheetWord = category === 'scenes' ? '设定图' : '三视图'
      var hasKey = !!(props.config && props.config.api && props.config.api.hasKey)
      var track = function (kind, jobId) {
        var p = pollJob(jobId, function (j) { setAiJob({ kind: kind, stage: j.stage, elapsedMs: j.elapsedMs }) })
        aiPoll.current = p
        return p
      }
      var runSheet = function () {
        if (dirty && !window.confirm('有未保存的修改。' + sheetWord + '生成完会刷新这个页面，未保存的改动会丢失，继续吗？')) return
        setAiJob({ kind: 'sheet', stage: '生成' + sheetWord, elapsedMs: 0 })
        apiPost('/entry/sheet', { category: category, id: entry.id })
          .then(function (r) { return track('sheet', r.jobId) })
          .then(function (j) { setAiJob(null); props.toast(sheetWord + '已加入并设为封面'); return props.onSaved(j.result.entry) })
          .catch(function (e) { setAiJob(null); props.toast(errText(e), true) })
      }
      var runAnalyze = function () {
        setAiJob({ kind: 'analyze', stage: '识别图片', elapsedMs: 0 })
        apiPost('/entry/analyze', { category: category, id: entry.id })
          .then(function (r) { return track('analyze', r.jobId) })
          .then(function (j) {
            setAiJob(null)
            var f = j.result.fields
            var cur = formRef.current
            var next = Object.assign({}, cur)
            if (!cur.name.trim() && f.name) next.name = f.name
            if (f.aliases.length) next.aliases = uniqJoin(cur.aliases, f.aliases)
            if (f.tags.length) next.tags = uniqJoin(cur.tags, f.tags)
            if (f.description && (!cur.description.trim() || window.confirm('识别出了新的外观描述，替换现在的吗？\n\n' + f.description))) next.description = f.description
            setForm(next)
            setDirty(true)
            props.toast('识别结果已填入，看一眼没问题就点保存')
          })
          .catch(function (e) { setAiJob(null); props.toast(errText(e), true) })
      }
      var setSitOutfit = function (name, value) {
        setForm(function (f) {
          var m = Object.assign({}, f.situationOutfits)
          if (value) m[name] = value
          else delete m[name]
          return Object.assign({}, f, { situationOutfits: m })
        })
        setDirty(true)
      }
      var sits = (props.presets && props.presets.situation) || []

      useEffect(function () {
        return function () { pendingRef.current.forEach(function (p) { URL.revokeObjectURL(p.url) }) }
      }, [])

      var set = function (k) {
        return function (e) {
          var v = e && e.target ? e.target.value : e
          setForm(function (f) { var n = Object.assign({}, f); n[k] = v; return n })
          setDirty(true)
        }
      }

      var toPayload = function (files) {
        return Promise.all(files.map(function (f) { return fileToDataUrl(f).then(function (d) { return { name: f.name, data: d } }) }))
      }

      var upload = function (files) {
        if (files.length === 0) { props.toast('只支持 PNG / JPEG / WebP / GIF 图片', true); return Promise.resolve() }
        if (isNew) {
          setPending(function (p) { return p.concat(files.map(function (f) { return { file: f, url: URL.createObjectURL(f) } })) })
          return Promise.resolve()
        }
        setBusy('upload')
        return toPayload(files)
          .then(function (payload) { return apiPost('/upload', { category: category, id: entry.id, files: payload }) })
          .then(function (r) { props.toast('已添加 ' + r.added.length + ' 张图'); setBusy(''); return props.onSaved(r.entry) })
          .catch(function (e) { setBusy(''); props.toast(errText(e), true) })
      }

      var save = function () {
        if (form.name.trim() === '') { props.toast('名字不能为空', true); return }
        setBusy('save')
        var body = Object.assign({ category: category, id: isNew ? '' : entry.id }, form)
        apiPost('/entry', body).then(function (r) {
          if (!isNew || pending.length === 0) return r.entry
          return toPayload(pending.map(function (p) { return p.file }))
            .then(function (payload) { return apiPost('/upload', { category: category, id: r.entry.id, files: payload }) })
            .then(function (u) { return u.entry })
        }).then(function (saved) {
          setDirty(false)
          setBusy('')
          props.toast(isNew ? '已新建「' + saved.name + '」' : '已保存')
          return props.onSaved(saved)
        }).catch(function (e) { setBusy(''); props.toast(errText(e), true) })
      }

      var setCover = function (file) {
        apiPost('/entry', { category: category, id: entry.id, cover: file })
          .then(function (r) { props.toast('已设为封面'); return props.onSaved(r.entry) })
          .catch(function (e) { props.toast(errText(e), true) })
      }
      var delImage = function (file) {
        if (!window.confirm('把这张参考图移到回收站？')) return
        apiPost('/image/delete', { category: category, id: entry.id, file: file })
          .then(function (r) { props.toast('已移到回收站'); return r.entry ? props.onSaved(r.entry) : props.onDeleted() })
          .catch(function (e) { props.toast(errText(e), true) })
      }
      var delEntry = function () {
        if (!window.confirm('把「' + entry.name + '」整个条目移到回收站？（在 image-studio/.trash 里，可以手动找回）')) return
        setBusy('delete')
        apiPost('/entry/delete', { category: category, id: entry.id })
          .then(function () { props.toast('已移到回收站'); return props.onDeleted() })
          .catch(function (e) { props.toast(errText(e), true); setBusy('') })
      }

      var onDrop = function (e) {
        e.preventDefault()
        setDragOn(false)
        upload(imageFilesOf(e.dataTransfer && e.dataTransfer.files))
      }

      var thumbs = isNew
        ? pending.map(function (p, i) {
          return h('div', { key: 'p' + i, className: cx('is-thumb', i === 0 && 'is-thumb-cover') }, [
            h('img', { key: 'i', src: p.url, alt: '' }),
            i === 0 ? h('span', { key: 'b', className: 'is-thumb-badge' }, '封面') : null,
            h('div', { key: 't', className: 'is-thumb-tools' }, h('button', { type: 'button', className: 'is-thumb-tool', title: '移除', onClick: function () {
              URL.revokeObjectURL(p.url)
              setPending(function (list) { return list.filter(function (_, j) { return j !== i }) })
            } }, h(Icon, { name: 'x', size: 13 }))),
          ])
        })
        : entry.images.map(function (img, i) {
          var src = libSrc(category, entry.id, img.file, img.mtime)
          var isCover = i === 0
          return h('div', { key: img.file, className: cx('is-thumb', isCover && 'is-thumb-cover'), title: img.file }, [
            h(Img, { key: 'i', src: src, alt: img.file, onClick: function () { openLightbox(src, entry.name + ' · ' + img.file) } }),
            isCover ? h('span', { key: 'b', className: 'is-thumb-badge' }, '封面') : null,
            h('div', { key: 't', className: 'is-thumb-tools' }, [
              !isCover && entry.kind !== 'file' ? h('button', { key: 'c', type: 'button', className: 'is-thumb-tool', title: '设为封面（会被优先当作参考图）', onClick: function () { setCover(img.file) } }, h(Icon, { name: 'star', size: 13 })) : null,
              h('button', { key: 'd', type: 'button', className: 'is-thumb-tool', title: '移到回收站', onClick: function () { delImage(img.file) } }, h(Icon, { name: 'trash', size: 13 })),
            ]),
          ])
        })

      var outfitOptions = [h('option', { key: '', value: '' }, '（不指定）')].concat(props.outfits.map(function (o) {
        return h('option', { key: o.id, value: o.name }, o.name)
      }))
      var ph = {
        characters: { name: '例如：小鱼', desc: '例如：蓝紫渐变波浪长发、一根呆毛、侧头鲸鳍、蓝色眼睛、身后一条鲸尾' },
        outfits: { name: '例如：女仆装', desc: '例如：深蓝与白色相间的女仆裙，白色鲸鱼图案围裙，蓝色蝴蝶结' },
        scenes: { name: '例如：卧室', desc: '例如：暖色调的小卧室，木地板，靠窗的单人床，墙上挂着星星灯' },
        props: { name: '例如：床', desc: '例如：白色铁艺单人床，浅蓝色被子，鲸鱼抱枕' },
      }[category]

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'head', className: 'is-detail-head' }, [
          h('button', { key: 'b', type: 'button', className: 'is-btn is-btn-ghost', onClick: function () {
            if ((dirty || (isNew && pending.length)) && !window.confirm('有未保存的修改，确定返回？')) return
            props.onBack()
          } }, [h(Icon, { key: 'i', name: 'back' }), CAT_LABEL[category]]),
          h('div', { key: 't', className: 'is-detail-title' }, isNew ? '新建' + CAT_LABEL[category] : entry.name),
          !isNew ? h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm', onClick: function () {
            apiPost('/open', { category: category, id: entry.id }).catch(function (e) { props.toast(errText(e), true) })
          } }, [h(Icon, { key: 'i', name: 'folder', size: 13 }), '打开文件夹']) : null,
          !isNew ? h('button', { key: 'd', type: 'button', className: 'is-btn is-btn-sm is-btn-danger', disabled: !!busy, onClick: delEntry }, [h(Icon, { key: 'i', name: 'trash', size: 13 }), '删除']) : null,
        ]),

        h('div', {
          key: 'imgs',
          className: cx('is-panel', dragOn && 'is-dropzone-on'),
          onDragOver: function (e) { e.preventDefault(); if (!dragOn) setDragOn(true) },
          onDragLeave: function (e) { if (e.currentTarget === e.target) setDragOn(false) },
          onDrop: onDrop,
        }, [
          h('div', { key: 't', className: 'is-panel-title' }, [
            h(Icon, { key: 'i', name: 'image' }), '参考图',
            h('span', { key: 'n', className: 'is-note is-grow' }, '第一张是封面，会被优先发给生图模型。可以直接把图片拖进来。'),
            !isNew && entry.images.length ? h('button', { key: 's', type: 'button', className: 'is-btn is-btn-sm', disabled: !!aiJob || !hasKey, title: hasKey ? '以封面为参考，画一张标准' + sheetWord + '并设为封面' : '先在设置里填生图 API Key', onClick: runSheet }, [h(Icon, { key: 'i', name: 'layers', size: 13 }), '生成' + sheetWord]) : null,
            !isNew && entry.images.length ? h('button', { key: 'a', type: 'button', className: 'is-btn is-btn-sm', disabled: !!aiJob, title: '看图整理名字、标签和外观描述', onClick: runAnalyze }, [h(Icon, { key: 'i', name: 'sparkle', size: 13 }), '识别补全']) : null,
          ]),
          aiJob ? h('div', { key: 'job', className: 'is-ai-job' }, [h('div', { key: 's', className: 'isv-spin' }), (aiJob.stage || '处理中') + ' · ' + Math.round((aiJob.elapsedMs || 0) / 1000) + ' 秒']) : null,
          h('div', { key: 'g', className: 'is-thumbs' }, thumbs.concat([
            h('button', { key: '__add', type: 'button', className: cx('is-drop', dragOn && 'is-drop-on'), disabled: busy === 'upload', onClick: function () { if (fileRef.current) fileRef.current.click() } }, [
              h(Icon, { key: 'i', name: busy === 'upload' ? 'refresh' : 'upload', size: 18 }),
              busy === 'upload' ? '上传中…' : '添加图片',
            ]),
          ])),
          h('input', { key: 'f', ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, style: { display: 'none' }, onChange: function (e) {
            var files = imageFilesOf(e.target.files)
            e.target.value = ''
            upload(files)
          } }),
          entry && entry.kind === 'file' ? h('div', { key: 'n', className: 'is-note' }, '这是一张散图。添加图片或保存信息时，会自动收进同名文件夹。') : null,
        ]),

        h('div', { key: 'form', className: 'is-panel' }, [
          h('div', { key: 'r1', className: 'is-2col' }, [
            h(Field, { key: 'n', label: '名字' }, h('input', { className: 'is-input', value: form.name, onChange: set('name'), placeholder: ph.name })),
            h(Field, { key: 'a', label: '别名', hint: '逗号分隔；模型和自动识别都会认' }, h('input', { className: 'is-input', value: form.aliases, onChange: set('aliases') })),
          ]),
          h(Field, { key: 't', label: '标签', hint: '方便搜索，逗号分隔' }, h('input', { className: 'is-input', value: form.tags, onChange: set('tags') })),
          h(Field, { key: 'd', label: '外观描述', hint: '会写进生图提示词，帮生图模型还原参考图里看不清的细节' }, h('textarea', { className: 'is-textarea', rows: 3, value: form.description, onChange: set('description'), placeholder: ph.desc })),
          category === 'characters' ? h(Field, { key: 'p', label: '人设', hint: '性格、说话方式、背景——给对话模型看的，不会发给生图 API' }, h('textarea', { className: 'is-textarea', rows: 5, value: form.persona, onChange: set('persona') })) : null,
          category === 'characters' ? h(Field, { key: 'tr', label: '神态特点', hint: '会写进生图提示词，例如「开心时尾巴会左右摇摆，害羞时用尾巴挡住脸」' }, h('textarea', { className: 'is-textarea', rows: 2, value: form.traits, onChange: set('traits') })) : null,
          category === 'characters' || category === 'scenes' ? h(Field, { key: 'o', label: '默认服饰', hint: category === 'scenes' ? '人物在这个场景里、又没有情境穿搭时，穿这套' : '没指定服饰、情境和场景也没给搭配时，穿这套' }, h('select', { className: 'is-select', value: form.defaultOutfit, onChange: set('defaultOutfit') }, outfitOptions)) : null,
          category === 'characters' && sits.length ? h('div', { key: 'so', className: 'is-field' }, [
            h('span', { key: 'l', className: 'is-label' }, ['情境穿搭', h('span', { key: 'h', className: 'is-note' }, '这个人物在不同情境下穿什么；不设就用情境自己的默认服饰（在「关键词」里改）')]),
            h('div', { key: 't', className: 'is-sit-table' }, sits.map(function (st) {
              return [
                h('span', { key: 'n' + st.name, className: 'is-sit-name' }, st.name),
                h('select', { key: 's' + st.name, className: 'is-select', value: form.situationOutfits[st.name] || '', onChange: function (e) { setSitOutfit(st.name, e.target.value) } },
                  [h('option', { key: '', value: '' }, '（用情境默认' + (st.outfit ? '：' + st.outfit : '') + '）')].concat(props.outfits.map(function (o) { return h('option', { key: o.id, value: o.name }, o.name) }))),
              ]
            }).reduce(function (a, b) { return a.concat(b) }, [])),
          ]) : null,
        ]),

        h('div', { key: 'save', className: 'is-savebar' }, [
          h('span', { key: 'd', className: dirty || (isNew && pending.length) ? 'is-dirty' : 'is-note' }, isNew ? (form.name.trim() ? '点「创建」保存' + (pending.length ? '，并上传 ' + pending.length + ' 张图' : '') : '先起个名字') : dirty ? '有未保存的修改' : '已保存'),
          h('span', { key: 's', className: 'is-grow' }),
          h('button', { key: 'b', type: 'button', className: 'is-btn is-btn-primary', disabled: !!busy || (!dirty && !isNew) || form.name.trim() === '', onClick: save }, busy === 'save' ? '保存中…' : isNew ? '创建' : '保存'),
        ]),
      ])
    }

    // ---- 试生成 -----------------------------------------------------------------

    function PickChips(props) {
      var list = props.entries || []
      if (list.length === 0) return h('div', { className: 'is-note' }, '库里还没有' + CAT_LABEL[props.category] + '。')
      return h('div', { className: 'is-chips' }, list.map(function (e) {
        var on = props.multi ? props.value.indexOf(e.name) >= 0 : props.value === e.name
        var cover = e.images[0]
        return h('button', {
          key: e.id, type: 'button', className: cx('is-chip', on && 'is-chip-on', !cover && 'is-chip-plain'), title: e.description || e.name,
          onClick: function () {
            if (props.multi) props.onChange(on ? props.value.filter(function (x) { return x !== e.name }) : props.value.concat([e.name]))
            else props.onChange(on ? '' : e.name)
          },
        }, [
          cover ? h('span', { key: 'a', className: 'is-chip-av' }, h(Img, { src: libSrc(e.category, e.id, cover.file, cover.mtime) })) : null,
          h('span', { key: 'n' }, e.name),
        ])
      }))
    }

    function RecordInfo(props) {
      var r = props.record
      if (!r) return null
      var refs = (r.refs || []).map(function (x) { return x.kind === 'extra' ? x.label : CAT_LABEL[x.category] + '「' + x.name + '」' + (x.count > 1 ? '×' + x.count : '') })
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } }, [
        h('div', { key: 'm', className: 'is-row' }, [
          r.model ? h('span', { key: 'a', className: 'is-tag' }, r.model) : null,
          r.size ? h('span', { key: 'b', className: 'is-tag' }, r.size) : null,
          r.aspect ? h('span', { key: 'c', className: 'is-tag' }, r.aspect) : null,
          r.ms ? h('span', { key: 'd', className: 'is-tag' }, Math.round(r.ms / 1000) + ' 秒') : null,
          typeof r.cost === 'number' ? h('span', { key: 'e', className: 'is-tag' }, '$' + r.cost) : null,
        ]),
        refs.length ? h('div', { key: 'r', className: 'is-note' }, '参考：' + refs.join('、')) : h('div', { key: 'r', className: 'is-note' }, '没有用参考图（纯文字生成）'),
        keywordLine(r.keywords) ? h('div', { key: 'k', className: 'is-note' }, '关键词：' + keywordLine(r.keywords)) : null,
        (r.notes || []).length ? h('div', { key: 'n', className: 'is-note' }, r.notes.join('；')) : null,
        (r.unresolved || []).length ? h('div', { key: 'u', className: 'is-note', style: { color: 'var(--is-warn)' } }, '库里没找到：' + r.unresolved.join('、')) : null,
        h('details', { key: 'p', className: 'is-details' }, [
          h('summary', { key: 's' }, '实际发给生图模型的提示词'),
          h('pre', { key: 'pre', className: 'is-pre', style: { marginTop: '8px' } }, r.finalPrompt || ''),
        ]),
        r.id ? h('div', { key: 'id', className: 'is-row' }, [
          h('span', { key: 'i', className: 'is-code' }, r.id),
          h('button', { key: 'c', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', onClick: function () { copyText(r.id).then(function () { props.toast && props.toast('已复制图片编号') }) } }, [h(Icon, { key: 'i', name: 'copy', size: 12 }), '复制编号']),
          r.status === 'done' ? h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', onClick: function () { apiPost('/open', { historyId: r.id }).catch(function () {}) } }, [h(Icon, { key: 'i', name: 'folder', size: 12 }), '打开位置']) : null,
        ]) : null,
      ])
    }

    function CreateTab(props) {
      var lib = props.lib
      var d = props.draft
      var setD = function (patch) { props.setDraft(function (x) { return Object.assign({}, x, patch) }) }
      var job = d.job
      var running = job && job.status === 'running'
      var timer = useRef(null)

      useEffect(function () {
        if (!running) return undefined
        var stop = false
        var tick = function () {
          apiGet('/job?id=' + encodeURIComponent(job.id)).then(function (j) {
            if (stop) return
            setD({ job: j })
            if (j.status === 'running') timer.current = setTimeout(tick, 1500)
            else if (j.status === 'done') props.onGenerated && props.onGenerated()
          }, function (e) {
            if (!stop) setD({ job: Object.assign({}, job, { status: 'failed', error: errText(e) }) })
          })
        }
        timer.current = setTimeout(tick, 1200)
        return function () { stop = true; clearTimeout(timer.current) }
      }, [running, job && job.id])

      var start = function () {
        apiPost('/generate', { prompt: d.prompt, characters: d.characters, outfits: d.outfits, scene: d.scene, props: d.props, aspect: d.aspect, situation: d.situation, expression: d.expression, pose: d.pose, shot: d.shot, light: d.light })
          .then(function (r) { setD({ job: { id: r.jobId, status: 'running', stage: '提交中', elapsedMs: 0 } }) })
          .catch(function (e) { props.toast(errText(e), true) })
      }

      var rec = job && job.record
      var result
      if (running) {
        result = h('div', { className: 'is-progress is-shimmer' }, [
          h('div', { key: 's', className: 'isv-spin' }),
          h('div', { key: 't' }, (job.stage || '生成中') + ' · ' + Math.round((job.elapsedMs || 0) / 1000) + ' 秒'),
          h('button', { key: 'c', type: 'button', className: 'is-btn is-btn-sm', onClick: function () { apiPost('/job/cancel', { id: job.id }) } }, '取消'),
        ])
      } else if (job && job.status === 'done' && rec && rec.files && rec.files.length) {
        var src = outSrc(rec.id, 0)
        result = h('div', { className: 'is-result' }, [
          h('div', { key: 'i', className: 'is-result-img' }, h(Img, { src: src, onClick: function () { openLightbox(src, rec.prompt) } })),
          h(RecordInfo, { key: 'r', record: rec, toast: props.toast }),
        ])
      } else if (job && job.status === 'failed') {
        result = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
          h('div', { key: 'e', className: 'is-error' }, job.error || '生成失败'),
          rec ? h(RecordInfo, { key: 'r', record: rec, toast: props.toast }) : null,
        ])
      }

      var hasKey = props.config && props.config.api.hasKey
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        !hasKey ? h('div', { key: 'k', className: 'is-error' }, '还没填 API Key —— 先到「设置」里填上接口信息。') : null,
        h('div', { key: 'p', className: 'is-panel' }, [
          h(Field, { key: 'f', label: '画面', hint: '写这一张图要画什么：谁在哪里、做什么、构图、光线、画风' }, h('textarea', {
            className: 'is-textarea', rows: 3, value: d.prompt, placeholder: '例如：小鱼在卧室的床上抱着枕头打盹，午后阳光从窗户斜照进来，近景，柔和的日系插画',
            onChange: function (e) { setD({ prompt: e.target.value }) },
          })),
          CATS.map(function (c) {
            var multi = c !== 'scenes'
            var key = c === 'scenes' ? 'scene' : c
            return h(Field, { key: c, label: CAT_LABEL[c], hint: multi ? '可多选' : '单选' }, h(PickChips, {
              category: c, entries: lib.categories[c], multi: multi, value: d[key],
              onChange: function (v) { var patch = {}; patch[key] = v; setD(patch) },
            }))
          }),
          h('div', { key: 'kw', className: 'is-field' }, [
            h('span', { key: 'l', className: 'is-label' }, ['关键词', h('span', { key: 'h', className: 'is-note' }, '单选，不选就只按画面描述；悬停看展开后的描写')]),
            KW_GROUPS.map(function (g) {
              var list = (props.presets && props.presets[g]) || []
              if (!list.length) return null
              return h('div', { key: g, className: 'is-kwpick' }, [
                h('span', { key: 'l', className: 'is-kwpick-label' }, KW_LABEL[g]),
                h('div', { key: 'c', className: 'is-chips' }, list.map(function (x) {
                  var on = d[g] === x.name
                  return h('button', { key: x.name, type: 'button', className: cx('is-chip is-chip-plain', on && 'is-chip-on'), title: g === 'situation' ? [x.prompt, x.scene && '场景：' + x.scene, x.outfit && '服饰：' + x.outfit, x.light && '光线：' + x.light].filter(Boolean).join('\n') : x.prompt, onClick: function () { var p = {}; p[g] = on ? '' : x.name; setD(p) } }, x.name)
                })),
              ])
            }),
          ]),
          h('div', { key: 'a', className: 'is-row' }, [
            h('span', { key: 'l', className: 'is-label' }, '画幅'),
            h(Seg, { key: 's', value: d.aspect, onChange: function (v) { setD({ aspect: v }) }, options: ['1:1', '3:4', '4:3', '9:16', '16:9'].map(function (x) { return { value: x, label: x } }) }),
            h('span', { key: 'g', className: 'is-grow' }),
            h('button', { key: 'b', type: 'button', className: 'is-btn is-btn-primary', disabled: running || !d.prompt.trim() || !hasKey, onClick: start }, [h(Icon, { key: 'i', name: 'sparkle' }), running ? '生成中…' : '生成']),
          ]),
          h('div', { key: 'n', className: 'is-note' }, '画面里提到库里的名字也会被自动认出来。这里出图不受发图策略和冷却限制，适合调参考图和描述。'),
        ]),
        result ? h('div', { key: 'r', className: 'is-panel' }, result) : null,
      ])
    }

    // ---- 生成记录 ---------------------------------------------------------------

    var STATUS_TEXT = { running: '生成中', failed: '失败', pending: '等待取回', cancelled: '已取消', done: '' }

    function HistoryTab(props) {
      var [items, setItems] = useState(null)
      var [busy, setBusy] = useState('')
      var load = useCallback(function () {
        return apiGet('/history?limit=80').then(function (r) { setItems(r.items) }, function (e) { props.toast(errText(e), true); setItems([]) })
      }, [])
      useEffect(function () { load() }, [props.version])
      var anyRunning = (items || []).some(function (x) { return x.status === 'running' })
      useEffect(function () {
        if (!anyRunning) return undefined
        var t = setInterval(load, 5000)
        return function () { clearInterval(t) }
      }, [anyRunning])

      if (items === null) return h('div', { className: 'is-note' }, '加载中…')
      var head = h('div', { key: 'h', className: 'is-row' }, [
        h('span', { key: 'c', className: 'is-note' }, '最近 ' + items.length + ' 条'),
        h('span', { key: 'g', className: 'is-grow' }),
        h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm', onClick: function () { apiPost('/open', { target: 'outputs' }).catch(function (e) { props.toast(errText(e), true) }) } }, [h(Icon, { key: 'i', name: 'folder', size: 13 }), '输出文件夹']),
        h('button', { key: 'r', type: 'button', className: 'is-btn is-btn-sm', onClick: load }, [h(Icon, { key: 'i', name: 'refresh', size: 13 }), '刷新']),
      ])
      if (items.length === 0) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [head, h('div', { key: 'e', className: 'is-empty' }, [
          h('div', { key: 't', className: 'is-empty-title' }, '还没有生成过图片'),
          h('div', { key: 'd', className: 'is-empty-desc' }, '在对话里让模型画一张，或者去「试生成」里试试。'),
        ])])
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [head, h('div', { key: 'g', className: 'is-hgrid' }, items.map(function (it) {
        var done = it.status === 'done' && it.files && it.files.length
        var src = done ? outSrc(it.id, 0) : ''
        var media = done
          ? h(Img, { src: src, alt: it.prompt, onClick: function () { openLightbox(src, it.prompt) } })
          : h('div', { className: cx('is-hcard-status', it.status === 'running' && 'is-shimmer') }, [
            it.status === 'running' ? h('div', { key: 's', className: 'isv-spin' }) : null,
            h('b', { key: 't', style: { color: it.status === 'failed' ? 'var(--is-err)' : 'var(--is-fg)' } }, STATUS_TEXT[it.status] || it.status),
            it.error ? h('div', { key: 'e' }, String(it.error).slice(0, 120)) : null,
            it.status === 'pending' && it.taskId ? h('button', { key: 'r', type: 'button', className: 'is-btn is-btn-sm', disabled: busy === it.id, onClick: function () {
              setBusy(it.id)
              apiPost('/retrieve', { id: it.id }).then(function () { props.toast('已取回') }, function (e) { props.toast(errText(e), true) }).then(function () { setBusy(''); load() })
            } }, busy === it.id ? '取回中…' : '取回结果') : null,
          ])
        return h('div', { key: it.id, className: 'is-hcard' }, [
          h('div', { key: 'm', className: 'is-hcard-media' }, media),
          h('div', { key: 'b', className: 'is-hcard-body' }, [
            h('div', { key: 'p', className: 'is-hcard-prompt', title: it.prompt }, it.prompt),
            h('div', { key: 'f', className: 'is-hcard-foot' }, [
              h('span', { key: 't', className: 'is-grow' }, timeLabel(it.at) + ' · ' + (it.source === 'ui' ? '工作室' : it.source === 'sheet' ? '三视图' : '对话')),
              h('button', { key: 'c', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', title: '复制图片编号（可让模型基于它修改）', onClick: function () { copyText(it.id).then(function () { props.toast('已复制 ' + it.id) }) } }, h(Icon, { name: 'copy', size: 12 })),
              done ? h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', title: '打开位置', onClick: function () { apiPost('/open', { historyId: it.id }).catch(function () {}) } }, h(Icon, { name: 'folder', size: 12 })) : null,
              h('button', { key: 'd', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', title: '删除', onClick: function () {
                if (!window.confirm('删除这条记录？（图片会挪进 .trash）')) return
                apiPost('/history/delete', { id: it.id }).then(load, function (e) { props.toast(errText(e), true) })
              } }, h(Icon, { name: 'trash', size: 12 })),
            ]),
          ]),
        ])
      }))])
    }

    // ---- 设置 -------------------------------------------------------------------

    var MODES = [
      { value: 'manual', title: '只在要求时', desc: '用户说「画一张」「发张图」才出图，其余时候绝不主动发。' },
      { value: 'balanced', title: '适度（推荐）', desc: '要图时发；进入新场景、换装、关键瞬间这类画面感强的时刻也会主动配一张。' },
      { value: 'proactive', title: '积极', desc: '角色扮演和闲聊里场景、动作、服装一有变化就配图，对话更有画面感。' },
    ]

    function clone(v) { return JSON.parse(JSON.stringify(v)) }

    // s = { state, draft, set, num, keyDraft, setKeyDraft, test, busy, runTest, clearKey }
    function apiPanel(s) {
      var api = s.draft.api
      var provider = s.state.providers[api.provider] || { baseUrls: [] }
      var is65535 = api.provider === '65535-tasks'
      var test = s.test
      return h('div', { key: 'api', className: 'is-panel' }, [
        h('div', { key: 't', className: 'is-panel-title' }, [h(Icon, { key: 'i', name: 'gear' }), '生图接口']),
        h(Field, { key: 'p', label: '接口类型' }, h('select', { className: 'is-select', value: api.provider, onChange: function (e) {
          var v = e.target.value
          s.set('api', 'provider', v)
          var list = (s.state.providers[v] || {}).baseUrls || []
          if (list.length && !list.some(function (b) { return b.url === api.baseUrl })) s.set('api', 'baseUrl', list[0].url)
        } }, Object.keys(s.state.providers).map(function (k) { return h('option', { key: k, value: k }, s.state.providers[k].label) }))),
        h(Field, { key: 'b', label: 'Base URL', hint: is65535 ? '本插件走异步任务，大陆优化和国际线路都能用' : '填到域名即可，会自动补 /v1' }, [
          h('input', { key: 'i', className: 'is-input is-mono', value: api.baseUrl, onChange: function (e) { s.set('api', 'baseUrl', e.target.value) }, placeholder: 'https://…' }),
          provider.baseUrls.length ? h('div', { key: 'c', className: 'is-chips', style: { marginTop: '6px' } }, provider.baseUrls.map(function (b) {
            return h('button', { key: b.url, type: 'button', className: cx('is-chip is-chip-plain', api.baseUrl === b.url && 'is-chip-on'), onClick: function () { s.set('api', 'baseUrl', b.url) } }, b.label)
          })) : null,
        ]),
        h(Field, { key: 'k', label: 'API Key', hint: api.hasKey ? '已保存 ' + api.keyHint + '，留空表示不修改' : '只存在本机 image-studio/config.json' }, h('div', { className: 'is-row' }, [
          h('input', { key: 'i', className: 'is-input is-mono is-grow', style: { flex: '1 1 240px' }, type: 'password', autoComplete: 'off', value: s.keyDraft, placeholder: api.hasKey ? '••••••••（不修改）' : 'sk-…', onChange: function (e) { s.setKeyDraft(e.target.value) } }),
          api.hasKey ? h('button', { key: 'c', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', onClick: s.clearKey }, '清除') : null,
        ])),
        h('div', { key: 'm', className: 'is-2col' }, [
          h(Field, { key: 'm', label: '模型', hint: is65535 ? '如 gpt-image-2 / gpt-image-2.5 / gemini-3-pro-image' : '' }, [
            h('input', { key: 'i', className: 'is-input is-mono', list: 'is-models', value: api.model, onChange: function (e) { s.set('api', 'model', e.target.value) } }),
            h('datalist', { key: 'd', id: 'is-models' }, ((test && test.models) || []).map(function (m) { return h('option', { key: m, value: m }) })),
          ]),
          h(Field, { key: 'q', label: '质量（quality）', hint: '留空用默认；-eco 系列强依赖它' }, h('input', { className: 'is-input is-mono', value: api.quality, placeholder: 'low / medium / high …', onChange: function (e) { s.set('api', 'quality', e.target.value) } })),
        ]),
        h('div', { key: 'r', className: 'is-row', style: { gap: '18px', alignItems: 'flex-end' } }, [
          is65535 ? h('div', { key: 'res', className: 'is-field' }, [
            h('span', { key: 'l', className: 'is-label' }, '清晰度'),
            h(Seg, { key: 's', value: api.resolution, onChange: function (v) { s.set('api', 'resolution', v) }, options: [{ value: '', label: '默认' }, { value: '1k', label: '1K' }, { value: '2k', label: '2K' }, { value: '4k', label: '4K' }] }),
          ]) : null,
          h('div', { key: 'asp', className: 'is-field' }, [
            h('span', { key: 'l', className: 'is-label' }, '默认画幅'),
            h(Seg, { key: 's', value: api.defaultAspect, onChange: function (v) { s.set('api', 'defaultAspect', v) }, options: s.state.options.aspects.map(function (x) { return { value: x, label: x } }) }),
          ]),
          h('div', { key: 't', className: 'is-field' }, [h('span', { key: 'l', className: 'is-label' }, '超时（秒）'), s.num('api', 'timeoutSec', 30, 1800)]),
        ]),
        h('div', { key: 'x', className: 'is-row' }, [
          h('button', { key: 'b', type: 'button', className: 'is-btn', disabled: !!s.busy, onClick: s.runTest }, s.busy === 'test' ? '测试中…' : '测试连接'),
          test && test.error ? h('span', { key: 'e', className: 'is-note', style: { color: 'var(--is-err)' } }, test.error) : null,
          test && test.models ? h('span', { key: 'o', className: 'is-test-ok' }, '连接正常' + (test.models.length ? '，可用生图模型：' + test.models.slice(0, 12).join('、') + (test.models.length > 12 ? ' …' : '') : '（没列出生图模型，检查 Key 的分组）')) : null,
        ]),
        is65535 ? h('div', { key: 'n', className: 'is-note' }, '65535 只有成功出图才扣费；生图建议用「任务专用分组」的 Key。平台禁止 NSFW 内容，审核拒绝过多会额外扣费。') : null,
      ])
    }

    function visionPanel(s) {
      var v = s.draft.vision
      var vm = s.visionModels
      return h('div', { key: 'vis', className: 'is-panel' }, [
        h('div', { key: 't', className: 'is-panel-title' }, [h(Icon, { key: 'i', name: 'image' }), '识图', h('span', { key: 'n', className: 'is-note' }, '「从图片导入」「识别补全」用它把图片整理成名字、标签和描述')]),
        h(Seg, { key: 's', value: v.source, onChange: function (x) { s.set('vision', 'source', x) }, options: [{ value: 'dsh', label: 'DSH 自带模型（推荐）' }, { value: 'openai', label: 'OpenAI 兼容接口' }] }),
        v.source === 'dsh'
          ? h(Field, { key: 'm', label: '看图模型', hint: '用 DSH 里已经配好的模型，不用另填 Key' }, [
            h('input', { key: 's', className: 'is-input is-mono', list: 'is-dl-vision', value: v.dshModel, placeholder: '留空 = 自动（第一个支持图片的模型）', onChange: function (e) { s.set('vision', 'dshModel', e.target.value) } }),
            h('datalist', { key: 'dl', id: 'is-dl-vision' }, ((vm && vm.models) || []).map(function (m) { return h('option', { key: m.route, value: m.route }, m.name) })),
            vm && vm.models.length ? h('div', { key: 'f', className: 'is-note', style: { marginTop: '6px' } }, '检测到：' + vm.models.map(function (m) { return m.route }).join('、')) : null,
            vm && !vm.models.length ? h('div', { key: 'w', className: 'is-note', style: { color: 'var(--is-warn)', marginTop: '6px' } }, vm.error ? '读取模型列表失败：' + vm.error : '没检测到支持图片输入的模型。可以手填，如 deepseek-official/deepseek-flash；或者换成 OpenAI 兼容接口。') : null,
          ])
          : h('div', { key: 'o', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
            h(Field, { key: 'b', label: 'Base URL' }, [
              h('input', { key: 'i', className: 'is-input is-mono', value: v.baseUrl, onChange: function (e) { s.set('vision', 'baseUrl', e.target.value) } }),
              h('div', { key: 'c', className: 'is-chips', style: { marginTop: '6px' } }, [
                h('button', { key: 'a', type: 'button', className: cx('is-chip is-chip-plain', v.baseUrl === 'https://api2-cn.65535.space' && 'is-chip-on'), onClick: function () { s.set('vision', 'baseUrl', 'https://api2-cn.65535.space') } }, '65535 对话 · 大陆优化'),
                h('button', { key: 'b', type: 'button', className: cx('is-chip is-chip-plain', v.baseUrl === 'https://api2.65535.space' && 'is-chip-on'), onClick: function () { s.set('vision', 'baseUrl', 'https://api2.65535.space') } }, '65535 对话 · 国际'),
              ]),
            ]),
            h('div', { key: 'r', className: 'is-2col' }, [
              h(Field, { key: 'k', label: 'API Key', hint: v.hasKey ? '已保存 ' + v.keyHint + '，留空不修改' : '留空则用生图的 Key（对话分组的 Key 可能不同）' }, h('input', { className: 'is-input is-mono', type: 'password', autoComplete: 'off', value: s.visionKeyDraft, placeholder: v.hasKey ? '••••••••（不修改）' : '（可留空）', onChange: function (e) { s.setVisionKeyDraft(e.target.value) } })),
              h(Field, { key: 'm', label: '模型', hint: '要支持看图' }, h('input', { className: 'is-input is-mono', value: v.model, placeholder: '如 gpt-5.6 / gemini-3-pro', onChange: function (e) { s.set('vision', 'model', e.target.value) } })),
            ]),
          ]),
      ])
    }

    function policyPanel(s) {
      var d = s.draft
      return h('div', { key: 'pol', className: 'is-panel' }, [
        h('div', { key: 't', className: 'is-panel-title' }, [h(Icon, { key: 'i', name: 'sparkle' }), '什么时候发图', h('span', { key: 'n', className: 'is-note' }, '写进模型的系统提示，由模型自己判断')]),
        h('div', { key: 'm', className: 'is-modes' }, MODES.map(function (m) {
          return h('button', { key: m.value, type: 'button', className: cx('is-mode', d.policy.mode === m.value && 'is-mode-on'), onClick: function () { s.set('policy', 'mode', m.value) } }, [
            h('span', { key: 't', className: 'is-mode-title' }, m.title),
            h('span', { key: 'd', className: 'is-mode-desc' }, m.desc),
          ])
        })),
        h('div', { key: 'c', className: 'is-row' }, [h('span', { key: 'l', className: 'is-label' }, '两次主动发图至少间隔'), s.num('policy', 'cooldownMin', 0, 240), h('span', { key: 'u', className: 'is-note' }, '分钟（0 = 不限；用户明确要图时不受限）')]),
        h(Field, { key: 'r', label: '补充规则', hint: '自由发挥，模型会照着执行' }, h('textarea', { className: 'is-textarea', rows: 3, value: d.policy.rules, onChange: function (e) { s.set('policy', 'rules', e.target.value) }, placeholder: '例如：只在角色扮演会话里发图；早安晚安时配一张；默认竖图 3:4；不画血腥场面' })),
      ])
    }

    function composePanel(s) {
      var d = s.draft
      return h('div', { key: 'cmp', className: 'is-panel' }, [
        h('div', { key: 't', className: 'is-panel-title' }, [h(Icon, { key: 'i', name: 'layers' }), '参考图组合']),
        h('div', { key: 'n', className: 'is-row', style: { gap: '18px' } }, [
          h('div', { key: 'a', className: 'is-field' }, [h('span', { key: 'l', className: 'is-label' }, '每张图最多带几张参考'), s.num('compose', 'maxRefs', 1, 16)]),
          h('div', { key: 'b', className: 'is-field' }, [h('span', { key: 'l', className: 'is-label' }, '每个人物几张'), s.num('compose', 'refsPerCharacter', 1, 6)]),
          h('div', { key: 'c', className: 'is-field' }, [h('span', { key: 'l', className: 'is-label' }, '其他条目每个几张'), s.num('compose', 'refsPerOther', 1, 4)]),
        ]),
        h(Toggle, { key: 'io', checked: d.compose.identityOnly !== false, onChange: function (v) { s.set('compose', 'identityOnly', v) }, title: '参考图只用来还原长相和服装设计（推荐）', hint: '姿势、表情、视角、构图都按文字和关键词重新画，避免每张图都照抄参考图。关掉则要求严格贴近参考图。' }),
        h(Toggle, { key: 'am', checked: d.compose.autoMatch, onChange: function (v) { s.set('compose', 'autoMatch', v) }, title: '从画面描述里自动认出库里的名字', hint: '模型写「小鱼在卧室的床上」时，即使没显式指定，也会带上「小鱼」「卧室」「床」的参考图。' }),
        h(Toggle, { key: 'do', checked: d.compose.useDefaultOutfit, onChange: function (v) { s.set('compose', 'useDefaultOutfit', v) }, title: '人物没指定服饰时，用其默认服饰' }),
        h(Toggle, { key: 'fs', checked: d.compose.followSchedule !== false, onChange: function (v) { s.set('compose', 'followSchedule', v) }, title: '跟着「全天日程」穿衣服', hint: '装了大肥鱼全天日程插件时，没指定服饰就沿用她此刻日程里的那套（比如下午出门穿的 JK 短裙），同一天出的图衣服对得上；指定了场景且和日程此刻不同，就不跟。' }),
        h(Toggle, { key: 'ci', checked: d.compose.catalogInPrompt, onChange: function (v) { s.set('compose', 'catalogInPrompt', v) }, title: '把参考库目录写进模型的系统提示', hint: '模型直接知道库里有什么；库很大时可以关掉，让模型用 image_library 自己查。' }),
        h(Field, { key: 'sp', label: '统一风格', hint: '每次生图都会加在提示词最前面' }, h('textarea', { className: 'is-textarea', rows: 2, value: d.compose.stylePrompt, onChange: function (e) { s.set('compose', 'stylePrompt', e.target.value) }, placeholder: '例如：日系二次元插画，干净线稿，柔和赛璐璐上色，高细节' })),
      ])
    }

    function etcPanel(s) {
      var d = s.draft
      return h('div', { key: 'etc', className: 'is-panel' }, [
        h(Toggle, { key: 'en', checked: d.enabled, onChange: function (v) { s.set(null, 'enabled', v) }, title: '启用生图', hint: '关掉后模型不会再收到生图说明，调用工具也会被拒绝。' }),
        h(Toggle, { key: 'sm', checked: d.output.showToModel, onChange: function (v) { s.set('output', 'showToModel', v) }, title: '让对话模型也看到生成的图', hint: '模型能看图时可以自己评价、决定要不要重画；模型不支持看图时别开，会多花 token。' }),
        h('div', { key: 'd', className: 'is-row' }, [
          h('span', { key: 'l', className: 'is-note' }, '数据目录'),
          h('span', { key: 'p', className: 'is-code' }, s.state.root),
          h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', title: '打开', onClick: function () { apiPost('/open', { target: 'root' }).catch(function (e) { s.toast(errText(e), true) }) } }, h(Icon, { name: 'open', size: 12 })),
        ]),
      ])
    }

    function SettingsTab(props) {
      var state = props.state
      var [draft, setDraft] = useState(function () { return clone(state.config) })
      var [keyDraft, setKeyDraft] = useState('')
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState('')
      var [test, setTest] = useState(null)
      var [visionKeyDraft, setVisionKeyDraft] = useState('')
      var [visionModels, setVisionModels] = useState(null)
      useEffect(function () {
        apiGet('/vision/models').then(setVisionModels, function (e) { setVisionModels({ models: [], error: errText(e) }) })
      }, [])

      var set = function (section, k, v) {
        setDraft(function (d) {
          var n = clone(d)
          if (section) n[section][k] = v
          else n[k] = v
          return n
        })
        setDirty(true)
      }
      var num = function (section, k, min, max) {
        return h('input', { key: section + k, className: 'is-input is-num', type: 'number', min: min, max: max, value: draft[section][k], onChange: function (e) { set(section, k, e.target.value === '' ? '' : Number(e.target.value)) } })
      }
      var save = function () {
        setBusy('save')
        var a = Object.assign({}, draft.api, { apiKey: keyDraft.trim() })
        delete a.hasKey
        delete a.keyHint
        var vi = Object.assign({}, draft.vision, { apiKey: visionKeyDraft.trim() })
        delete vi.hasKey
        delete vi.keyHint
        return apiPost('/config', { enabled: draft.enabled, api: a, policy: draft.policy, compose: draft.compose, output: draft.output, vision: vi }).then(function (s) {
          props.onState(s)
          setDraft(clone(s.config))
          setKeyDraft('')
          setVisionKeyDraft('')
          setDirty(false)
          setBusy('')
          props.toast('设置已保存')
          return s
        }, function (e) { setBusy(''); props.toast(errText(e), true); throw e })
      }
      var runTest = function () {
        var go = function () {
          setBusy('test')
          setTest(null)
          return apiPost('/test', {}).then(function (r) { setTest(r) }, function (e) { setTest({ error: errText(e) }) }).then(function () { setBusy('') })
        }
        if (dirty || keyDraft.trim()) save().then(go, function () {})
        else go()
      }
      var clearKey = function () {
        if (!window.confirm('清除已保存的 API Key？')) return
        apiPost('/config', { clearKey: true, api: {} }).then(function (s) { props.onState(s); setDraft(clone(s.config)); props.toast('已清除 API Key') }, function (e) { props.toast(errText(e), true) })
      }
      var s = { state: state, draft: draft, set: set, num: num, keyDraft: keyDraft, setKeyDraft: setKeyDraft, test: test, busy: busy, runTest: runTest, clearKey: clearKey, toast: props.toast, visionKeyDraft: visionKeyDraft, setVisionKeyDraft: setVisionKeyDraft, visionModels: visionModels }
      var changed = dirty || keyDraft.trim() !== '' || visionKeyDraft.trim() !== ''

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        apiPanel(s),
        visionPanel(s),
        policyPanel(s),
        composePanel(s),
        etcPanel(s),
        h('div', { key: 'save', className: 'is-savebar' }, [
          h('span', { key: 'd', className: changed ? 'is-dirty' : 'is-note' }, changed ? '有未保存的修改' : '设置已是最新'),
          h('span', { key: 'g', className: 'is-grow' }),
          dirty ? h('button', { key: 'r', type: 'button', className: 'is-btn is-btn-ghost', onClick: function () { setDraft(clone(state.config)); setKeyDraft(''); setVisionKeyDraft(''); setDirty(false) } }, '撤销') : null,
          h('button', { key: 's', type: 'button', className: 'is-btn is-btn-primary', disabled: !!busy || !changed, onClick: function () { save().catch(function () {}) } }, busy === 'save' ? '保存中…' : '保存设置'),
        ]),
      ])
    }

    // ---- 后台任务轮询 -----------------------------------------------------------

    function pollJob(jobId, onUpdate) {
      var stopped = false
      var p = new Promise(function (resolve, reject) {
        var tick = function () {
          if (stopped) return
          apiGet('/job?id=' + encodeURIComponent(jobId)).then(function (j) {
            if (stopped) return
            if (onUpdate) onUpdate(j)
            if (j.status === 'running') setTimeout(tick, 1500)
            else if (j.status === 'done') resolve(j)
            else reject(new Error(j.error || '任务失败'))
          }, function (e) { if (!stopped) reject(e) })
        }
        setTimeout(tick, 1000)
      })
      p.stop = function () { stopped = true }
      return p
    }

    var KW_LABEL = { situation: '情境', expression: '神态', pose: '动作', shot: '镜头', light: '光线' }
    var KW_GROUPS = ['situation', 'expression', 'pose', 'shot', 'light']
    var KW_HINT = {
      situation: '角色「在哪、在干什么」。选中后会自动带上这里设的场景、服饰和光线；人物可以在自己的编辑页里给每个情境单独指定穿搭。',
      expression: '角色的心情 / 神态。模型按对话里的情绪挑一个，插件把它展开成具体的表情描写。',
      pose: '身体动作和姿势。',
      shot: '镜头：景别、角度、自拍等取景方式。',
      light: '光线与氛围。不填时用情境的默认光线。',
    }

    function keywordLine(k) {
      if (!k || typeof k !== 'object') return ''
      return KW_GROUPS.filter(function (g) { return k[g] }).map(function (g) { return KW_LABEL[g] + '「' + k[g] + '」' }).join(' · ')
    }

    function KwItem(props) {
      var it = props.item
      var set = function (k) { return function (e) { props.onChange(Object.assign({}, it, (function () { var o = {}; o[k] = e.target.value; return o })())) } }
      var sit = props.group === 'situation'
      return h('div', { className: 'is-kw' }, [
        h('div', { key: 'a', className: 'is-kw-side' }, [
          h('input', { key: 'n', className: 'is-input', value: it.name, placeholder: '名字', onChange: set('name') }),
          h('input', { key: 'al', className: 'is-input', value: Array.isArray(it.aliases) ? it.aliases.join('，') : it.aliases, placeholder: '别名，逗号分隔', onChange: function (e) { props.onChange(Object.assign({}, it, { aliases: e.target.value })) } }),
        ]),
        h('div', { key: 'b', className: 'is-kw-side' }, [
          h('textarea', { key: 'p', className: 'is-textarea', rows: sit ? 2 : 2, style: { minHeight: '58px' }, value: it.prompt, placeholder: sit ? '情境氛围描写（可选）' : '展开后的具体描写，会写进生图提示词', onChange: set('prompt') }),
          sit ? h('div', { key: 's', className: 'is-kw-sit' }, [
            h('input', { key: 'sc', className: 'is-input', list: 'is-dl-scenes', value: it.scene || '', placeholder: '场景（库里的名字）', onChange: set('scene') }),
            h('input', { key: 'ou', className: 'is-input', list: 'is-dl-outfits', value: it.outfit || '', placeholder: '默认服饰', onChange: set('outfit') }),
            h('input', { key: 'li', className: 'is-input', list: 'is-dl-lights', value: it.light || '', placeholder: '光线关键词', onChange: set('light') }),
          ]) : null,
        ]),
        h('button', { key: 'd', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', title: '删除', onClick: props.onDelete }, h(Icon, { name: 'trash', size: 13 })),
      ])
    }

    function KeywordsTab(props) {
      var [group, setGroup] = useState('situation')
      var [draft, setDraft] = useState(function () { return JSON.parse(JSON.stringify(props.presets)) })
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState(false)
      var items = draft[group] || []
      var lib = props.lib
      var update = function (list) {
        setDraft(function (d) { var n = Object.assign({}, d); n[group] = list; return n })
        setDirty(true)
      }
      var save = function () {
        setBusy(true)
        apiPost('/presets', { presets: draft }).then(function (r) {
          props.onPresets(r.presets)
          setDraft(JSON.parse(JSON.stringify(r.presets)))
          setDirty(false)
          props.toast('关键词已保存，下一轮对话生效')
        }, function (e) { props.toast(errText(e), true) }).then(function () { setBusy(false) })
      }
      var reset = function () {
        if (!window.confirm('把「' + KW_LABEL[group] + '」恢复成默认关键词？这一组的自定义会丢失。')) return
        apiPost('/presets/reset', { group: group }).then(function (r) {
          props.onPresets(r.presets)
          setDraft(JSON.parse(JSON.stringify(r.presets)))
          setDirty(false)
          props.toast('已恢复默认')
        }, function (e) { props.toast(errText(e), true) })
      }
      var names = function (c) { return (lib.categories[c] || []).map(function (e) { return h('option', { key: e.id, value: e.name }) }) }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 't', className: 'is-row' }, [
          h(Seg, { key: 's', value: group, onChange: setGroup, options: KW_GROUPS.map(function (g) { return { value: g, label: KW_LABEL[g], count: (draft[g] || []).length } }) }),
          h('span', { key: 'g', className: 'is-grow' }),
          h('button', { key: 'r', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', onClick: reset }, '恢复默认'),
        ]),
        h('div', { key: 'h', className: 'is-note' }, KW_HINT[group] + ' 模型调用时只填名字或别名。'),
        h('datalist', { key: 'dl1', id: 'is-dl-scenes' }, names('scenes')),
        h('datalist', { key: 'dl2', id: 'is-dl-outfits' }, names('outfits')),
        h('datalist', { key: 'dl3', id: 'is-dl-lights' }, (draft.light || []).map(function (x) { return h('option', { key: x.name, value: x.name }) })),
        h('div', { key: 'l', className: 'is-kw-list' }, items.map(function (it, i) {
          return h(KwItem, {
            key: group + i, group: group, item: it,
            onChange: function (next) { update(items.map(function (x, j) { return j === i ? next : x })) },
            onDelete: function () { update(items.filter(function (_, j) { return j !== i })) },
          })
        }).concat([
          h('button', { key: '__add', type: 'button', className: 'is-btn', style: { alignSelf: 'flex-start' }, onClick: function () {
            update(items.concat([group === 'situation' ? { name: '', aliases: [], prompt: '', scene: '', outfit: '', light: '' } : { name: '', aliases: [], prompt: '' }]))
          } }, [h(Icon, { key: 'i', name: 'plus', size: 13 }), '添加' + KW_LABEL[group]]),
        ])),
        h('div', { key: 'save', className: 'is-savebar' }, [
          h('span', { key: 'd', className: dirty ? 'is-dirty' : 'is-note' }, dirty ? '有未保存的修改' : '关键词已是最新'),
          h('span', { key: 'g', className: 'is-grow' }),
          dirty ? h('button', { key: 'u', type: 'button', className: 'is-btn is-btn-ghost', onClick: function () { setDraft(JSON.parse(JSON.stringify(props.presets))); setDirty(false) } }, '撤销') : null,
          h('button', { key: 's', type: 'button', className: 'is-btn is-btn-primary', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存关键词'),
        ]),
      ])
    }

    // ---- 从图片导入（识图 + 三视图）----------------------------------------------

    var SHEET_NAME = { characters: '角色三视图', outfits: '服装三视图', props: '道具三视图', scenes: '场景设定图' }
    var IMPORT_TIP = {
      characters: '上传角色图（立绘、截图都行）。会识别外貌写好描述，再画一张正 / 侧 / 背的标准三视图——中性站姿和表情，拿它当参考，生图就不会总照抄某个姿势。',
      outfits: '在网上看到好看的衣服就把图丢进来。会只提取服装本身（忽略模特），画成穿在素体人台上的正 / 侧 / 背三视图。',
      scenes: '上传场景图。会去掉人物，画一张「主视角 + 反向视角 + 俯视布局」的场景设定图。',
      props: '上传物品图。会去掉手和背景，画成正 / 侧 / 背 + 斜侧的道具三视图。',
    }

    var TEXT_TIP = {
      characters: '写下角色设定（外貌、种族特征、气质、风格），会先扩写成详细设定，再画一张正 / 侧 / 背的标准三视图。',
      outfits: '描述一套衣服，会扩写出款式、面料、配色等细节，再画成穿在素体人台上的三视图。',
      scenes: '描述一个空间，会扩写出布局和陈设，再画一张「主视角 + 反向视角 + 俯视布局」的场景设定图。',
      props: '描述一个物品，会扩写细节，再画成正 / 侧 / 背 + 斜侧的道具三视图。',
    }
    var TEXT_PH = {
      characters: '例如：银白短发的狼耳少女，金色竖瞳，左耳戴一枚红色耳环，身形娇小，平时穿黑色连帽卫衣和工装短裤',
      outfits: '例如：黑色长款风衣，双排扣，腰间系同色腰带，里面搭白色高领毛衣，配短靴',
      scenes: '例如：海边的小咖啡馆，木质吧台，大落地窗外是傍晚的海，墙上挂着贝壳装饰',
      props: '例如：一只鲸鱼造型的蓝色马克杯，杯柄是鲸鱼尾巴',
    }

    function srcOf(importId, file) { return API + '/file?s=' + encodeURIComponent(importId) + '&f=' + encodeURIComponent(file) }

    function ImportPanel(props) {
      var [cat, setCat] = useState(props.category)
      var [step, setStep] = useState('pick')
      var [files, setFiles] = useState([])
      var [hint, setHint] = useState('')
      var [doAnalyze, setDoAnalyze] = useState(true)
      var [doSheet, setDoSheet] = useState(true)
      var [job, setJob] = useState(null)
      var [result, setResult] = useState(null)
      var [form, setForm] = useState({ name: '', aliases: '', tags: '', description: '' })
      var [useSheet, setUseSheet] = useState(true)
      var [useOriginals, setUseOriginals] = useState(true)
      var [target, setTarget] = useState('')
      var [regenHint, setRegenHint] = useState('')
      var [busy, setBusy] = useState('')
      var [dragOn, setDragOn] = useState(false)
      var [mode, setMode] = useState(props.mode === 'text' ? 'text' : 'image')
      var [text, setText] = useState('')
      var [nameDraft, setNameDraft] = useState('')
      var textMode = mode === 'text'
      var fileRef = useRef(null)
      var pollRef = useRef(null)
      var state = useRef({ files: files, importId: '', committed: false })
      state.current.files = files

      useEffect(function () {
        return function () {
          if (pollRef.current) pollRef.current.stop()
          state.current.files.forEach(function (f) { URL.revokeObjectURL(f.url) })
          if (state.current.importId && !state.current.committed) apiPost('/import/discard', { importId: state.current.importId }).catch(function () {})
        }
      }, [])

      var addFiles = function (list) {
        var imgs = imageFilesOf(list)
        if (!imgs.length) { props.toast('只支持 PNG / JPEG / WebP / GIF 图片', true); return }
        setFiles(function (cur) { return cur.concat(imgs.map(function (f) { return { file: f, url: URL.createObjectURL(f) } })).slice(0, 4) })
      }
      var setF = function (k) { return function (e) { var v = e.target.value; setForm(function (f) { var n = Object.assign({}, f); n[k] = v; return n }) } }

      var start = function () {
        setBusy('start')
        var begin = textMode
          ? apiPost('/create/start', { category: cat, text: text, name: nameDraft, hint: hint, expand: doAnalyze, sheet: doSheet })
          : Promise.all(files.map(function (f) { return fileToDataUrl(f.file).then(function (d) { return { name: f.file.name, data: d } }) }))
            .then(function (payload) { return apiPost('/import/start', { category: cat, files: payload, hint: hint, analyze: doAnalyze, sheet: doSheet }) })
        begin
          .then(function (r) {
            state.current.importId = r.importId
            setBusy('')
            setStep('running')
            setJob({ stage: doAnalyze ? (textMode ? '扩写描述' : '识别图片') : '生成' + SHEET_NAME[cat], elapsedMs: 0 })
            var p = pollJob(r.jobId, setJob)
            pollRef.current = p
            return p
          })
          .then(function (j) {
            var res = j.result
            setResult(res)
            setForm({ name: res.fields.name, aliases: res.fields.aliases.join('，'), tags: res.fields.tags.join('，'), description: res.fields.description })
            setUseSheet(!!res.sheet)
            setStep('review')
          })
          .catch(function (e) { setBusy(''); setStep('pick'); props.toast(errText(e), true) })
      }

      var regen = function () {
        setBusy('regen')
        apiPost('/import/sheet', { importId: result.importId, hint: regenHint || hint, description: form.description, name: form.name })
          .then(function (r) { var p = pollJob(r.jobId); pollRef.current = p; return p })
          .then(function (j) { setResult(function (x) { return Object.assign({}, x, { sheet: j.result.sheet, sheetError: '' }) }); setUseSheet(true); props.toast('已重新生成') })
          .catch(function (e) { props.toast(errText(e), true) })
          .then(function () { setBusy('') })
      }

      var commit = function () {
        setBusy('commit')
        apiPost('/import/commit', {
          importId: result.importId,
          fields: { name: form.name, aliases: form.aliases, tags: form.tags, description: form.description },
          sheetId: result.sheet ? result.sheet.id : '',
          useSheet: useSheet && !!result.sheet,
          useOriginals: useOriginals && !!(result.sources && result.sources.length),
          targetId: target,
        }).then(function (r) {
          state.current.committed = true
          props.toast(target ? '已加到「' + r.entry.name + '」' : '已存进库：「' + r.entry.name + '」')
          return props.onDone(r.entry)
        }, function (e) { setBusy(''); props.toast(errText(e), true) })
      }

      var head = h('div', { key: 'head', className: 'is-detail-head' }, [
        h('button', { key: 'b', type: 'button', className: 'is-btn is-btn-ghost', onClick: function () {
          if (step === 'review' && !window.confirm('放弃这次导入？')) return
          props.onBack()
        } }, [h(Icon, { key: 'i', name: 'back' }), '素材库']),
        h('div', { key: 't', className: 'is-detail-title' }, textMode ? '用文字生成' : '从图片导入'),
      ])

      if (step === 'running') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [head, h('div', { key: 'p', className: 'is-progress is-shimmer', style: { aspectRatio: 'auto', minHeight: '260px' } }, [
          h('div', { key: 's', className: 'isv-spin' }),
          h('div', { key: 't' }, (job && job.stage ? job.stage : '处理中') + ' · ' + Math.round(((job && job.elapsedMs) || 0) / 1000) + ' 秒'),
          h('div', { key: 'n', className: 'is-note' }, (textMode ? '扩写描述' : '识图') + '十几秒，三视图通常要一两分钟。'),
        ])])
      }

      if (step === 'review' && result) {
        var sheetSrc = result.sheet ? outSrc(result.sheet.id, 0) : ''
        var entries = (props.lib.categories[cat] || [])
        var hasSources = !!(result.sources && result.sources.length)
        var isText = result.mode === 'text'
        var canCommit = (useSheet && !!result.sheet) || (useOriginals && hasSources) || (isText && !target)
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
          head,
          h('div', { key: 'g', className: 'is-import-grid' }, [
            h('div', { key: 'l', className: 'is-panel' }, [
              h('div', { key: 't', className: 'is-panel-title' }, [h(Icon, { key: 'i', name: 'image' }), SHEET_NAME[cat]]),
              busy === 'regen'
                ? h('div', { key: 'w', className: 'is-progress is-shimmer', style: { aspectRatio: cat === 'scenes' ? '4/3' : '16/9' } }, [h('div', { key: 's', className: 'isv-spin' }), '重新生成中…'])
                : result.sheet
                  ? h('div', { key: 's', className: 'is-sheet' }, h(Img, { src: sheetSrc, onClick: function () { openLightbox(sheetSrc, form.name) } }))
                  : h('div', { key: 'e', className: 'is-error' }, result.sheetError ? '三视图没生成出来：' + result.sheetError : '这次没有生成三视图'),
              h('div', { key: 'r', className: 'is-row' }, [
                h('input', { key: 'i', className: 'is-input is-grow', style: { flex: '1 1 180px' }, value: regenHint, placeholder: '不满意？写点要求再画一次，如「只要外套」「裙子再长一点」', onChange: function (e) { setRegenHint(e.target.value) } }),
                h('button', { key: 'b', type: 'button', className: 'is-btn', disabled: !!busy, onClick: regen }, [h(Icon, { key: 'i', name: 'refresh', size: 13 }), result.sheet ? '重新生成' : '生成']),
              ]),
              hasSources ? h('div', { key: 'o', className: 'is-label' }, '原图') : null,
              hasSources ? h('div', { key: 'm', className: 'is-mini-thumbs' }, result.sources.map(function (f) {
                var s = srcOf(result.importId, f)
                return h('div', { key: f, className: 'is-thumb' }, h(Img, { src: s, onClick: function () { openLightbox(s, '原图') } }))
              })) : null,
              !hasSources && result.text ? h('div', { key: 'ot', className: 'is-note' }, '你的原话：' + result.text) : null,
            ]),
            h('div', { key: 'r', className: 'is-panel' }, [
              h('div', { key: 't', className: 'is-panel-title' }, [h(Icon, { key: 'i', name: 'sparkle' }), isText ? '扩写结果' : '识别结果', h('span', { key: 'n', className: 'is-note' }, '都可以改')]),
              result.analysisError ? h('div', { key: 'ae', className: 'is-error' }, (isText ? '扩写没成功：' + result.analysisError + '。先用你的原话当描述了，可以手动补充，或到设置里换识图方式。' : '识图没成功：' + result.analysisError + '。可以手动填，或到设置里换识图方式。')) : null,
              h(Field, { key: 'n', label: '名字' }, h('input', { className: 'is-input', value: form.name, onChange: setF('name') })),
              h(Field, { key: 'a', label: '别名' }, h('input', { className: 'is-input', value: form.aliases, onChange: setF('aliases') })),
              h(Field, { key: 'tg', label: '标签' }, h('input', { className: 'is-input', value: form.tags, onChange: setF('tags') })),
              h(Field, { key: 'd', label: '外观描述', hint: '会写进生图提示词' }, h('textarea', { className: 'is-textarea', rows: 6, value: form.description, onChange: setF('description') })),
              h(Toggle, { key: 'us', checked: useSheet && !!result.sheet, onChange: setUseSheet, title: '存入' + SHEET_NAME[cat] + '并设为封面', hint: '生图时优先拿它当参考' }),
              hasSources ? h(Toggle, { key: 'uo', checked: useOriginals, onChange: setUseOriginals, title: '同时保存原图' }) : null,
              isText && !(useSheet && result.sheet) && !target ? h('div', { key: 'nt', className: 'is-note' }, '不存三视图的话，会建一个只有文字描述的条目，之后可以再补图。') : null,
              h(Field, { key: 'tt', label: '存到' }, h('select', { className: 'is-select', value: target, onChange: function (e) { setTarget(e.target.value) } }, [h('option', { key: '', value: '' }, '新建' + CAT_LABEL[cat] + '条目')].concat(entries.map(function (e) {
                return h('option', { key: e.id, value: e.id }, '加到已有：' + e.name)
              })))),
              h('div', { key: 'b', className: 'is-row' }, [
                h('span', { key: 'g', className: 'is-grow' }),
                h('button', { key: 'c', type: 'button', className: 'is-btn is-btn-primary', disabled: !!busy || (!target && !form.name.trim()) || !canCommit, onClick: commit }, busy === 'commit' ? '保存中…' : '保存到库'),
              ]),
            ]),
          ]),
        ])
      }

      // 第一步：选图 / 写描述
      var hasKey = !!(props.config && props.config.api.hasKey)
      var ready = textMode ? !!text.trim() : files.length > 0
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        head,
        h('div', { key: 'mode', className: 'is-row' }, [
          h(Seg, { key: 's', value: mode, onChange: setMode, options: [{ value: 'image', label: '从图片' }, { value: 'text', label: '用文字描述' }] }),
          h('span', { key: 'g', className: 'is-grow' }),
          h('span', { key: 'l', className: 'is-label' }, '存到'),
          h(Seg, { key: 'c', value: cat, onChange: setCat, options: CATS.map(function (c) { return { value: c, label: CAT_LABEL[c] } }) }),
        ]),
        h('div', { key: 'tip', className: 'is-note' }, textMode ? TEXT_TIP[cat] : IMPORT_TIP[cat]),
        textMode ? h(Field, { key: 'txt', label: '描述' }, h('textarea', { className: 'is-textarea', rows: 5, value: text, placeholder: TEXT_PH[cat], onChange: function (e) { setText(e.target.value) } })) : null,
        textMode ? h(Field, { key: 'nm', label: '名字', hint: '可选，不填让模型起' }, h('input', { className: 'is-input', value: nameDraft, onChange: function (e) { setNameDraft(e.target.value) } })) : null,
        textMode ? null : h('div', {
          key: 'drop',
          className: cx('is-import-drop', dragOn && 'is-drop-on'),
          onClick: function () { if (fileRef.current) fileRef.current.click() },
          onDragOver: function (e) { e.preventDefault(); if (!dragOn) setDragOn(true) },
          onDragLeave: function (e) { if (e.currentTarget === e.target) setDragOn(false) },
          onDrop: function (e) { e.preventDefault(); setDragOn(false); addFiles(e.dataTransfer && e.dataTransfer.files) },
        }, files.length
          ? h('div', { className: 'is-mini-thumbs', style: { justifyContent: 'center' } }, files.map(function (f, i) {
            return h('div', { key: i, className: 'is-thumb', style: { width: '120px' } }, [
              h('img', { key: 'i', src: f.url, alt: '' }),
              h('div', { key: 't', className: 'is-thumb-tools', style: { opacity: 1 } }, h('button', { type: 'button', className: 'is-thumb-tool', title: '移除', onClick: function (e) {
                e.stopPropagation()
                URL.revokeObjectURL(f.url)
                setFiles(function (cur) { return cur.filter(function (_, j) { return j !== i }) })
              } }, h(Icon, { name: 'x', size: 13 }))),
            ])
          }))
          : [h('div', { key: 'i', className: 'is-plus' }, h(Icon, { name: 'upload', size: 18 })), h('div', { key: 't', className: 'is-empty-title' }, '把图片拖到这里，或点击选择'), h('div', { key: 'd', className: 'is-note' }, '最多 4 张；同一个东西的多角度图片一起传效果更好')]),
        textMode ? null : h('input', { key: 'f', ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, style: { display: 'none' }, onChange: function (e) { addFiles(e.target.files); e.target.value = '' } }),
        h(Field, { key: 'h', label: '补充说明', hint: textMode ? '可选：画风或其他要求' : '可选：告诉它要提取什么' }, h('input', { className: 'is-input', value: hint, onChange: function (e) { setHint(e.target.value) }, placeholder: textMode ? '例如：和小鱼同一种画风；颜色偏淡' : cat === 'outfits' ? '例如：只要这件外套，不要裤子' : cat === 'characters' ? '例如：左边那个角色' : '' })),
        h('div', { key: 'o', className: 'is-row', style: { gap: '18px' } }, [
          h(Toggle, { key: 'a', checked: doAnalyze, onChange: setDoAnalyze, title: textMode ? '让模型扩写成详细描述，并填好名字和标签' : '识别并填好名字、标签和描述' }),
          h(Toggle, { key: 's', checked: doSheet, onChange: setDoSheet, title: '生成' + SHEET_NAME[cat] }),
        ]),
        h('div', { key: 'b', className: 'is-row' }, [
          h('span', { key: 'g', className: 'is-grow' }),
          h('button', { key: 's', type: 'button', className: 'is-btn is-btn-primary', disabled: !ready || (!doAnalyze && !doSheet) || busy === 'start' || (!hasKey && doSheet), onClick: start }, [h(Icon, { key: 'i', name: 'sparkle' }), busy === 'start' ? (textMode ? '提交中…' : '上传中…') : '开始']),
        ]),
        doSheet && !(props.config && props.config.api.hasKey) ? h('div', { key: 'k', className: 'is-note', style: { color: 'var(--is-warn)' } }, '生成三视图要用生图接口，先到「设置」里填 API Key。') : null,
      ])
    }

    // ---- 设置页外壳 -------------------------------------------------------------

    class Boundary extends Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error: error } }
      componentDidCatch(error) { try { console.error('[dsh-image-studio] 渲染失败：', error) } catch (e) { /* 忽略 */ } }
      render() {
        if (this.state.error === null) return this.props.children
        var msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
        if (this.props.compact) return h('div', { className: 'isv-card' }, h('div', { className: 'isv-err' }, '出图卡片渲染出错：' + msg))
        return h('div', { className: 'is-root' }, [
          h('div', { key: 'h', className: 'is-h1' }, '生图工作室'),
          h('div', { key: 'e', className: 'is-error' }, '这个设置页渲染时出错了：' + msg + '（刷新页面通常能恢复）'),
        ])
      }
    }

    function StudioSection() {
      var [state, setState] = useState(null)
      var [lib, setLib] = useState(null)
      var [error, setError] = useState('')
      var [tab, setTab] = useState('library')
      var [toast, setToast] = useState(null)
      var [historyVersion, setHistoryVersion] = useState(0)
      var [draft, setDraft] = useState({ prompt: '', characters: [], outfits: [], scene: '', props: [], aspect: '3:4', situation: '', expression: '', pose: '', shot: '', light: '', job: null })
      var [presets, setPresets] = useState(null)
      var toastTimer = useRef(null)

      var showToast = useCallback(function (text, isErr) {
        clearTimeout(toastTimer.current)
        setToast({ text: text, err: !!isErr })
        toastTimer.current = setTimeout(function () { setToast(null) }, isErr ? 6000 : 2400)
      }, [])
      var reloadLib = useCallback(function () {
        return apiGet('/library?force=1').then(function (l) { setLib(l) }, function (e) { showToast(errText(e), true) })
      }, [])

      useEffect(function () {
        Promise.all([apiGet('/state'), apiGet('/library'), apiGet('/presets')]).then(function (r) {
          setState(r[0])
          setLib(r[1])
          setPresets(r[2].presets)
          setDraft(function (d) { return Object.assign({}, d, { aspect: r[0].config.api.defaultAspect }) })
        }, function (e) { setError(errText(e)) })
        return function () { clearTimeout(toastTimer.current) }
      }, [])

      if (error) {
        return h('div', { className: 'is-root' }, [
          h('div', { key: 'h', className: 'is-h1' }, '生图工作室'),
          h('div', { key: 'e', className: 'is-error' }, '连不上插件的宿主接口：' + error + '。如果刚装好插件，重启一次 DSH；只改了页面代码的话刷新即可。'),
        ])
      }
      if (!state || !lib || !presets) return h('div', { className: 'is-root' }, h('div', { className: 'is-note' }, '加载中…'))

      var cfg = state.config
      var total = CATS.reduce(function (n, c) { return n + (lib.categories[c] || []).length }, 0)
      var apiPill = !cfg.enabled
        ? h('span', { key: 'a', className: 'is-pill' }, [h('span', { key: 'd', className: 'is-dot' }), '已关闭'])
        : cfg.api.hasKey
          ? h('span', { key: 'a', className: 'is-pill', title: cfg.api.baseUrl }, [h('span', { key: 'd', className: 'is-dot is-dot-ok' }), cfg.api.model])
          : h('button', { key: 'a', type: 'button', className: 'is-pill', style: { cursor: 'pointer' }, onClick: function () { setTab('settings') } }, [h('span', { key: 'd', className: 'is-dot is-dot-warn' }), '未填 API Key'])

      var tabs = [
        { id: 'library', label: '素材库', icon: 'layers', count: total },
        { id: 'keywords', label: '关键词', icon: 'tag' },
        { id: 'create', label: '试生成', icon: 'sparkle' },
        { id: 'history', label: '生成记录', icon: 'history' },
        { id: 'settings', label: '设置', icon: 'gear' },
      ]
      var body
      if (tab === 'library') body = h(LibraryTab, { lib: lib, setLib: setLib, reloadLib: reloadLib, toast: showToast, presets: presets, config: cfg })
      else if (tab === 'keywords') body = h(KeywordsTab, { presets: presets, onPresets: setPresets, lib: lib, toast: showToast })
      else if (tab === 'create') body = h(CreateTab, { lib: lib, config: cfg, presets: presets, draft: draft, setDraft: setDraft, toast: showToast, onGenerated: function () { setHistoryVersion(function (v) { return v + 1 }) } })
      else if (tab === 'history') body = h(HistoryTab, { version: historyVersion, toast: showToast })
      else body = h(SettingsTab, { state: state, onState: setState, toast: showToast })

      return h('div', { className: 'is-root' }, [
        h('div', { key: 'head', className: 'is-head' }, [
          h('div', { key: 'l', className: 'is-logo' }, h(Icon, { name: 'sparkle', size: 18 })),
          h('div', { key: 't', className: 'is-head-text' }, [
            h('div', { key: 'h', className: 'is-h1' }, '生图工作室'),
            h('div', { key: 's', className: 'is-sub' }, '本地参考库 + 关键词，模型按角色此刻的情境自己判断发什么图。'),
          ]),
          apiPill,
        ]),
        h('div', { key: 'tabs', className: 'is-tabs', role: 'tablist' }, tabs.map(function (t) {
          return h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': tab === t.id, className: cx('is-tab', tab === t.id && 'is-tab-on'), onClick: function () { setTab(t.id) } }, [
            h(Icon, { key: 'i', name: t.icon, size: 14 }),
            t.label,
            t.count !== undefined ? h('span', { key: 'c', className: 'is-count' }, t.count) : null,
          ])
        })),
        h(React.Fragment, { key: 'body' }, body),
        toast ? h('div', { key: 'toast', className: cx('is-toast', toast.err && 'is-toast-err'), role: 'status' }, [
          h(Icon, { key: 'i', name: toast.err ? 'x' : 'check', size: 14 }),
          toast.text,
        ]) : null,
      ])
    }

    // ---- 聊天里的出图卡片 -------------------------------------------------------

    // 宿主给的 block.args 是「读器」（.text(key) / .complete(key)，参数流式到达时也能读），
    // 不是参数对象；完整参数在 call.argsRaw / argsRaw 里。两条路都兜住。
    function readArgs(block) {
      var raw = (block.call && block.call.argsRaw) || block.argsRaw || ''
      var parsed = null
      try { parsed = raw ? JSON.parse(raw) : null } catch (e) { parsed = null }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      var a = null
      try { a = block.args } catch (e) { a = null }
      if (a && typeof a.text === 'function') {
        var get = function (k) { try { var v = a.text(k); return typeof v === 'string' ? v : undefined } catch (e) { return undefined } }
        return { prompt: get('prompt'), caption: get('caption') }
      }
      if (a && typeof a === 'object') return a
      return {}
    }
    function resultTextOf(block) {
      var parts = []
      var content = Array.isArray(block.content) ? block.content : []
      for (var i = 0; i < content.length; i++) if (content[i] && content[i].type === 'text') parts.push(content[i].text)
      return parts.join('\n')
    }

    function Elapsed() {
      var [start] = useState(function () { return Date.now() })
      var [, tick] = useState(0)
      useEffect(function () {
        var t = setInterval(function () { tick(function (x) { return x + 1 }) }, 1000)
        return function () { clearInterval(t) }
      }, [])
      return h('span', null, Math.round((Date.now() - start) / 1000) + ' 秒')
    }

    function ImageGenRow(props) {
      var block = props.block || {}
      var done = typeof block === 'object' && 'kind' in block
      var args = readArgs(block)
      var prompt = typeof args.prompt === 'string' ? args.prompt : ''
      var head = h('div', { key: 'h', className: 'isv-head' }, [
        h(Icon, { key: 'i', name: 'sparkle', size: 13 }),
        h('b', { key: 'b' }, '生图'),
        h('span', { key: 's', className: 'isv-head-sum', title: prompt }, prompt),
      ])
      if (!done) {
        var preparing = block.phase === 'preparing'
        return h('div', { className: 'isv-card' }, [head, h('div', { key: 'w', className: 'isv-wait is-shimmer' }, [
          h('div', { key: 's', className: 'isv-spin' }),
          h('div', { key: 't' }, preparing ? '正在构思画面…' : ['正在画 · ', h(Elapsed, { key: 'e' })]),
          preparing ? null : h('div', { key: 'n', className: 'is-note' }, '通常要几十秒'),
        ])])
      }
      var text = resultTextOf(block)
      if (block.isError) {
        var stopped = block.error && block.error.code === 'interrupted'
        return h('div', { className: 'isv-card' }, [head, h('div', { key: 'e', className: stopped ? 'isv-msg' : 'isv-err' }, stopped ? '已停止' : (text.split('\n')[0] || '生成失败'))])
      }
      var meta = block.meta && typeof block.meta === 'object' ? block.meta : {}
      var id = meta.studio === 'image-studio' ? meta.id : ''
      if (!id) {
        var m = /已生成图片 (img-[\w-]+)/.exec(text)
        if (m) id = m[1]
      }
      if (meta.studio === 'image-studio' && meta.ok === false) {
        return h('div', { className: 'isv-card' }, [head, h('div', { key: 'm', className: 'isv-msg' }, meta.message || text)])
      }
      if (!id) return h('div', { className: 'isv-card' }, [head, h('div', { key: 'm', className: 'isv-msg' }, text || '没有生成图片')])
      var src = outSrc(id, 0)
      var caption = meta.caption || args.caption || ''
      return h('div', { className: 'isv-card' }, [
        head,
        h('div', { key: 'm', className: 'isv-media' }, h(Img, { src: src, alt: prompt, onClick: function () { openLightbox(src, caption || prompt) } })),
        h('div', { key: 'f', className: 'isv-foot' }, [
          caption ? h('div', { key: 'c', className: 'isv-cap' }, caption) : null,
          meta.refs ? h('div', { key: 'r', className: 'isv-refs' }, '参考：' + meta.refs) : null,
          keywordLine(meta.keywords) ? h('div', { key: 'k', className: 'isv-refs' }, keywordLine(meta.keywords)) : null,
          h('div', { key: 'a', className: 'is-row', style: { gap: '4px' } }, [
            h('span', { key: 'id', className: 'isv-refs is-grow' }, id),
            h('button', { key: 'o', type: 'button', className: 'is-btn is-btn-sm is-btn-ghost', title: '打开位置', onClick: function () { apiPost('/open', { historyId: id }).catch(function () {}) } }, h(Icon, { name: 'folder', size: 12 })),
          ]),
        ]),
      ])
    }

    // ---- 注册 -------------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-image-studio-styles'
        var style = document.getElementById(id)
        if (style === null) {
          style = document.createElement('style')
          style.id = id
          style.setAttribute('data-plugin', 'dsh-image-studio')
          document.head.appendChild(style)
        }
        style.textContent = CSS
        return function () { var el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el) }
      }, 'dsh-image-studio: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'image-studio',
          order: 47,
          locale: NS,
          label: function () { return '生图工作室' },
        }, function (props) { return h(Boundary, null, h(StudioSection, props || {})) })
      })

      try {
        ctx.slots.inject('tool.call.toolview', function () {
          return ctx.slots.register({ name: 'tool.call.toolview', key: 'image_generate', locale: NS }, function (props) {
            return h(Boundary, { compact: true }, h(ImageGenRow, props || {}))
          })
        })
      } catch (e) {
        try { console.warn('[dsh-image-studio] 聊天出图卡片注册失败（不影响生图本身）：', e) } catch (x) { /* 忽略 */ }
      }
    }

    module.exports = {
      name: 'image-studio',
      inject: ['slots'],
      apply: apply,
      // 仅供离线冒烟测试（tests/smoke-client.mjs）直接渲染各页
      __test: { StudioSection: StudioSection, LibraryTab: LibraryTab, EntryEditor: EntryEditor, CreateTab: CreateTab, HistoryTab: HistoryTab, SettingsTab: SettingsTab, ImageGenRow: ImageGenRow, Boundary: Boundary, KeywordsTab: KeywordsTab, ImportPanel: ImportPanel },
    }
    return module.exports
  },
})
