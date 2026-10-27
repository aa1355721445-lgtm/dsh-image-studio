// 极简 React 替身：只为离线冒烟测试同步「渲染一遍」各组件，抓渲染期的 TypeError。
// 不跑 effect（相当于 SSR 首帧），setState 不触发重渲。宿主里用的是真 React。
export const Fragment = Symbol('Fragment')
export class Component { constructor(props) { this.props = props; this.state = {} } setState() {} }
export function createElement(type, props, ...children) {
  const p = { ...(props || {}) }
  if (children.length) p.children = children.length === 1 ? children[0] : children
  return { $$el: true, type, props: p }
}
let hooks = null
// 测试可以预先塞一串 useState 的值（按调用顺序消费；undefined = 用组件自己的初始值）
let overrides = []
export function __override(list) { overrides = list.slice() }
export function useState(init) {
  if (overrides.length) { const o = overrides.shift(); if (o !== undefined) return [o, () => {}] }
  return [typeof init === 'function' ? init() : init, () => {}]
}
export function useRef(init) { return { current: init } }
export function useEffect() {}
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }

export function render(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach((n) => render(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (!node.$$el) throw new TypeError('not a renderable node: ' + JSON.stringify(node).slice(0, 80))
  const { type, props } = node
  if (type === Fragment) return render(props.children, out)
  if (typeof type === 'string') {
    if (type === 'input' || type === 'textarea') { if (props.value !== undefined) out.push(`[${type}:${props.value}]`); if (props.placeholder) out.push(`{ph:${props.placeholder}}`) }
    return render(props.children, out)
  }
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.render) {
      const inst = new type(props)
      if (type.getDerivedStateFromError) inst.state = inst.state || { error: null }
      return render(inst.render(), out)
    }
    return render(type(props), out)
  }
  throw new TypeError('unknown element type')
}
export default { Fragment, Component, createElement, useState, useRef, useEffect, useMemo, useCallback, __override }
