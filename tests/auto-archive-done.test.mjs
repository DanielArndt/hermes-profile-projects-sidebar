import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `missing region ${startMarker}`)
  return source.slice(start, end)
}

const constants = slice('const DONE_SESSIONS_STORAGE_KEY', '\nconst COMPOSER_DRAFTS_STORAGE_KEY')
const doneStore = slice('function readDoneSessions()', '\nfunction useSessionDone')
const botChatGuard = slice('function isCanonicalBotChatRow', '\nfunction resolveExpectHistory')
const sweep = slice('function autoArchiveDoneDays', '\nfunction installAutoArchiveDone')

const NOW = Date.UTC(2026, 10, 12)
const DAY = 86_400_000
// vm results come from another realm; normalize before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value))

function storageStub() {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values
  }
}

function loadSweep(extra = {}) {
  const context = {
    Date,
    JSON,
    Math,
    Map,
    Set,
    Number,
    Object,
    Array,
    CANONICAL_CHAT_TITLE: 'Bot Chat',
    ...extra
  }
  vm.runInNewContext(
    `${constants}\n${botChatGuard}\n${sweep}\nthis.api = { sweepAutoArchiveDone, autoArchiveCandidateForRow, autoArchiveDoneDays, autoArchiveDoneOptionId, autoArchiveDoneOptionDays }`,
    context
  )
  return context.api
}

function harness({ rowsByProfile, doneIds, meta = new Map(), prefs, focusedIds, archiveError } = {}) {
  const { sweepAutoArchiveDone } = loadSweep()
  const archives = []
  const listCalls = []
  let writtenMeta = null
  const run = () =>
    sweepAutoArchiveDone({
      prefs: prefs ?? { autoArchiveDone: true, autoArchiveDoneDays: 3 },
      doneIds: new Set(doneIds),
      meta,
      profiles: Object.keys(rowsByProfile),
      focusedIds: focusedIds ?? new Set(),
      nowMs: NOW,
      listSessionsPage: async (profile, offset) => {
        listCalls.push({ profile, offset })
        const pages = rowsByProfile[profile]
        if (pages instanceof Error) throw pages
        return pages[offset] ?? { sessions: [] }
      },
      archiveSession: async candidate => {
        if (archiveError) throw new Error('mutation rejected')
        archives.push(candidate)
      },
      writeMeta: value => {
        writtenMeta = value
      }
    })
  return { run, archives, listCalls, get writtenMeta() { return writtenMeta } }
}

const idleRow = (id, extra = {}) => ({
  id,
  title: 'A chat',
  last_active: (NOW - 10 * DAY) / 1000,
  started_at: (NOW - 20 * DAY) / 1000,
  ...extra
})

test('disabled preference or no done chats skips the sweep entirely', async () => {
  const off = harness({ rowsByProfile: { default: { 0: { sessions: [idleRow('a')] } } }, doneIds: ['a'], prefs: { autoArchiveDone: false } })
  assert.deepEqual(plain(await off.run()), { skipped: true, archived: 0, candidates: [] })
  assert.equal(off.listCalls.length, 0)

  const empty = harness({ rowsByProfile: { default: { 0: { sessions: [] } } }, doneIds: [] })
  assert.equal((await empty.run()).skipped, true)
  assert.equal(empty.listCalls.length, 0)
})

test('archives a done chat idle past the threshold and records the sweep marker', async () => {
  const h = harness({ rowsByProfile: { default: { 0: { sessions: [idleRow('a')] } } }, doneIds: ['a'] })
  const result = await h.run()
  assert.equal(result.archived, 1)
  assert.deepEqual(plain(result.candidates), ['a'])
  assert.equal(h.archives[0].id, 'a')
  assert.equal(h.archives[0].profile, 'default')
  assert.equal(h.writtenMeta.get('a').autoArchivedAt, NOW)
})

