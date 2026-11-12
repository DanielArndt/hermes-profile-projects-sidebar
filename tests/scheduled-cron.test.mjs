import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

// Extract the Scheduled (Cron) helper functions slice
const startMarker = '// ── Scheduled (Cron) Helpers & Rows ──────────────────────────────────────────'
const endMarker = 'function CronJobRunRow('
const startIndex = source.indexOf(startMarker)
const endIndex = source.indexOf(endMarker, startIndex)
assert.ok(startIndex >= 0 && endIndex > startIndex, 'Scheduled helpers block must exist')
const helpersCode = source.slice(startIndex, endIndex)

const context = {
  Date,
  Math,
  String,
  Number,
  Boolean,
  Array
}

const helpers = vm.runInNewContext(
  `(() => {
    ${helpersCode}
    return { isJobRunning, jobTitle, formatCronNextRun, formatRunTime };
  })()`,
  context
)

test('jobTitle returns name, truncated prompt, or id', () => {
  assert.equal(helpers.jobTitle({ name: 'Standup (07:30)' }), 'Standup (07:30)')
  assert.equal(
    helpers.jobTitle({ prompt: 'Short prompt' }),
    'Short prompt'
  )
  assert.equal(
    helpers.jobTitle({ prompt: 'This is a very long prompt that exceeds forty characters and should be truncated properly' }),
    'This is a very long prompt that exceeds …'
  )
  assert.equal(helpers.jobTitle({ id: 'job-12345' }), 'job-12345')
  assert.equal(helpers.jobTitle(null), 'Scheduled Task')
})

test('isJobRunning identifies active/running states', () => {
  assert.equal(helpers.isJobRunning({ state: 'running' }), true)
  assert.equal(helpers.isJobRunning({ live_execution: { status: 'running' } }), true)
  assert.equal(helpers.isJobRunning({ latest_execution: { status: 'running' } }), true)
  assert.equal(helpers.isJobRunning({ state: 'scheduled' }), false)
  assert.equal(helpers.isJobRunning({ state: 'paused' }), false)
  assert.equal(helpers.isJobRunning(null), false)
})

test('formatCronNextRun formats countdown, overdue, and paused/disabled states', () => {
  const now = 1789578000000 // Fixed reference time

  // Disabled / paused
  assert.equal(helpers.formatCronNextRun({ enabled: false }, now), 'disabled')
  assert.equal(helpers.formatCronNextRun({ state: 'disabled' }, now), 'disabled')
  assert.equal(helpers.formatCronNextRun({ state: 'paused' }, now), 'paused')
  assert.equal(helpers.formatCronNextRun({ enabled: true, next_run_at: null }, now), '—')

  // In 30 minutes (30 * 60 * 1000 = 1,800,000 ms)
  const in30m = new Date(now + 30 * 60 * 1000).toISOString()
  assert.equal(helpers.formatCronNextRun({ enabled: true, next_run_at: in30m }, now), 'in 30m')

  // In 5 hours
  const in5h = new Date(now + 5 * 3600 * 1000).toISOString()
  assert.equal(helpers.formatCronNextRun({ enabled: true, next_run_at: in5h }, now), 'in 5h')

  // In 2 days
  const in2d = new Date(now + 48 * 3600 * 1000).toISOString()
  assert.equal(helpers.formatCronNextRun({ enabled: true, next_run_at: in2d }, now), 'in 2d')

  // Overdue (> 15 minutes in past)
  const overdueTime = new Date(now - 20 * 60 * 1000).toISOString()
  assert.equal(helpers.formatCronNextRun({ enabled: true, next_run_at: overdueTime }, now), 'overdue')
})

test('formatRunTime formats timestamp correctly', () => {
  assert.equal(helpers.formatRunTime(null), '—')
  assert.equal(helpers.formatRunTime(0), '—')

  const nowSec = Math.floor(Date.now() / 1000)
  const todayFormatted = helpers.formatRunTime(nowSec)
  assert.match(todayFormatted, /^Today \d{1,2}:\d{2}$/)

  // Past timestamp (e.g. 2026-09-16)
  const pastSec = Math.floor(new Date('2026-09-16T13:00:00Z').getTime() / 1000)
  const pastFormatted = helpers.formatRunTime(pastSec)
  assert.ok(pastFormatted.includes('Sep') || pastFormatted.includes('16'))
})

test('hideEmptyScheduled preference logic', () => {
  const shouldRender = (prefs, cronJobs, searchQuery = '') => {
    const showScheduled = prefs.showScheduledBucket !== false
    const hideWhenEmpty = prefs.hideEmptyScheduled === true
    return showScheduled && (cronJobs.length > 0 || (!hideWhenEmpty && !searchQuery))
  }

  // When hideEmptyScheduled is true
  assert.equal(shouldRender({ showScheduledBucket: true, hideEmptyScheduled: true }, []), false)
  assert.equal(shouldRender({ showScheduledBucket: true, hideEmptyScheduled: true }, [{ id: '1' }]), true)

  // When hideEmptyScheduled is false
  assert.equal(shouldRender({ showScheduledBucket: true, hideEmptyScheduled: false }, []), true)
  assert.equal(shouldRender({ showScheduledBucket: true, hideEmptyScheduled: false }, [{ id: '1' }]), true)

  // When showScheduledBucket is false
  assert.equal(shouldRender({ showScheduledBucket: false, hideEmptyScheduled: false }, [{ id: '1' }]), false)
})
