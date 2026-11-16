import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const start = source.indexOf('function ProfileProjectRow(')
const end = source.indexOf('// ── Profile Section', start)

function harness(sessions, done = [], options = {}) {
  const states = []
  const effects = []
  const listeners = new Map()
  let cursor = 0
  let doneIds = new Set(done)
  const element = (type, props) => ({ type, props })
  const store = { get: () => ({}), set() {} }
  const context = {
    $expandedProjectTrees: store,
    $composerDrafts: {},
    useValue: value => value === store ? value.get() : value,
    useState: initial => {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useMemo: fn => fn(),
    useEffect: fn => { const index = cursor++; if (!effects[index]) effects[index] = fn() },
    readDoneSessions: () => new Set(doneIds),
    DONE_SESSIONS_EVENT: 'done-changed',
    window: {
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: event => listeners.delete(event)
    },
    draftId: () => 'draft',
    NO_PROJECT_ID: '__no_project__',
    projectRootCwd: () => '',
    displayPath: value => value,
    cn: (...classes) => classes.filter(Boolean).join(' '),
    jsx: element,
    jsxs: element,
    ...Object.fromEntries(['RowButton', 'ProjectGlyph', 'DisclosureCaret', 'DropdownMenu', 'Tip', 'DropdownMenuTrigger', 'Button', 'Codicon', 'DropdownMenuContent', 'DropdownMenuItem', 'ContextMenu', 'ContextMenuTrigger', 'ContextMenuContent', 'ContextMenuItem', 'ProjectSessionRow', 'ProjectDraftRow'].map(name => [name, name])),
    props: {
      project: { id: 'project', label: 'Project', previewSessions: sessions, sessionCount: sessions.length },
      profileKey: 'personal', allProfiles: [], isOpen: true,
      prefs: { previewLimit: 'all' }, ...options
    }
  }
  const render = () => {
    cursor = 0
    return vm.runInNewContext(`(() => { ${source.slice(start, end)}; return ProfileProjectRow(props) })()`, context)
  }
  return {
    render,
    changeDone: ids => { doneIds = new Set(ids); listeners.get('done-changed')?.() },
    dispose: () => effects.forEach(cleanup => cleanup?.()),
    listeners
  }
}

function nodes(node, predicate) {
  if (!node || typeof node !== 'object') return []
  const children = node.props?.children
  return [ ...(predicate(node) ? [node] : []), ...[children].flat(Infinity).flatMap(child => nodes(child, predicate)) ]
}
const rows = tree => nodes(tree, node => node.type === 'ProjectSessionRow').map(node => node.props.session.id)
const toggle = tree => nodes(tree, node => node.type === 'button' && 'aria-expanded' in node.props)[0]
const text = node => nodes(node, node => node.type === 'span').map(node => node.props.children).join('')

const sessions = [{ id: 'active' }, { id: 'done1' }, { id: 'done2' }]

test('search exposes matching finished sessions without changing the disclosure state', () => {
  const view = harness(sessions, ['done1', 'done2'], { searchQuery: 'Project' })
  assert.deepEqual(rows(view.render()), ['active', 'done1', 'done2'])
  assert.equal(toggle(view.render()), undefined)
})

test('multiple done sessions collapse behind a reversible disclosure row', () => {
  const view = harness(sessions, ['done1', 'done2'])
  let tree = view.render()
  assert.deepEqual(rows(tree), ['active'])
  assert.equal(text(toggle(tree)), 'Show 2 finished sessions')
  assert.equal(toggle(tree).props['aria-expanded'], false)
  let stopped = 0
  toggle(tree).props.onClick({ stopPropagation: () => stopped++ })
  tree = view.render()
  assert.deepEqual(rows(tree), ['active', 'done1', 'done2'])
  assert.equal(text(toggle(tree)), 'Hide 2 finished sessions')
  assert.equal(toggle(tree).props['aria-expanded'], true)
  toggle(tree).props.onClick({ stopPropagation() {} })
  assert.deepEqual(rows(view.render()), ['active'])
  assert.equal(stopped, 1)
})

test('zero or one finished session remains inline', () => {
  for (const done of [[], ['done1']]) {
    const tree = harness(sessions, done).render()
    assert.deepEqual(rows(tree), ['active', 'done1', 'done2'])
    assert.equal(toggle(tree), undefined)
  }
})

test('done marker changes update the group without remounting', () => {
  const view = harness(sessions, ['done1'])
  assert.equal(toggle(view.render()), undefined)
  view.changeDone(['done1', 'done2'])
  assert.deepEqual(rows(view.render()), ['active'])
  assert.equal(text(toggle(view.render())), 'Show 2 finished sessions')
  view.changeDone(['done2'])
  assert.deepEqual(rows(view.render()), ['active', 'done1', 'done2'])
  assert.equal(toggle(view.render()), undefined)
  view.dispose()
  assert.equal(view.listeners.size, 0)
})

test('lineage roots use the same done markers as session rows', () => {
  const tree = harness([
    { id: 'tip1', _lineage_root_id: 'root1' },
    { id: 'tip2', _lineage_root_id: 'root2' },
    { id: 'other' }
  ], ['root1', 'root2']).render()
  assert.deepEqual(rows(tree), ['other'])
  assert.equal(text(toggle(tree)), 'Show 2 finished sessions')
})

test('finished sessions do not consume the unfinished preview limit or inflate show-more counts', () => {
  const view = harness([
    { id: 'done1' }, { id: 'done2' }, { id: 'active1' }, { id: 'active2' }
  ], ['done1', 'done2'], { prefs: { previewLimit: '1' } })
  let tree = view.render()
  assert.deepEqual(rows(tree), ['active1'])
  const more = nodes(tree, node => node.type === 'button' && text(node).startsWith('Show 1 more'))
  assert.equal(more.length, 1)
  toggle(tree).props.onClick({ stopPropagation() {} })
  tree = view.render()
  assert.deepEqual(rows(tree), ['active1', 'done1', 'done2'])
  assert.equal(nodes(tree, node => node.type === 'button' && text(node).startsWith('Show 1 more')).length, 1)
})

test('an all-finished project does not show an empty-project placeholder', () => {
  const tree = harness(sessions.slice(1), ['done1', 'done2']).render()
  assert.deepEqual(rows(tree), [])
  assert.equal(text(toggle(tree)), 'Show 2 finished sessions')
  assert.equal(nodes(tree, node => node.type === 'button' && text(node).includes('No chats yet')).length, 0)
})

test('expansion is independent for each project', () => {
  const first = harness(sessions, ['done1', 'done2'])
  const second = harness(sessions, ['done1', 'done2'], { profileKey: 'other' })
  toggle(first.render()).props.onClick({ stopPropagation() {} })
  assert.equal(toggle(first.render()).props['aria-expanded'], true)
  assert.equal(toggle(second.render()).props['aria-expanded'], false)
})
