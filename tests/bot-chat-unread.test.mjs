import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function atom(value) {
  const listeners = new Set()
  return {
    get: () => value,
    set: next => { value = next; for (const fn of listeners) fn(next) },
    listen: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    listeners
  }
}

function harness(store = new Map()) {
  const start = source.indexOf('function installBotChatActivityTracker(')
  const end = source.indexOf('\nfunction isCanonicalBotChatRow', start)
  assert.ok(start >= 0 && end > start, 'plugin-wide Bot Chat activity tracker is missing')
  const events = new Map()
  const intervals = new Map()
  const disposals = []
  const marked = []
  const acked = []
  const forgotten = []
  const requests = []
  const state = {
    gateway: atom('open'), connectionId: atom('local'),
    focusedStoredSessionId: atom(null), focusedSessionProfile: atom('default'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' })
  }
  let profiles = []
  let error = null
  let storageError = false
  let storageReadError = false
  let requestGate = null
  const ctx = {
    storage: {
      get: (key, fallback) => {
        if (storageReadError) throw new Error('storage unavailable')
        return store.has(key) ? store.get(key) : fallback
      },
      set: (key, value) => {
        if (storageError) throw new Error('storage unavailable')
        store.set(key, structuredClone(value))
      }
    },
    onDispose: fn => disposals.push(fn)
  }
  const context = {
    host: { state, request: async (method, params) => {
      requests.push({ method, params })
      if (error) throw error
      const snapshot = profiles
      if (requestGate) await requestGate
      return { profiles: snapshot }
    } },
    window: {
      setInterval: (fn, ms) => { intervals.set(fn, ms); return fn },
      clearInterval: fn => intervals.delete(fn),
      addEventListener: (name, fn) => events.set(name, fn),
      removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name) }
    },
    markSessionUnreadFinished: (...args) => marked.push(args),
    ackStoredSessionId: (...args) => acked.push(args),
    forgetSessionUnread: (...args) => forgotten.push(JSON.parse(JSON.stringify(args))),
    normalizeProfile: value => value || 'default',
    ctx,
    Date: class extends Date { static now() { return 250_000 } }
  }
  vm.runInNewContext(`${source.slice(start, end)}; installBotChatActivityTracker(ctx)`, context)
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return {
    state, marked, acked, forgotten, requests, intervals, events, store, flush,
    profiles: value => { profiles = value },
    error: value => { error = value },
    failStorage: value => { storageError = value },
    failStorageRead: value => { storageReadError = value },
    gate: value => { requestGate = value },
    poll: async () => { await flush(); for (const fn of intervals.keys()) fn(); await flush() },
    dispose: () => { for (const fn of disposals) fn() }
  }
}

const bot = (last_active, extra = {}) => ({
  name: 'default', canonical_session: { id: 'bot-root', resolved_id: 'bot-tip', last_active, ...extra }
})

