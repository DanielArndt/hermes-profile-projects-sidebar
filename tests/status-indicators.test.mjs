import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const logicStart = source.indexOf('  const dotWrapRef = useRef(null)')
const logicEnd = source.indexOf('  const selectedStyle =', logicStart)
assert.ok(logicStart >= 0 && logicEnd > logicStart)
const logic = source.slice(logicStart, logicEnd)

// Exercise the real observer/state/render logic with only the React hooks and
// DOM boundary stubbed. A second render picks up the observer's state update.
function rowStatus(className, { running = false, selected = false, busy = false } = {}) {
  let state = 'idle'
  let sync
  const context = {
    session: { id: 'parent', running },
    isSelected: selected,
    host: { state: { busy } },
    useValue: value => value,
    useRef: () => ({ current: { querySelector: () => className ? { className } : null } }),
    useState: () => [state, value => { state = value }],
    useEffect: effect => effect(),
    MutationObserver: class {
      constructor(callback) { sync = callback }
      observe() {}
      disconnect() {}
    }
  }
  const render = () => vm.runInNewContext(`(() => { ${logic}; return { dotState, showsArc, liveTurn } })()`, context)
  render()
  sync()
  const result = render()
  // Strip the VM realm's object prototype for strict equality.
  return { ...result }
}

const base = 'size-1.5 rounded-full'
const background = `${base} border border-(--ui-text-tertiary)`

test('parent waiting on subagents remains live with a running arc', () => {
  assert.deepEqual(rowStatus(background), { dotState: 'background', showsArc: true, liveTurn: true })
})

test('existing working, stalled, attention and idle states retain their meaning', () => {
  assert.deepEqual(rowStatus(`${base} bg-(--ui-accent)`), { dotState: 'working', showsArc: true, liveTurn: true })
  assert.deepEqual(rowStatus(`${base} border border-(--ui-accent)`), { dotState: 'stalled', showsArc: true, liveTurn: true })
  assert.deepEqual(rowStatus(`${base} bg-amber-500`), { dotState: 'needs-input', showsArc: false, liveTurn: true })
  assert.deepEqual(rowStatus(null), { dotState: 'idle', showsArc: false, liveTurn: false })
  assert.equal(rowStatus(null, { selected: true, busy: true }).showsArc, true)
  assert.equal(rowStatus(null, { running: true }).showsArc, true)
})

test('background work receives a filled yellow status dot', () => {
  const styleStart = source.indexOf('dotStyle.textContent = `')
  const css = source.slice(styleStart, source.indexOf('`', styleStart + 'dotStyle.textContent = `'.length) + 1)
  const rule = css.match(/span\[role="status"\]\[class\*="border-\(--ui-text-tertiary\)"\]\s*\{([^}]+)\}/)
  assert.ok(rule, 'background status dot needs a palette override')
  assert.match(rule[1], /background-color:\s*#eab308\s*!important/)
  assert.match(rule[1], /border-color:\s*#eab308\s*!important/)
})

test('quiet but still-running work receives a filled yellow status dot', () => {
  const styleStart = source.indexOf('dotStyle.textContent = `')
  const css = source.slice(styleStart, source.indexOf('`', styleStart + 'dotStyle.textContent = `'.length) + 1)
  const rule = css.match(/span\[role="status"\]\[class\*="border-\(--ui-accent\)"\]\s*\{([^}]+)\}/)
  assert.ok(rule, 'stalled status dot needs a palette override')
  assert.match(rule[1], /background-color:\s*#eab308\s*!important/)
  assert.match(rule[1], /border-color:\s*#eab308\s*!important/)
})

test('a done marker only hollows the dot when the session is no longer live', () => {
  const attribute = source.match(/'data-session-done':\s*([^,]+),/)
  assert.ok(attribute)
  const doneAttribute = (isDone, liveTurn) => vm.runInNewContext(attribute[1], { isDone, liveTurn })
  assert.equal(doneAttribute(true, true), undefined)
  assert.equal(doneAttribute(true, false), '')
  assert.equal(doneAttribute(false, false), undefined)
})
