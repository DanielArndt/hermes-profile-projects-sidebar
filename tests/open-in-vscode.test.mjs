import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'

function launcherHarness({ exit = { code: 0, signal: '0' }, attach = true, write = true } = {}) {
  const start = source.indexOf('async function openProjectInVSCode(')
  assert.notEqual(start, -1, 'project launcher should exist')
  const end = source.indexOf('\n}\n', start)
  const calls = []
  let onExit
  const terminal = {
    start: async options => {
      calls.push(['start', options])
      return { id: 'launcher-1' }
    },
    attach: async () => attach,
    onExit: (id, callback) => {
      onExit = callback
      return () => calls.push(['unsubscribe', id])
    },
    write: async (id, command) => {
      calls.push(['write', command])
      if (write) queueMicrotask(() => onExit(exit))
      return write
    },
    dispose: async id => calls.push(['dispose', id])
  }
  const launch = vm.runInNewContext(`(${source.slice(start, end + 3)})`, {
    window: { hermesDesktop: { terminal } },
    host: { state: { connectionId: { get: () => 'connection-1' } } },
    setTimeout,
    clearTimeout
  })
  return { launch, calls }
}

test('launcher uses the selected project profile and safely quoted folder without a chat', async () => {
  const { launch, calls } = launcherHarness()
  const target = "/work/a 'folder'; $(echo unsafe)"
  await launch(target, 'other-profile')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['start', {
    connectionId: 'connection-1', cwd: target, profile: 'other-profile'
  }])
  const command = calls.find(call => call[0] === 'write')[1]
  assert.doesNotMatch(command, /nohup|&\s*$/)
  // Exercise both layers of shell quoting without launching a GUI.
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'vscode-test-'))
  try {
    writeFileSync(join(dir, 'code'), '#!/bin/sh\nprintf "%s\\\\0" "$@"\n', { mode: 0o755 })
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8', env: { PATH: dir, WAYLAND_DISPLAY: '' }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.split('\0').filter(Boolean), ['--', target])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', command]).status, 0)
  assert.ok(calls.some(call => call[0] === 'unsubscribe'))
  assert.ok(calls.some(call => call[0] === 'dispose'))
})

for (const [name, options, message] of [
  ['nonzero exit', { exit: { code: 7 } }, /code 7/],
  ['signal exit', { exit: { code: 0, signal: 15 } }, /signal 15/],
  ['attach failure', { attach: false }, /attach/],
  ['write failure', { write: false }, /write/]
]) {
  test(`launcher cleans up after ${name}`, async () => {
    const { launch, calls } = launcherHarness(options)
    await assert.rejects(launch('/work/project', 'personal'), message)
    assert.ok(calls.some(call => call[0] === 'unsubscribe'))
    assert.ok(calls.some(call => call[0] === 'dispose'))
  })
}

test('project menu handler reports launcher errors', async () => {
  const start = source.indexOf('  const handleOpenInVSCode = async () => {')
  assert.notEqual(start, -1, 'menu handler should exist')
  const end = source.indexOf('\n  const renderMenuItems', start)
  const errors = []
  const launches = []
  const error = new Error('code not found')
  const handler = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return handleOpenInVSCode })()`, {
    rootPath: '/work/project', profileKey: 'personal',
    openProjectInVSCode: async (...args) => { launches.push(args); throw error },
    host: { notifyError: (...args) => errors.push(args) }
  })
  await handler()
  assert.deepEqual(launches, [['/work/project', 'personal']])
  assert.deepEqual(errors, [[error, 'Failed to open project in VS Code']])
})

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function projectMenu(rootPath, component) {
  const start = source.indexOf('  const renderMenuItems = MenuItemComponent =>')
  const end = source.indexOf('\n  const otherProfiles', start)
  const launches = []
  const element = (type, props, key) => ({ type, props, key })
  const render = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return renderMenuItems })()`, {
    jsx: element,
    jsxs: element,
    Codicon: 'Codicon',
    rootPath,
    project: { label: 'Example', isAuto: false },
    profileKey: 'personal',
    canMoveCurrentChat: false,
    isExplicit: false,
    handleOpenInVSCode: () => launches.push(rootPath)
  })
  return { items: render(component), launches }
}

for (const component of ['DropdownMenuItem', 'ContextMenuItem']) {
  test(`${component} opens the project folder in VS Code`, () => {
    const { items, launches } = projectMenu('/work/project', component)
    const action = items.find(item => item.key === 'open-vscode')
    assert.ok(action, 'Open In VS Code action should exist')
    assert.equal(action.type, component)
    assert.equal(action.props.children.props.children[1].props.children, 'Open In VS Code')
    action.props.onSelect()
    assert.deepEqual(launches, ['/work/project'])
  })
}

test('projects without a folder omit Open In VS Code', () => {
  const { items } = projectMenu('', 'DropdownMenuItem')
  assert.equal(items.some(item => item.key === 'open-vscode'), false)
})
