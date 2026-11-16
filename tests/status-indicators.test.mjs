import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const hookStart = source.indexOf('function useSessionDotState(')
const hookEnd = source.indexOf('function ProjectSessionRow(', hookStart)
assert.ok(hookStart >= 0 && hookEnd > hookStart)
const hook = source.slice(hookStart, hookEnd)
const logicStart = source.indexOf('  const { dotWrapRef, dotState } = useSessionDotState(session.id)')
const logicEnd = source.indexOf('  const selectedStyle =', logicStart)
assert.ok(logicStart >= 0 && logicEnd > logicStart)
const logic = source.slice(logicStart, logicEnd)

// Exercise the real observer/state/render logic with only the React hooks and
// DOM boundary stubbed. Keep the effect mounted across status transitions.
function observeRowStatus(className, { running = false, selected = false, busy = false, observerAvailable = true, wrapperAvailable = true } = {}) {
  let state = 'idle'
  let sync
  let cleanup
  let mounted = false
  let disconnected = false
  let observed
  const wrapper = {
    querySelector: selector => {
      assert.equal(selector, '[role="status"]')
      return className ? { className } : null
    }
  }
  const context = {
    session: { id: 'parent', running },
    isSelected: selected,
    host: { state: { busy } },
    useValue: value => value,
    useRef: () => ({ current: wrapperAvailable ? wrapper : null }),
    useState: () => [state, value => { state = value }],
    useEffect: effect => {
      if (!mounted) {
        mounted = true
        cleanup = effect()
      }
    },
    MutationObserver: observerAvailable ? class {
      constructor(callback) { sync = callback }
      observe(element, options) { observed = { element, options } }
      disconnect() { disconnected = true }
    } : undefined
  }
  const render = () => vm.runInNewContext(`(() => { ${hook}; ${logic}; return { dotState, showsArc, liveTurn } })()`, context)
  render()
  return {
    read: () => ({ ...render() }),
    transition: nextClass => {
      className = nextClass
      sync?.()
      return { ...render() }
    },
    dispose: () => cleanup?.(),
    observed,
    wrapper,
    disconnected: () => disconnected
  }
}

function rowStatus(className, options) {
  return observeRowStatus(className, options).read()
}

const base = 'size-1.5 rounded-full'
const background = `${base} border border-(--ui-text-tertiary)`

test('only actionable states receive an arc without changing live-turn meaning', () => {
  assert.deepEqual(rowStatus(`${base} bg-(--ui-success)`), { dotState: 'unread', showsArc: true, liveTurn: false })
  assert.deepEqual(rowStatus(`${base} bg-amber-500`), { dotState: 'needs-input', showsArc: true, liveTurn: true })
  assert.deepEqual(rowStatus(`${base} bg-(--ui-accent)`), { dotState: 'working', showsArc: false, liveTurn: true })
  assert.deepEqual(rowStatus(`${base} border border-(--ui-accent)`), { dotState: 'stalled', showsArc: false, liveTurn: true })
  assert.deepEqual(rowStatus(background), { dotState: 'background', showsArc: false, liveTurn: true })
  assert.deepEqual(rowStatus(null), { dotState: 'idle', showsArc: false, liveTurn: false })
  assert.equal(rowStatus(null, { selected: true, busy: true }).showsArc, false)
  assert.equal(rowStatus(null, { running: true }).showsArc, false)
})

test('reading a reply or resolving input clears the arc on the mounted row', () => {
  const row = observeRowStatus(`${base} bg-(--ui-accent)`)
  assert.equal(row.read().showsArc, false)
  assert.equal(row.transition(`${base} bg-(--ui-success)`).showsArc, true)
  assert.deepEqual(row.transition(null), { dotState: 'idle', showsArc: false, liveTurn: false })
  assert.equal(row.transition(`${base} bg-amber-500`).showsArc, true)
  assert.deepEqual(row.transition(`${base} bg-(--ui-accent)`), { dotState: 'working', showsArc: false, liveTurn: true })
  assert.equal(row.transition(background).showsArc, false)
  assert.equal(row.transition(`${base} border border-(--ui-accent)`).showsArc, false)
  assert.equal(row.transition(`${base} border border-(--ui-text-quaternary)`).showsArc, false)
})