test('does not archive a chat whose done marker is newer than the grace period', async () => {
  const meta = new Map([['a', { at: NOW - DAY }]])
  const h = harness({ rowsByProfile: { default: { 0: { sessions: [idleRow('a')] } } }, doneIds: ['a'], meta })
  assert.equal((await h.run()).archived, 0)
  assert.equal(h.archives.length, 0)
})

test('sub-day thresholds map to hour options and archive after that many hours', async () => {
  const { autoArchiveDoneOptionId, autoArchiveDoneOptionDays } = loadSweep()
  for (const id of ['4h', '8h', '1', '3', '7', '14', '30']) {
    assert.equal(autoArchiveDoneOptionId(autoArchiveDoneOptionDays(id)), id)
  }
  assert.equal(autoArchiveDoneOptionDays('4h'), 4 / 24)

  const HOUR = DAY / 24
  const row = idleRow('a', { last_active: (NOW - 5 * HOUR) / 1000 })
  const fourHours = harness({
    rowsByProfile: { default: { 0: { sessions: [row] } } },
    doneIds: ['a'],
    prefs: { autoArchiveDone: true, autoArchiveDoneDays: autoArchiveDoneOptionDays('4h') }
  })
  assert.equal((await fourHours.run()).archived, 1)

  const eightHours = harness({
    rowsByProfile: { default: { 0: { sessions: [row] } } },
    doneIds: ['a'],
    prefs: { autoArchiveDone: true, autoArchiveDoneDays: autoArchiveDoneOptionDays('8h') }
  })
  assert.equal((await eightHours.run()).archived, 0)
})

test('recent activity after marking done resets the idle clock', async () => {
  const meta = new Map([['a', { at: NOW - 10 * DAY }]])
  const row = idleRow('a', { last_active: (NOW - DAY) / 1000 })
  const h = harness({ rowsByProfile: { default: { 0: { sessions: [row] } } }, doneIds: ['a'], meta })
  assert.equal((await h.run()).archived, 0)
})

test('skips pinned, archived, running, focused and canonical bot chats', async () => {
  const rows = [
    idleRow('pinned', { pinned: true }),
    idleRow('archived', { archived: true }),
    idleRow('active', { is_active: true }),
    idleRow('cron', { scheduler_owned: true }),
    idleRow('focused'),
    idleRow('bot', { title: 'Bot Chat' })
  ]
  const h = harness({
    rowsByProfile: { default: { 0: { sessions: rows } } },
    doneIds: rows.map(r => r.id),
    focusedIds: new Set(['focused'])
  })
  assert.equal((await h.run()).archived, 0)
  assert.equal(h.archives.length, 0)
})

test('an already auto-archived chat is not archived again until re-marked done', async () => {
  const meta = new Map([['a', { at: NOW - 10 * DAY, autoArchivedAt: NOW - DAY }]])
  const h = harness({ rowsByProfile: { default: { 0: { sessions: [idleRow('a')] } } }, doneIds: ['a'], meta })
  assert.equal((await h.run()).archived, 0)
  assert.equal(h.writtenMeta, null)
})

test('a done lineage root archives the listed tip row', async () => {
  const row = idleRow('tip', { _lineage_root_id: 'root' })
  const h = harness({ rowsByProfile: { default: { 0: { sessions: [row] } } }, doneIds: ['root'] })
  const result = await h.run()
  assert.equal(result.archived, 1)
  assert.equal(h.archives[0].id, 'tip')
  assert.equal(h.archives[0].doneKey, 'root')
  assert.equal(h.writtenMeta.get('root').autoArchivedAt, NOW)
})

test('finds done chats in other profiles and stops looking once claimed', async () => {
  const h = harness({
    rowsByProfile: {
      default: { 0: { sessions: [idleRow('other')] } },
      work: { 0: { sessions: [idleRow('a')] } },
      third: { 0: { sessions: [] } }
    },
    doneIds: ['a']
  })
  const result = await h.run()
  assert.equal(result.archived, 1)
  assert.equal(h.archives[0].profile, 'work')
  assert.equal(h.listCalls.some(c => c.profile === 'third'), false)
})

