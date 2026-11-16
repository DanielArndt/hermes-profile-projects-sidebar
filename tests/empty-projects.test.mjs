import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('function ProfileProjectsSection('), source.indexOf('// ── Main Sidebar View Component'))
const sort = source.slice(source.indexOf('function sortProfileProjects('), source.indexOf('// ── Dialogs'))

function harness(projects, options = {}) {
  const states = []
  let cursor = 0
  const element = (type, props, key) => ({ type, props, key })
  const props = {
    profGroup: { key: 'personal', displayName: 'Personal', projects },
    allProfiles: [], isOpen: true, isProjectOpen: () => false,
    prefs: { profileTint: 'off', projectSort: 'name', showScheduledBucket: false },
    ...options
  }
  const context = {
    props,
    useMemo: fn => fn(),
    useValue: value => value,
    useState: initial => {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useSessionDotState: () => ({ dotState: 'idle' }),
    $appearanceDigest: '',
    resolveProfileTintColor: () => null,
    projectRootCwd: p => p.path || '',
    displayPath: value => value,
    cn: (...classes) => classes.filter(Boolean).join(' '),
    jsx: element, jsxs: element,
    ...Object.fromEntries(['RowButton', 'ProfileAvatarGraphic', 'DisclosureCaret', 'Tip', 'Button', 'Codicon', 'SidebarRowLead', 'ContextMenu', 'ContextMenuTrigger', 'ContextMenuContent', 'ContextMenuItem', 'ContextMenuSeparator', 'ProfileProjectRow'].map(name => [name, name]))
  }
  const render = () => {
    cursor = 0
    return vm.runInNewContext(`(() => { ${sort}; ${section}; return ProfileProjectsSection(props) })()`, context)
  }
  return { render, props }
}

function nodes(node, predicate) {
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, predicate))]
}
const rows = tree => nodes(tree, n => n.type === 'ProfileProjectRow').map(n => n.props.project.id)
const toggle = tree => nodes(tree, n => n.type === 'button' && 'aria-expanded' in n.props)[0]
const text = node => nodes(node, n => n.type === 'span').map(n => n.props.children).join('')
const projects = [
  { id: 'home', label: 'Home', isNoProject: true, sessionCount: 0 },
  { id: 'active', label: 'Active', sessionCount: 2 },
  { id: 'empty-a', label: 'Empty A', sessionCount: 0 },
  { id: 'empty-b', label: 'Empty B', sessionCount: 0 }
]

test('sessionless projects collapse behind a reversible per-profile disclosure', () => {
  const view = harness(projects)
  let tree = view.render()
  assert.deepEqual(rows(tree), ['home', 'active'])
  assert.equal(text(toggle(tree)), 'Show 2 projects without sessions')
  assert.equal(toggle(tree).props['aria-expanded'], false)
  let stopped = 0
  toggle(tree).props.onClick({ stopPropagation: () => stopped++ })
  tree = view.render()
  assert.deepEqual(rows(tree), ['home', 'active', 'empty-a', 'empty-b'])
  assert.equal(text(toggle(tree)), 'Hide 2 projects without sessions')
  assert.equal(toggle(tree).props['aria-expanded'], true)
  assert.equal(stopped, 1)
  toggle(tree).props.onClick({ stopPropagation() {} })
  assert.deepEqual(rows(view.render()), ['home', 'active'])
})

test('search reveals matching empty projects without changing expansion state', () => {
  const view = harness(projects)
  view.props.searchQuery = 'Empty A'
  assert.deepEqual(rows(view.render()), ['empty-a'])
  assert.equal(toggle(view.render()), undefined)
  view.props.searchQuery = ''
  assert.equal(toggle(view.render()).props['aria-expanded'], false)
  toggle(view.render()).props.onClick({ stopPropagation() {} })
  view.props.searchQuery = 'Personal'
  assert.deepEqual(rows(view.render()), ['home', 'active', 'empty-a', 'empty-b'])
  view.props.searchQuery = ''
  assert.equal(toggle(view.render()).props['aria-expanded'], true)
})

test('no empty group is shown when empty projects are hidden or absent', () => {
  const view = harness(projects, { prefs: { showEmptyProjects: false, showScheduledBucket: false } })
  assert.deepEqual(rows(view.render()), ['home', 'active'])
  assert.equal(toggle(view.render()), undefined)
  assert.equal(toggle(harness(projects.slice(0, 2)).render()), undefined)
})

test('a single empty project is grouped and an all-empty profile is not mistaken for no projects', () => {
  const view = harness([projects[2]])
  let tree = view.render()
  assert.deepEqual(rows(tree), [])
  assert.equal(text(toggle(tree)), 'Show 1 project without sessions')
  assert.equal(nodes(tree, n => n.key === 'empty-create').length, 0)
  toggle(tree).props.onClick({ stopPropagation() {} })
  tree = view.render()
  assert.deepEqual(rows(tree), ['empty-a'])
  assert.equal(text(toggle(tree)), 'Hide 1 project without sessions')
})

test('projects with unloaded sessions or loaded previews stay inline', () => {
  const view = harness([
    { id: 'unloaded', label: 'A', sessionCount: 3, previewSessions: [] },
    { id: 'preview', label: 'B', sessionCount: 0, previewSessions: [{ id: 'chat' }] },
    projects[2]
  ])
  assert.deepEqual(rows(view.render()), ['unloaded', 'preview'])
  assert.equal(text(toggle(view.render())), 'Show 1 project without sessions')
})

test('expansion is independent per profile and counts track session changes', () => {
  const first = harness(projects)
  const second = harness(projects, { profGroup: { key: 'other', displayName: 'Other', projects } })
  toggle(first.render()).props.onClick({ stopPropagation() {} })
  assert.equal(toggle(first.render()).props['aria-expanded'], true)
  assert.equal(toggle(second.render()).props['aria-expanded'], false)
  second.props.profGroup.projects = projects.map(p => p.id === 'empty-a' ? { ...p, sessionCount: 1 } : p)
  assert.deepEqual(rows(second.render()), ['home', 'active', 'empty-a'])
  assert.equal(text(toggle(second.render())), 'Show 1 project without sessions')
})