test('the status observer stays scoped to its row and disconnects on unmount', () => {
  const row = observeRowStatus(null)
  assert.equal(row.observed.element, row.wrapper)
  assert.deepEqual(JSON.parse(JSON.stringify(row.observed.options)), {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'role']
  })
  assert.equal(row.disconnected(), false)
  row.dispose()
  assert.equal(row.disconnected(), true)
})

test('missing observer or dot wrapper leaves the row without an action arc', () => {
  for (const options of [{ observerAvailable: false }, { wrapperAvailable: false }]) {
    const row = observeRowStatus(`${base} bg-(--ui-success)`, options)
    assert.deepEqual(row.read(), { dotState: 'idle', showsArc: false, liveTurn: false })
    assert.equal(row.observed, undefined)
    assert.doesNotThrow(() => row.dispose())
  }
})

test('action arcs use semantic colors rather than the profile tint', () => {
  const arc = source.match(/showsArc &&\s*(jsx\('span', \{[\s\S]+?\n        \}\))/)
  assert.ok(arc, 'session row must render its action arc')
  const renderArc = className => vm.runInNewContext(arc[1], {
    ...rowStatus(className),
    profileTintColor: '#a855f7',
    jsx: (type, props) => ({ type, props })
  })
  assert.equal(renderArc(`${base} bg-(--ui-success)`).props.style['--arc-c1'], 'var(--ui-success)')
  assert.equal(renderArc(`${base} bg-amber-500`).props.style['--arc-c1'], '#ef4444')
})

// Render the real scheduled-run row, with SDK components represented as nodes.
// Only the host dot DOM and React hooks are stubbed; the arc/ref wiring is real.
function cronRow(className, run = {}) {
  const start = source.indexOf('function CronJobRunRow(')
  const end = source.indexOf('function CronJobRunsPeek(', start)
  assert.ok(start >= 0 && end > start)
  const states = []
  let cursor = 0
  let sync
  const wrap = { querySelector: () => className ? { className } : null }
  const element = (type, props) => ({ type, props })
  const context = {
    run: { id: 'cron-run', ...run },
    host: { state: { busy: false } },
    useValue: value => value,
    useRef: () => ({ current: wrap }),
    useState: initial => {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = value }]
    },
    useEffect: effect => effect(),
    MutationObserver: class {
      constructor(callback) { sync = callback }
      observe() {}
      disconnect() {}
    },
    jsx: element,
    jsxs: element,
    cn: (...classes) => classes.filter(Boolean).join(' '),
    formatRunTime: () => 'Today 12:00',
    formatCompactAge: () => '1m',
    SessionStatusDot: () => null,
    ConfirmDialog: () => null,
    ...Object.fromEntries(['RowButton', 'Button', 'Codicon', 'ContextMenu', 'ContextMenuTrigger', 'ContextMenuContent', 'ContextMenuItem', 'ContextMenuSeparator'].map(name => [name, name]))
  }
  const render = () => {
    cursor = 0
    return vm.runInNewContext(`(() => { ${hook}; ${source.slice(start, end)}; return CronJobRunRow({ run, profileKey: 'personal', profileTintColor: '#a855f7' }) })()`, context)
  }
  render()
  sync?.()
  return render()
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const result = findNode(child, predicate)
    if (result) return result
  }
  return null
}

test('scheduled-run rows reserve arcs for unread replies and pending input', () => {
  const arc = row => findNode(row, node => node.props?.className === 'arc-border arc-row')
  assert.equal(arc(cronRow(`${base} bg-(--ui-success)`))?.props.style['--arc-c1'], 'var(--ui-success)')
  assert.equal(arc(cronRow(`${base} bg-amber-500`))?.props.style['--arc-c1'], '#ef4444')
  for (const className of [null, `${base} bg-(--ui-accent)`, background, `${base} border border-(--ui-accent)`]) {
    assert.equal(arc(cronRow(className, { is_active: true, scheduler_owned: true })), null)
  }
  const row = cronRow(`${base} bg-(--ui-success)`)
  assert.ok(findNode(row, node => Boolean(node.props?.ref)), 'scheduled status dot must be inside the observed wrapper')
})

