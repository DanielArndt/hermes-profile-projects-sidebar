import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const css = source.match(/dotStyle\.textContent = `([\s\S]+?)`/)[1].replace(/\/\*[\s\S]*?\*\//g, '')
const spinName = 'hermes-projects-working-spin'
const states = ['bg-(--ui-accent)', 'border-(--ui-accent)', 'border-(--ui-text-tertiary)']
const selectorFor = state => `span[role="status"][class*="${state}"]`

// Read the actual injected stylesheet, not a second implementation of it.
function spinnerRule(state) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors, declarations]) => selectors.includes(selectorFor(state)) && declarations.includes('conic-gradient'))?.[2]
}

for (const state of states) {
  test(`${state} receives a yellow ring spinner instead of a filled dot`, () => {
    const rule = spinnerRule(state)
    assert.ok(rule, 'working status needs a conic-gradient spinner rule')
    assert.match(rule, /background-color:\s*transparent\s*!important/)
    assert.match(rule, /background-image:\s*conic-gradient\([^;]*#eab308[^;]*\)\s*!important/)
    assert.match(rule, /border:\s*0\s*!important/)
    assert.match(rule, /width:\s*0\.5rem\s*!important/)
    assert.match(rule, /height:\s*0\.5rem\s*!important/)
    assert.match(rule, /mask:\s*radial-gradient\([^;]*transparent[^;]*\)\s*!important/)
    assert.match(rule, new RegExp(`animation:\\s*${spinName}\\s+0\\.8s\\s+linear\\s+infinite\\s*!important`))
  })
}

test('spinner rotation is namespaced and respects reduced motion and app pause', () => {
  assert.match(css, new RegExp(`@keyframes ${spinName}\\s*\\{\\s*to\\s*\\{\\s*transform:\\s*rotate\\(360deg\\)`))
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'))
  for (const state of states) assert.ok(reduced.includes(selectorFor(state)))
  assert.match(reduced, /animation:\s*none\s*!important/)
  assert.ok(css.includes(':root[data-renderer-animations-paused]'))
  assert.match(css, /animation-play-state:\s*paused\s*!important/)
})

test('spinner selectors exclude unread, approval, draft and idle status dots', () => {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, , declarations]) => declarations.includes('conic-gradient'))
  assert.ok(rule)
  assert.deepEqual(rule[1].trim().split(',').map(selector => selector.trim()), states.map(selectorFor))
})