test('an unreadable profile does not abort the sweep', async () => {
  const h = harness({
    rowsByProfile: { broken: new Error('store busy'), default: { 0: { sessions: [idleRow('a')] } } },
    doneIds: ['a']
  })
  assert.equal((await h.run()).archived, 1)
})

test('paginates until the done chat is found', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => idleRow(`filler-${i}`))
  const h = harness({
    rowsByProfile: { default: { 0: { sessions: filler }, 100: { sessions: [idleRow('a')] } } },
    doneIds: ['a']
  })
  assert.equal((await h.run()).archived, 1)
  assert.deepEqual(h.listCalls.map(c => c.offset), [0, 100])
})

test('a failed archive write leaves the marker unset so the next sweep retries', async () => {
  const h = harness({
    rowsByProfile: { default: { 0: { sessions: [idleRow('a')] } } },
    doneIds: ['a'],
    archiveError: true
  })
  const result = await h.run()
  assert.equal(result.archived, 0)
  assert.equal(h.writtenMeta, null)
})

test('marking done stamps the time and unmarking clears it', () => {
  const localStorage = storageStub()
  const events = []
  const context = {
    Date,
    JSON,
    Map,
    Set,
    Object,
    Array,
    Event: class Event {
      constructor(type) {
        this.type = type
      }
    },
    window: {
      localStorage,
      dispatchEvent: event => events.push(event.type)
    }
  }
  vm.runInNewContext(`${constants}\n${doneStore}\nthis.api = { setSessionDone, readDoneSessionMeta, readDoneSessions }`, context)
  const { setSessionDone, readDoneSessionMeta, readDoneSessions } = context.api

  setSessionDone('a', true)
  assert.equal(readDoneSessions().has('a'), true)
  const markedAt = readDoneSessionMeta().get('a').at
  assert.ok(Math.abs(Date.now() - markedAt) < 5_000)
  assert.equal(readDoneSessionMeta().get('a').autoArchivedAt, undefined)

  // Re-marking re-arms auto-archive after a previous sweep.
  localStorage.setItem(
    'hermes.plugin.projects-sidebar.doneSessionMeta',
    JSON.stringify({ a: { at: markedAt, autoArchivedAt: 1 } })
  )
  setSessionDone('a', true)
  assert.equal(readDoneSessionMeta().get('a').autoArchivedAt, undefined)

  setSessionDone('a', false)
  assert.equal(readDoneSessions().has('a'), false)
  assert.equal(readDoneSessionMeta().has('a'), false)
  assert.deepEqual(plain(events), [
    'hermes-projects-sidebar:done-changed',
    'hermes-projects-sidebar:done-changed',
    'hermes-projects-sidebar:done-changed'
  ])
})

test('corrupt metadata storage is treated as empty', () => {
  const localStorage = storageStub()
  localStorage.setItem('hermes.plugin.projects-sidebar.doneSessionMeta', 'not json')
  const context = { Date, JSON, Map, Set, Object, Array, window: { localStorage, dispatchEvent: () => {} }, Event: class {} }
  vm.runInNewContext(`${constants}\n${doneStore}\nthis.api = { readDoneSessionMeta }`, context)
  assert.equal(context.api.readDoneSessionMeta().size, 0)
})

test('autoArchiveDoneDays falls back to the default for invalid values', () => {
  const { autoArchiveDoneDays } = loadSweep()
  assert.equal(autoArchiveDoneDays({ autoArchiveDoneDays: 7 }), 7)
  assert.equal(autoArchiveDoneDays({ autoArchiveDoneDays: '14' }), 14)
  assert.equal(autoArchiveDoneDays({ autoArchiveDoneDays: 0 }), 3)
  assert.equal(autoArchiveDoneDays({ autoArchiveDoneDays: -2 }), 3)
  assert.equal(autoArchiveDoneDays({}), 3)
})