test('scheduled-run status uses a fixed-width lead across spinner and dot states', () => {
  for (const className of [null, `${base} bg-(--ui-success)`, `${base} bg-amber-500`, `${base} bg-(--ui-accent)`]) {
    const row = cronRow(className)
    const wrapper = findNode(row, node => Boolean(node.props?.ref))
    assert.ok(wrapper)
    assert.match(wrapper.props.className, /\bsize-2\b/)
  }
})

test('Bot Chat status has a fixed lead for both live dots and its fallback icon', () => {
  const start = source.indexOf('  const botChatRow = jsx(')
  const end = source.indexOf('  const cronJobs =', start)
  assert.ok(start >= 0 && end > start)
  const element = (type, props) => ({ type, props })
  for (const canonicalTipId of ['bot-session', null]) {
    const row = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return botChatRow })()`, {
      jsx: element,
      jsxs: element,
      RowButton: 'RowButton',
      SidebarRowLead: 'SidebarRowLead',
      SessionStatusDot: () => null,
      Codicon: 'Codicon',
      canonicalTipId,
      botDotState: 'idle',
      botDotWrapRef: { current: null },
      tintColor: null,
      isBotChatSelected: false,
      displayName: 'Personal',
      openBotChat: () => {},
      cn: (...classes) => classes.filter(Boolean).join(' ')
    })
    const lead = findNode(row, node => node.type === 'SidebarRowLead')
    assert.ok(lead, 'Bot Chat needs the same fixed lead box as session rows')
    assert.match(lead.props.className, /\bsize-4\b/)
    assert.equal(lead.props.children.props.children.props.storedSessionId ?? null, canonicalTipId)
  }
})

test('Bot Chat renders semantic action arcs around its observed status dot', () => {
  const start = source.indexOf('  const botChatRow = jsx(')
  const end = source.indexOf('  const cronJobs =', start)
  const element = (type, props) => ({ type, props })
  for (const botDotState of ['unread', 'needs-input', 'working', 'stalled', 'background', 'idle']) {
    const row = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return botChatRow })()`, {
      jsx: element, jsxs: element,
      RowButton: 'RowButton', SidebarRowLead: 'SidebarRowLead', SessionStatusDot: () => null, Codicon: 'Codicon',
      canonicalTipId: 'bot-tip', botDotState, botDotWrapRef: { current: null },
      tintColor: null, isBotChatSelected: false, displayName: 'Personal', openBotChat: () => {},
      cn: (...classes) => classes.filter(Boolean).join(' ')
    })
    const arc = findNode(row, node => node.props?.className === 'arc-border arc-row')
    if (botDotState === 'unread' || botDotState === 'needs-input') {
      assert.equal(arc?.props.style['--arc-c1'], botDotState === 'unread' ? 'var(--ui-success)' : '#ef4444')
    } else {
      assert.equal(arc, null)
    }
    assert.ok(findNode(row, node => Boolean(node.props?.ref)), 'Bot Chat dot must be observed')
  }
  assert.match(source, /useSessionDotState\(canonicalTipId, isOpen\)/)
})

test('expanding a collapsed profile reattaches the Bot Chat dot observer', () => {
  let dependencies
  vm.runInNewContext(`${hook}; useSessionDotState('bot-tip', false)`, {
    useRef: () => ({ current: null }),
    useState: () => ['idle', () => {}],
    useEffect: (_effect, deps) => { dependencies = Array.from(deps) }
  })
  assert.deepEqual(dependencies, ['bot-tip', false])
  assert.match(source, /useSessionDotState\(canonicalTipId, isOpen\)/)
})

test('pending input retains its red status dot', () => {
  const css = source.match(/dotStyle\.textContent = `([\s\S]+?)`/)[1]
  const rule = css.match(/span\[role="status"\]\[class\*="bg-amber-500"\]\s*\{([^}]+)\}/)
  assert.ok(rule)
  assert.match(rule[1], /background-color:\s*#ef4444\s*!important/)
})

test('a done marker only hollows the dot when the session is no longer live', () => {
  const attribute = source.match(/'data-session-done':\s*([^,]+),/)
  assert.ok(attribute)
  const doneAttribute = (isDone, liveTurn) => vm.runInNewContext(attribute[1], { isDone, liveTurn })
  assert.equal(doneAttribute(true, true), undefined)
  assert.equal(doneAttribute(true, false), '')
  assert.equal(doneAttribute(false, false), undefined)
})