test('background poll marks canonical deliveries without mounting a sidebar pane', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  assert.deepEqual(h.marked, [], 'first sight seeds history')
  h.profiles([bot(200)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
  assert.equal(h.requests[0].method, 'profiles.list')
  assert.equal(h.requests[0].params.include_sessions, true)
  assert.match(source, /register\(ctx\) \{\s*installBotChatActivityTracker\(ctx\)/)
})

test('unchanged activity does not re-arm unread after core clears it', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.profiles([bot(200)])
  await h.poll()
  h.marked.length = 0
  await h.poll()
  assert.deepEqual(h.marked, [])
})

test('focused Bot Chat activity is acknowledged, and new activity after leaving still badges', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.state.focusedStoredSessionId.set('bot-root')
  h.profiles([bot(200)])
  await h.poll()
  assert.deepEqual(h.marked, [])
  assert.ok(h.acked.some(([id, profile]) => id === 'bot-tip' && profile === 'default'))
  h.state.focusedStoredSessionId.set(null)
  await h.poll()
  assert.deepEqual(h.marked, [])
  h.profiles([bot(300)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('opening then leaving between polls does not badge a delivery the user already read', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.profiles([bot(200)])
  h.state.focusedStoredSessionId.set('bot-tip')
  h.state.focusedStoredSessionId.set(null)
  await h.poll()
  assert.deepEqual(h.marked, [])
  h.profiles([bot(300)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('known canonical activity delivered while the plugin is stopped badges after restart', async () => {
  const store = new Map()
  const first = harness(store)
  first.profiles([bot(100)])
  await first.poll()
  first.dispose()
  const restarted = harness(store)
  restarted.profiles([bot(200)])
  await restarted.poll()
  assert.deepEqual(restarted.marked, [['bot-tip', 'default']])
})

test('unread delivered before shutdown is restored to the hidden chat after restart', async () => {
  const store = new Map()
  const first = harness(store)
  first.profiles([bot(100)])
  await first.poll()
  first.profiles([bot(200)])
  await first.poll()
  first.dispose()
  const restarted = harness(store)
  restarted.profiles([bot(200)])
  await restarted.poll()
  assert.deepEqual(restarted.marked, [['bot-tip', 'default']])
})

test('outstanding unread moves to a new compression tip even without newer activity', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.profiles([bot(200)])
  await h.poll()
  h.profiles([bot(200, { resolved_id: 'new-tip' })])
  await h.poll()
  assert.deepEqual(h.marked.at(-1), ['new-tip', 'default'])
  assert.deepEqual(h.forgotten, [[['bot-tip'], 'default']])
})

test('compression rotates the dot target without reseeding the root watermark', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.profiles([bot(200, { resolved_id: 'new-tip' })])
  await h.poll()
  assert.deepEqual(h.marked, [['new-tip', 'default']])
})

test('watermarks and focused suppression are profile-scoped', async () => {
  const h = harness()
  h.profiles([bot(100), { ...bot(100), name: 'personal-coder' }])
  await h.poll()
  h.state.focusedStoredSessionId.set('bot-tip')
  h.profiles([bot(200), { ...bot(200), name: 'personal-coder' }])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'personal-coder']])
})

test('connection changes do not reuse another backend watermark', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.profiles([bot(200)])
  h.state.connectionId.set('remote')
  await h.poll()
  assert.deepEqual(h.marked, [])
  h.profiles([bot(300)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('failed polls, missing canonical rows, and invalid timestamps preserve known watermarks', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.error(new Error('offline'))
  await h.poll()
  h.error(null)
  h.profiles([{ name: 'default' }, bot(NaN), bot('200'), bot(0), bot(-1)])
  await h.poll()
  assert.deepEqual(h.marked, [])
  h.profiles([bot(200)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('a same-id focused chat on another connection cannot acknowledge this backend', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.state.focusedSessionOwner.set({ connectionId: 'remote', profile: 'default' })
  h.state.focusedStoredSessionId.set('bot-tip')
  h.profiles([bot(200)])
  await h.poll()
  assert.deepEqual(h.acked, [])
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('an ahead client clock cannot suppress a newer gateway delivery', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.state.focusedStoredSessionId.set('bot-tip')
  await h.flush()
  h.state.focusedStoredSessionId.set(null)
  h.profiles([bot(101)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('unresolved focus ownership does not acknowledge a hidden chat', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.state.focusedSessionOwner.set(null)
  h.state.focusedStoredSessionId.set('bot-tip')
  h.profiles([bot(200)])
  await h.poll()
  assert.deepEqual(h.acked, [])
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('unavailable storage does not break focus acknowledgement', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.failStorage(true)
  assert.doesNotThrow(() => h.state.focusedStoredSessionId.set('bot-tip'))
  assert.ok(h.acked.some(([id]) => id === 'bot-tip'))
})

test('a failed storage write is flushed when storage recovers', async () => {
  const store = new Map()
  const h = harness(store)
  h.profiles([bot(100)])
  await h.poll()
  h.failStorage(true)
  h.failStorageRead(true)
  h.profiles([bot(200)])
  await h.poll()
  assert.equal(store.get('bot-chat-seen-activity')[JSON.stringify(['local', 'default', 'bot-root'])].activity, 100)
  h.failStorage(false)
  h.failStorageRead(false)
  h.error(new Error('offline'))
  await h.poll()
  assert.equal(store.get('bot-chat-seen-activity')[JSON.stringify(['local', 'default', 'bot-root'])].pending, true)
  const restarted = harness(store)
  restarted.profiles([bot(200)])
  await restarted.poll()
  assert.deepEqual(restarted.marked, [['bot-tip', 'default']])
})

for (const outcome of ['resolve', 'reject']) {
  test(`a disposed poll that ${outcome}s cannot restore unread after a replacement tracker acknowledges it`, async () => {
    const store = new Map()
    const key = JSON.stringify(['local', 'default', 'bot-root'])
    const old = harness(store)
    old.profiles([bot(100)])
    await old.poll()
    old.profiles([bot(200)])
    await old.poll()

    let settle
    old.gate(new Promise((resolve, reject) => {
      settle = outcome === 'resolve' ? resolve : () => reject(new Error('offline'))
    }))
    for (const tick of old.intervals.keys()) tick()
    await old.flush()
    old.dispose()

    const current = harness(store)
    current.profiles([bot(200)])
    await current.poll()
    current.state.focusedStoredSessionId.set('bot-tip')
    await current.flush()
    current.state.focusedStoredSessionId.set(null)
    await current.flush()
    assert.equal(store.get('bot-chat-seen-activity')[key].pending, false)

    settle()
    await old.flush()
    assert.equal(store.get('bot-chat-seen-activity')[key].pending, false,
      'a late poll from the disposed tracker must preserve the read receipt')
    current.dispose()

    const reloaded = harness(store)
    reloaded.profiles([bot(200)])
    await reloaded.poll()
    assert.deepEqual(reloaded.marked, [], 'unchanged read activity must stay read after reload')
    reloaded.dispose()
  })
}

test('a stale roster response is discarded across a disconnect and same-id reconnect', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  let release
  h.gate(new Promise(resolve => { release = resolve }))
  h.profiles([bot(200)])
  for (const tick of h.intervals.keys()) tick()
  await h.flush()
  h.state.connectionId.set('remote')
  h.profiles([bot(100)])
  h.state.connectionId.set('local')
  release()
  await h.flush()
  await h.flush()
  assert.deepEqual(h.marked, [])
  h.gate(null)
  h.profiles([bot(300)])
  await h.poll()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
})

test('wake and reconnect trigger a poll, and disposal removes all listeners', async () => {
  const h = harness()
  h.profiles([bot(100)])
  await h.poll()
  h.state.gateway.set('closed')
  h.profiles([bot(200)])
  const before = h.requests.length
  await h.poll()
  assert.equal(h.requests.length, before)
  h.state.gateway.set('open')
  await h.flush()
  assert.deepEqual(h.marked, [['bot-tip', 'default']])
  h.profiles([bot(300)])
  h.events.get('focus')?.()
  await h.flush()
  assert.equal(h.marked.length, 2)
  h.dispose()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.events.size, 0)
  for (const state of Object.values(h.state)) assert.equal(state.listeners.size, 0)
})
