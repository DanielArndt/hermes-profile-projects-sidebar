import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const mutationStart = source.indexOf('async function mutateSessionHttp')
const mutationEnd = source.indexOf('\nfunction notifySidebarSessionsChanged', mutationStart)
const renameStart = source.indexOf('  const handleRenameSession = async () => {')
const renameEnd = source.indexOf('\n  const sessionWithColor', renameStart)
assert.ok(mutationStart >= 0 && mutationEnd > mutationStart)
assert.ok(renameStart >= 0 && renameEnd > renameStart)
const mutationLogic = source.slice(mutationStart, mutationEnd)
const renameLogic = source.slice(renameStart, renameEnd)

function renameHarness({ profileKey = 'personal', renameValue = '  New title  ', title = 'Old title' } = {}) {
  const calls = []
  const notifications = []
  const errors = []
  const renamingStates = []
  let open = true
  let refreshed = 0
  let sessionsChanged = 0

  const context = {
    Date,
    Math,
    URLSearchParams,
    crypto: { randomUUID: () => 'request-1' },
    encodeURIComponent,
    host: {
      notify: notification => notifications.push(notification),
      notifyError: (error, message) => errors.push({ error, message })
    },
    notifySidebarSessionsChanged: () => {
      sessionsChanged += 1
    },
    onRefresh: () => {
      refreshed += 1
    },
    profileKey,
    renameValue,
    renaming: false,
    session: { id: 'session/1' },
    setRenameOpen: value => {
      open = value
    },
    setRenaming: value => renamingStates.push(value),
    title,
    window: {
      hermesDesktop: {
        api: async request => {
          calls.push(request)
          if (request.method === 'PATCH') return { ok: true, title: request.body.title }
          return { exists: true, runtime_generation: 3, runtime_revision: 7 }
        }
      }
    }
  }
  context.mutateSessionHttp = vm.runInNewContext(
    `(() => { ${mutationLogic}; return mutateSessionHttp })()`,
    context
  )
  const handleRenameSession = vm.runInNewContext(
    `(() => { ${renameLogic}; return handleRenameSession })()`,
    context
  )

  return {
    calls,
    errors,
    handleRenameSession,
    notifications,
    open: () => open,
    refreshed: () => refreshed,
    renamingStates,
    sessionsChanged: () => sessionsChanged
  }
}

test('session context menu includes a rename action and dialog', () => {
  assert.match(source, /children: 'Rename session…'/)
  assert.match(source, /jsx\(DialogTitle, \{ children: 'Rename session' \}\)/)
  assert.match(source, /onCloseAutoFocus: event => \{[\s\S]*?suppressCloseFocusRef\.current/)
})

test('rename trims the title and sends a fenced write to the owning profile', async () => {
  const harness = renameHarness()
  await harness.handleRenameSession()

  assert.equal(harness.calls.length, 2)
  assert.deepEqual({ ...harness.calls[0] }, {
    path: '/api/sessions/session%2F1/mutation-snapshot?profile=personal',
    profile: 'personal'
  })
  assert.equal(harness.calls[1].method, 'PATCH')
  assert.equal(harness.calls[1].path, '/api/sessions/session%2F1')
  assert.equal(harness.calls[1].profile, 'personal')
  assert.deepEqual({ ...harness.calls[1].body }, {
    expected_generation: 3,
    expected_revision: 7,
    profile: 'personal',
    request_id: 'request-1',
    title: 'New title'
  })
  assert.deepEqual(harness.renamingStates, [true, false])
  assert.equal(harness.open(), false)
  assert.equal(harness.refreshed(), 1)
  assert.equal(harness.sessionsChanged(), 1)
  assert.equal(harness.notifications[0].message, 'Chat renamed')
  assert.equal(harness.errors.length, 0)
})

test('rename can clear a custom title', async () => {
  const harness = renameHarness({ renameValue: '   ' })
  await harness.handleRenameSession()

  assert.equal(harness.calls[1].body.title, '')
  assert.equal(harness.open(), false)
})

test('an unchanged title closes without writing', async () => {
  const harness = renameHarness({ renameValue: '  Old title  ' })
  await harness.handleRenameSession()

  assert.equal(harness.calls.length, 0)
  assert.deepEqual(harness.renamingStates, [])
  assert.equal(harness.open(), false)
  assert.equal(harness.refreshed(), 0)
  assert.equal(harness.sessionsChanged(), 0)
})
