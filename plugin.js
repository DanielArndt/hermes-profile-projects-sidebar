/**
 * Profile Projects Sidebar — adds a dedicated "Projects" view tab in the
 * Hermes Desktop sidebar (SESSIONS | BOTS | PROJECTS) that breaks down
 * workspaces first by Profile, then by Project, and then by Session.
 *
 * Capabilities:
 * - Queries every profile via `profiles.list` and resolves each profile's
 *   explicit (`projects.list`) and tree-grouped (`projects.tree`) projects
 *   and sessions over the gateway without cold-spawning secondary backends.
 * - Renders collapsible Profile headers with full profile avatars
 *   (`profiles.get_asset`, `Blobatar`, vector shapes, or monogram) and counts.
 * - Renders collapsible Project rows under each profile with custom icons,
 *   color swatches, workspace paths, session counts, and nested session rows.
 * - Supports starting a new chat in any (Profile, Project) pair, creating or
 *   editing projects per profile, transferring projects between profiles,
 *   moving sessions between projects (including Home), and live search.
 *
 * Plain ESM loaded at runtime by Hermes Desktop — uses jsx/jsxs from
 * react/jsx-runtime and imports exclusively from @hermes/plugin-sdk.
 */

import {
  atom,
  Blobatar,
  blobatarSvg,
  Button,
  cn,
  coarseElapsed,
  Codicon,
  ColorSwatches,
  compactNumber,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DisclosureCaret,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  GlyphSpinner,
  haptic,
  host,
  Input,
  KEYBINDS_AREA,
  ListRow,
  PALETTE_AREA,
  PANES_AREA,
  PROFILE_SWATCHES,
  profileColor,
  profileColorSoft,
  queryClient,
  RowButton,
  SearchField,
  SegmentedControl,
  SessionStatusDot,
  SidebarRowLead,
  Tip,
  ToggleRow,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

const ID = 'profile-projects-sidebar'
const NO_PROJECT_ID = '__no_project__'
const ALL_PROJECTS = '__all_projects__'
const CANONICAL_CHAT_TITLE = 'Bot Chat'
const PROFILE_SESSION_LIST_LIMIT = 200
const PROJECT_SCOPE_STORAGE_KEY = 'hermes.desktop.projectScope'
const WORKSPACE_CWD_STORAGE_KEY = 'hermes.desktop.workspace-cwd'
const DISMISSED_AUTO_STORAGE_KEY = 'hermes.desktop.dismissedAutoProjects'

const DEFAULT_PREFS = {
  showAutoProjects: true,
  showHomeBucket: true,
  showEmptyProfiles: true,
  showEmptyProjects: true,
  showPathsOnRows: true,
  projectSort: 'recent', // 'recent' | 'name' | 'sessions'
  previewLimit: '5', // '3' | '5' | '10' | 'all'
  shapeStyle: 'rounded', // 'rounded' | 'circle'
  profileTint: 'medium' // 'off' | 'subtle' | 'medium' | 'strong'
}

const PROJECT_ICONS = [
  'folder-library',
  'repo',
  'code',
  'terminal',
  'beaker',
  'rocket',
  'shield',
  'database',
  'globe',
  'server',
  'tools',
  'book',
  'briefcase',
  'flame',
  'Lock',
  'star'
].map(i => i.toLowerCase())

const PRIMARY_AVATAR_COLOR = '#8b5cf6'
const AVATAR_SHAPES = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']
const BLOB_KINDS = [
  'round',
  'organic',
  'boxy',
  'capsule',
  'nub',
  'cloud',
  'droplet',
  'hexagon',
  'sun',
  'triangle'
]
const BLOB_KIND_TRAIT = {
  round: 0.11,
  organic: 0.35,
  boxy: 0.54,
  capsule: 0.65,
  nub: 0.745,
  cloud: 0.825,
  droplet: 0.8875,
  hexagon: 0.9325,
  sun: 0.965,
  triangle: 0.99
}

const $avatarAssetMap = atom({})
const avatarInflight = new Set()
const $expandedProjectTrees = atom({})
const $openDialogRequest = atom(null)
const $pendingDraftTarget = atom(null)
const $appearanceDigest = atom('')
const canonicalChatFlights = new Map()

let cancelPendingWorkspaceApply = null

function normalizeProfile(name) {
  const val = String(name ?? '').trim()
  return val || 'default'
}

function titleize(slug) {
  return String(slug || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function normalizePath(raw) {
  let path = String(raw || '')
    .trim()
    .replace(/\\/g, '/')
  if (!path) return ''
  if (path.startsWith('//')) {
    path = '//' + path.slice(2).replace(/\/{2,}/g, '/')
  } else {
    path = path.replace(/\/{2,}/g, '/')
  }
  if (path.length > 1 && path.endsWith('/') && !/^[A-Za-z]:\/$/.test(path)) {
    path = path.replace(/\/+$/, '')
  }
  return path
}

function isWindowsPath(path) {
  return /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\') || path.startsWith('//')
}

function comparisonSegments(path) {
  const clean = String(path || '')
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean)
    .map(seg => seg.normalize('NFC'))
  return isWindowsPath(String(path || '')) ? clean.map(s => s.toLowerCase()) : clean
}

function isPathUnder(folder, target) {
  const f = comparisonSegments(folder)
  const t = comparisonSegments(target)
  if (!f.length || f.length > t.length) return false
  return f.every((seg, i) => seg === t[i])
}

function displayPath(raw) {
  const path = normalizePath(raw)
  if (!path) return ''
  if (path === '~' || path.startsWith('~/')) return path

  const match =
    path.match(/^(\/Users\/[^/]+)(?:\/|$)/) ||
    path.match(/^(\/home\/[^/]+)(?:\/|$)/) ||
    path.match(/^([A-Za-z]:\/Users\/[^/]+)(?:\/|$)/)

  if (!match) return path
  const home = match[1]
  if (path.length === home.length) return '~'
  return `~${path.slice(home.length)}`
}

function pathLeaf(raw) {
  const path = normalizePath(raw)
  if (!path || path === '/' || path === '~') return path
  if (/^[A-Za-z]:\/?$/.test(path)) return path.endsWith('/') ? path : `${path}/`
  const leaf = path.split('/').filter(Boolean).pop()
  return leaf || path
}

function formatCompactAge(seconds) {
  if (!seconds || typeof seconds !== 'number') return ''
  const { unit, value } = coarseElapsed(Date.now() - seconds * 1000)
  if (unit === 'second') return 'now'
  const suffix = unit === 'day' ? 'd' : unit === 'hour' ? 'h' : 'm'
  return `${value}${suffix}`
}

function readDismissedAutoProjects() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_AUTO_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDismissedAutoProjects(set) {
  try {
    window.localStorage.setItem(DISMISSED_AUTO_STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // Ignore storage errors
  }
}

function readStoredProjectScope() {
  try {
    return window.localStorage.getItem(PROJECT_SCOPE_STORAGE_KEY) || ALL_PROJECTS
  } catch {
    return ALL_PROJECTS
  }
}

function writeStoredProjectScope(projectId) {
  try {
    const val = projectId || ALL_PROJECTS
    window.localStorage.setItem(PROJECT_SCOPE_STORAGE_KEY, val)
  } catch {
    // Ignore
  }
}

function writeStoredWorkspaceCwd(cwd, profileName) {
  try {
    const clean = String(cwd || '').trim()
    const prof = normalizeProfile(profileName)
    const key =
      prof === 'default'
        ? WORKSPACE_CWD_STORAGE_KEY
        : `${WORKSPACE_CWD_STORAGE_KEY}.profile.${encodeURIComponent(prof)}`
    if (clean) {
      window.localStorage.setItem(WORKSPACE_CWD_STORAGE_KEY, clean)
      window.localStorage.setItem(key, clean)
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Ignore
  }
}

function projectRootCwd(project) {
  if (!project || project.isNoProject) return ''
  const primary = String(project.path || project.primary_path || '').trim()
  if (primary) return primary
  if (Array.isArray(project.repos)) {
    const repoWithPath = project.repos.find(r => String(r?.path || '').trim())
    if (repoWithPath) return String(repoWithPath.path).trim()
  }
  if (Array.isArray(project.folders)) {
    const primaryFolder = project.folders.find(f => f?.is_primary && String(f?.path || '').trim())
    if (primaryFolder) return String(primaryFolder.path).trim()
    const firstFolder = project.folders.find(f => String(f?.path || '').trim())
    if (firstFolder) return String(firstFolder.path).trim()
  }
  return ''
}

function collectProjectPaths(project) {
  if (!project || project.isNoProject) return []
  const paths = []
  if (project.path) paths.push(project.path)
  if (project.primary_path) paths.push(project.primary_path)
  if (Array.isArray(project.folders)) {
    for (const f of project.folders) {
      if (f?.path) paths.push(f.path)
    }
  }
  if (Array.isArray(project.repos)) {
    for (const repo of project.repos) {
      if (repo?.path) paths.push(repo.path)
      if (Array.isArray(repo?.groups)) {
        for (const group of repo.groups) {
          if (group?.path) paths.push(group.path)
        }
      }
    }
  }
  return paths.map(p => String(p || '').trim()).filter(Boolean)
}

function matchProjectForCwd(cwd, projects) {
  const target = String(cwd || '').trim()
  if (!target) return null

  let best = null
  let bestLen = -1
  let bestExplicit = false

  for (const project of projects) {
    if (!project || project.isNoProject || project.archived) continue
    const isExplicit = !project.isAuto
    const paths = collectProjectPaths(project)

    for (const p of paths) {
      if (isPathUnder(p, target)) {
        const len = comparisonSegments(p).length
        if (len > bestLen || (len === bestLen && isExplicit && !bestExplicit)) {
          bestLen = len
          best = project
          bestExplicit = isExplicit
        }
      }
    }
  }

  return best
}

function applyDraftWorkspaceCwd(targetPath, targetId, targetProfile) {
  if (typeof cancelPendingWorkspaceApply === 'function') {
    cancelPendingWorkspaceApply()
    cancelPendingWorkspaceApply = null
  }

  const cwd = String(targetPath || '').trim()
  const prof = normalizeProfile(targetProfile)
  const scopeVal = cwd
    ? targetId && targetId !== ALL_PROJECTS && targetId !== NO_PROJECT_ID
      ? targetId
      : cwd
    : NO_PROJECT_ID

  writeStoredProjectScope(scopeVal)
  writeStoredWorkspaceCwd(cwd, prof)

  let resolvedCwd = cwd
  let disposed = false
  let reapplying = false

  const apply = () => {
    if (disposed || reapplying) return
    if (host.state.activeSessionId?.get?.()) return
    reapplying = true
    try {
      if (typeof host.state.cwd?.set === 'function') {
        const current = String(host.state.cwd?.get?.() ?? '').trim()
        if (current !== resolvedCwd) {
          host.state.cwd.set(resolvedCwd)
        }
      }
      writeStoredWorkspaceCwd(resolvedCwd, prof)
      writeStoredProjectScope(scopeVal)
    } finally {
      reapplying = false
    }
  }

  apply()

  const unlisten =
    typeof host.state.cwd?.listen === 'function'
      ? host.state.cwd.listen(nextVal => {
          if (disposed || reapplying) return
          if (host.state.activeSessionId?.get?.()) return
          const trimmed = String(nextVal ?? '').trim()
          if (trimmed !== resolvedCwd) {
            apply()
          }
        })
      : null

  const timers = [0, 25, 70, 160, 350, 650].map(ms => window.setTimeout(apply, ms))
  const cleanupTimer = window.setTimeout(() => {
    if (typeof cancelPendingWorkspaceApply === 'function') {
      cancelPendingWorkspaceApply()
    }
  }, 850)

  cancelPendingWorkspaceApply = () => {
    if (disposed) return
    disposed = true
    if (typeof unlisten === 'function') unlisten()
    for (const t of timers) window.clearTimeout(t)
    window.clearTimeout(cleanupTimer)
  }

  if (!cwd) return

  void host
    .request('config.get', {
      key: 'project',
      cwd,
      profile: prof
    })
    .then(info => {
      if (disposed) return
      if (info?.cwd && typeof info.cwd === 'string' && info.cwd.trim()) {
        resolvedCwd = info.cwd.trim()
        apply()
      }
    })
    .catch(() => null)
}

function isCanonicalBotChatRow(row) {
  const rootTitle = String(row?.root_title || '').trim()
  const title = String(row?.title || '').trim()
  return rootTitle === CANONICAL_CHAT_TITLE || (!rootTitle && title === CANONICAL_CHAT_TITLE)
}

function resolveExpectHistory(summary) {
  if (typeof summary?.live_message_count === 'number' && Number.isFinite(summary.live_message_count)) {
    return summary.live_message_count > 0
  }
  if (typeof summary?.message_count === 'number' && Number.isFinite(summary.message_count)) {
    return summary.message_count > 0
  }
  return true
}

async function openProfileBotChat(profileKey, profileRow, { openTab = false } = {}) {
  const name = normalizeProfile(profileKey)
  const ownerKey = `bot:local:${name}`
  const intent = openTab ? 'tab' : 'in-place'

  $pendingDraftTarget.set(null)

  const openStored = async (storedId, summary) => {
    if (!storedId || typeof host.openSession !== 'function') return null
    await host.openSession(storedId, {
      profile: name,
      intent,
      awaitHydration: true,
      expectHistory: resolveExpectHistory(summary),
      forceResume: true,
      hydrationTimeoutMs: 60_000,
      keepAllProfilesScope: true,
      workspaceMode: 'bots',
      workspaceOwnerKey: ownerKey,
      retryHydrationTimeoutOnce: true,
      tabTitle: CANONICAL_CHAT_TITLE
    })
    return storedId
  }

  let existing = null
  try {
    const res = await host.request(
      'session.list',
      {
        profile: name,
        title: CANONICAL_CHAT_TITLE,
        limit: PROFILE_SESSION_LIST_LIMIT,
        include_hidden: true
      },
      { spawnPriority: 'foreground' }
    )
    const rows = Array.isArray(res?.sessions) ? res.sessions : []
    existing = rows.find(row => isCanonicalBotChatRow(row)) || null
  } catch {
    if (profileRow?.canonical_session?.id) {
      existing = profileRow.canonical_session
    }
  }

  if (!existing && profileRow?.canonical_session?.id) {
    existing = profileRow.canonical_session
  }

  if (existing?.id) {
    const targetSid = existing.resolved_id || existing.id
    return openStored(targetSid, existing)
  }

  const inflight = canonicalChatFlights.get(name)
  if (inflight) {
    return inflight
  }

  const createPromise = (async () => {
    const res = await host.request(
      'session.create',
      {
        profile: name,
        title: CANONICAL_CHAT_TITLE,
        hidden: true,
        follow_profile_config: true
      },
      { spawnPriority: 'foreground' }
    )
    const sid = res?.stored_session_id
    const runtime = res?.session_id

    if (runtime) {
      try {
        await host.request('session.title', {
          session_id: runtime,
          title: CANONICAL_CHAT_TITLE
        })
      } catch {
        // Ignore if already titled or unsupported
      }
    }

    if (sid && typeof host.openSession === 'function') {
      await host.openSession(sid, {
        profile: name,
        intent: openTab ? 'tab' : 'main',
        keepAllProfilesScope: false,
        workspaceMode: 'bots',
        workspaceOwnerKey: ownerKey,
        tabTitle: CANONICAL_CHAT_TITLE
      })
    }

    notifySidebarSessionsChanged()
    void queryClient.invalidateQueries({ queryKey: [ID, 'directory'] })
    return sid || null
  })().finally(() => {
    canonicalChatFlights.delete(name)
  })

  canonicalChatFlights.set(name, createPromise)
  return createPromise
}

function notifySidebarSessionsChanged() {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel('hermes:sessions')
      ch.postMessage(1)
      ch.close()
    }
  } catch {
    // Ignore
  }
}

// ── Profile Avatar Resolution ────────────────────────────────────────────────

function defaultShapeFor(name) {
  let hash = 0
  const str = String(name || 'agent')
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return AVATAR_SHAPES[hash % AVATAR_SHAPES.length]
}

function isDarkColor(color) {
  if (!color || typeof color !== 'string' || !color.startsWith('#')) {
    return false
  }
  try {
    const n = parseInt(color.slice(1), 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const b = n & 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110
  } catch {
    return false
  }
}

function isBlobShape(shape) {
  return shape === 'blobatar' || (typeof shape === 'string' && shape.startsWith('blobatar:'))
}

function parseBlobShape(shape, name) {
  const parts = typeof shape === 'string' ? shape.split(':') : []
  const seedPart = parts[1] || ''
  const kind = BLOB_KINDS.includes(parts[2]) ? parts[2] : ''
  return {
    seed: seedPart || name || 'agent',
    seedPart,
    kind
  }
}

function readLiveBotMeta(profileName, profileRow) {
  const key = normalizeProfile(profileName)
  const serverMeta =
    profileRow?.ui_meta?.['hermes-bots'] && typeof profileRow.ui_meta['hermes-bots'] === 'object'
      ? profileRow.ui_meta['hermes-bots']
      : {}

  let rosterMeta = {}
  try {
    const queries = queryClient.getQueriesData?.({ queryKey: ['hermes-bots', 'roster'] }) || []
    for (const [, data] of queries) {
      const list = Array.isArray(data?.profiles) ? data.profiles : []
      const match = list.find(p => normalizeProfile(p?.name) === key)
      if (match?.ui_meta?.['hermes-bots'] && typeof match.ui_meta['hermes-bots'] === 'object') {
        rosterMeta = { ...rosterMeta, ...match.ui_meta['hermes-bots'] }
      }
    }
  } catch {
    // Ignore query cache read errors
  }

  let localMeta = {}
  try {
    const rawV1 = window.localStorage.getItem('hermes.plugin.hermes-bots.bot-meta')
    if (rawV1) {
      const parsed = JSON.parse(rawV1)
      if (parsed && typeof parsed[key] === 'object' && parsed[key]) {
        localMeta = { ...localMeta, ...parsed[key] }
      }
    }
    const rawV2 = window.localStorage.getItem('hermes.plugin.hermes-bots.bot-meta-v2')
    if (rawV2) {
      const parsed = JSON.parse(rawV2)
      if (parsed && typeof parsed === 'object') {
        if (parsed[key] && typeof parsed[key] === 'object') {
          localMeta = { ...localMeta, ...parsed[key] }
        }
        const connId = String(host.state.connectionId?.get?.() || 'local').trim()
        if (parsed[`${connId}::${key}`] && typeof parsed[`${connId}::${key}`] === 'object') {
          localMeta = { ...localMeta, ...parsed[`${connId}::${key}`] }
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (k.endsWith(`::${key}`) && v && typeof v === 'object') {
            localMeta = { ...localMeta, ...v }
          }
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }

  return {
    ...serverMeta,
    ...rosterMeta,
    ...localMeta
  }
}

function resolveDisplayName(profileRow, fallbackName) {
  const key = normalizeProfile(profileRow?.name || fallbackName)
  const liveMeta = readLiveBotMeta(key, profileRow)
  const botTitle = String(
    liveMeta?.title ||
      profileRow?.bot_title ||
      profileRow?.ui_meta?.['hermes-bots']?.title ||
      profileRow?.title ||
      ''
  ).trim()
  if (botTitle) return botTitle

  const displayName = String(profileRow?.display_name || '').trim()
  if (displayName) return displayName

  return key === 'default' ? 'Hermes' : titleize(key)
}

function resolveAppearance(profileName, profileRow, assetUrl) {
  const key = normalizeProfile(profileName)
  const meta = readLiveBotMeta(key, profileRow)
  const isPrimary = key.toLowerCase() === 'default'
  const userCustomized = Boolean(meta?.custom || meta?.color || meta?.shape)

  if (isPrimary && !userCustomized) {
    return {
      shape: 'squircle',
      color: PRIMARY_AVATAR_COLOR,
      image: assetUrl || null
    }
  }

  const shape = meta.shape || defaultShapeFor(key)

  // The server-side avatar for a vector blobatar is a 160px raster of the face
  // as it looked when first pushed. It is never refreshed after re-randomizing
  // or locking a new seed, so it would mask the live face. Prefer the live
  // blobatar unless the user explicitly chose a photo.
  const isPhoto = meta.imageKind === 'photo' || Boolean(meta.image) || Boolean(meta.pet)
  const image = isBlobShape(shape) && !isPhoto ? null : assetUrl || null

  return {
    shape,
    color: meta.color || profileColor(key) || PRIMARY_AVATAR_COLOR,
    image
  }
}

function resolveProfileTintColor(profileName, profileRow, assetUrl) {
  const key = normalizeProfile(profileName)
  const { color } = resolveAppearance(key, profileRow, assetUrl)

  const meta = readLiveBotMeta(key, profileRow)
  if (typeof meta?.color === 'string' && meta.color.trim()) {
    return meta.color.trim()
  }

  try {
    const rawOverrides = window.localStorage.getItem('hermes.desktop.profileColors')
    if (rawOverrides) {
      const parsed = JSON.parse(rawOverrides)
      if (parsed && typeof parsed[key] === 'string' && parsed[key].trim()) {
        return parsed[key].trim()
      }
    }
  } catch {
    // Ignore storage read errors
  }

  return color || profileColor(key) || PRIMARY_AVATAR_COLOR
}

function ensureProfileAvatarAsset(profileName) {
  const key = normalizeProfile(profileName)
  const current = $avatarAssetMap.get()
  if (key in current || avatarInflight.has(key)) {
    return
  }
  if (host.state.gateway?.get?.() !== 'open') {
    return
  }

  avatarInflight.add(key)
  host
    .request('profiles.get_asset', { name: key, asset: 'avatar' })
    .then(res => {
      const url = res?.found && typeof res.data === 'string' && res.data ? res.data : null
      $avatarAssetMap.set({ ...$avatarAssetMap.get(), [key]: url })
    })
    .catch(() => {
      // Do not negative-cache transient RPC errors
    })
    .finally(() => {
      avatarInflight.delete(key)
    })
}

function StaticMathFace({ shape, color, size }) {
  const eyeFill = isDarkColor(color) ? 'rgba(232,220,195,0.95)' : 'rgba(0,0,0,0.85)'
  const hlFill = isDarkColor(color) ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)'
  const eyeY = shape === 'cloud' ? 22 : 17.5

  let bodyNode
  switch (shape) {
    case 'squircle':
      bodyNode = jsx('rect', { fill: color, height: 34, rx: 11, width: 34, x: 3, y: 3 })
      break
    case 'pill':
      bodyNode = jsx('rect', { fill: color, height: 28, rx: 14, width: 36, x: 2, y: 6 })
      break
    case 'triangle':
    case 'tetrahedron':
      bodyNode = jsx('path', {
        d: 'M20 5.5 L36 33.5 L4 33.5 Z',
        fill: color,
        stroke: color,
        strokeLinejoin: 'round',
        strokeWidth: 5
      })
      break
    case 'hexagon':
    case 'icosahedron':
    case 'dodecahedron':
      bodyNode = jsx('path', {
        d: 'M20 3.5 L34.5 11.75 L34.5 28.25 L20 36.5 L5.5 28.25 L5.5 11.75 Z',
        fill: color,
        stroke: color,
        strokeLinejoin: 'round',
        strokeWidth: 4
      })
      break
    case 'cloud':
      bodyNode = jsx('path', {
        d: 'M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z',
        fill: color
      })
      break
    case 'drop':
      bodyNode = jsx('path', {
        d: 'M20 3 C20 3 6 20 6 27 a14 13.5 0 0 0 28 0 C34 20 20 3 20 3 Z',
        fill: color
      })
      break
    default:
      bodyNode = jsx('circle', { cx: 20, cy: 20, fill: color, r: 17.5 })
      break
  }

  return jsxs('svg', {
    'aria-hidden': 'true',
    className: 'block shrink-0 overflow-visible',
    height: size,
    viewBox: '0 0 40 40',
    width: size,
    children: [
      bodyNode,
      jsxs('g', {
        children: [
          jsx('ellipse', { cx: 15.2, cy: eyeY, fill: eyeFill, rx: 2.3, ry: 2.5 }),
          jsx('ellipse', { cx: 24.8, cy: eyeY, fill: eyeFill, rx: 2.3, ry: 2.5 }),
          jsx('circle', { cx: 14.5, cy: eyeY - 0.7, fill: hlFill, r: 0.7 }),
          jsx('circle', { cx: 24.1, cy: eyeY - 0.7, fill: hlFill, r: 0.7 })
        ]
      })
    ]
  })
}

function ProfileAvatarGraphic({ profileName, profileRow, assetUrl, size = 16, shapeStyle = 'rounded' }) {
  useValue($appearanceDigest)
  const { shape, color, image } = resolveAppearance(profileName, profileRow, assetUrl)
  const radiusClass = shapeStyle === 'circle' ? 'rounded-full' : 'rounded-[24%]'

  if (image) {
    return jsx('img', {
      alt: '',
      'aria-hidden': 'true',
      className: cn('block shrink-0 object-cover', radiusClass),
      src: image,
      style: { width: size, height: size }
    })
  }

  if (isBlobShape(shape)) {
    const { seed, kind } = parseBlobShape(shape, profileName)
    const traits = kind && BLOB_KIND_TRAIT[kind] !== undefined ? { shape: BLOB_KIND_TRAIT[kind] } : undefined

    if (typeof blobatarSvg === 'function') {
      try {
        const svgMarkup = blobatarSvg(seed, { size, ...(traits ? { traits } : {}) })
        if (svgMarkup) {
          return jsx('span', {
            'aria-hidden': 'true',
            className: cn('inline-block shrink-0 overflow-hidden', radiusClass),
            dangerouslySetInnerHTML: { __html: svgMarkup },
            style: { width: size, height: size, lineHeight: 0 }
          })
        }
      } catch {
        // Fall through
      }
    }

    if (typeof Blobatar === 'function') {
      return jsx('span', {
        'aria-hidden': 'true',
        className: cn('inline-flex shrink-0 items-center justify-center overflow-hidden', radiusClass),
        style: { width: size, height: size, lineHeight: 0 },
        children: jsx(Blobatar, { name: seed, id: seed, size, ...(traits ? { traits } : {}) })
      })
    }
  }

  if (shape) {
    return jsx(StaticMathFace, { shape, color, size })
  }

  const initial = String(profileName || 'H')
    .trim()
    .charAt(0)
    .toUpperCase()

  return jsx('span', {
    'aria-hidden': 'true',
    className: cn(
      'inline-grid shrink-0 place-items-center font-semibold uppercase leading-none',
      radiusClass
    ),
    style: {
      width: size,
      height: size,
      fontSize: Math.max(8, Math.round(size * 0.55)),
      backgroundColor: profileColorSoft(color, 22),
      color
    },
    children: initial
  })
}

function ProjectGlyph({ project, size = '0.8125rem' }) {
  const color = project?.color || null
  const iconName =
    project?.icon ||
    (project?.isNoProject ? 'home' : project?.isAuto ? 'repo' : 'folder-library')

  if (color && !project?.icon && !project?.isNoProject) {
    return jsx('span', {
      'aria-hidden': 'true',
      className: 'inline-flex shrink-0 items-center justify-center',
      style: { color },
      children: jsx(Codicon, { className: 'shrink-0', name: iconName, size })
    })
  }

  return jsx(Codicon, {
    className: cn('shrink-0', !color && 'text-(--ui-text-tertiary)'),
    name: iconName,
    size,
    style: color ? { color } : undefined
  })
}

// ── Data Fetching: Profiles -> Projects -> Sessions ──────────────────────────

function extractHydratedSessions(projectNode, profileKey) {
  const byId = new Map()
  const add = s => {
    if (!s || !s.id || s.archived) return
    if (!byId.has(s.id)) {
      byId.set(s.id, { ...s, profile: profileKey })
    }
  }

  if (Array.isArray(projectNode?.previewSessions)) {
    for (const s of projectNode.previewSessions) add(s)
  }
  if (Array.isArray(projectNode?.repos)) {
    for (const repo of projectNode.repos) {
      if (Array.isArray(repo?.groups)) {
        for (const group of repo.groups) {
          if (Array.isArray(group?.sessions)) {
            for (const s of group.sessions) add(s)
          }
        }
      }
    }
  }

  return [...byId.values()].sort(
    (a, b) => (b.last_active || b.started_at || 0) - (a.last_active || a.started_at || 0)
  )
}

async function fetchProfileProjectsData(gatewayState) {
  let rawProfiles = []

  try {
    if (gatewayState === 'open') {
      const rpc = await host.request('profiles.list', { include_sessions: true })
      if (Array.isArray(rpc?.profiles) && rpc.profiles.length > 0) {
        rawProfiles = rpc.profiles
      }
    }
  } catch {
    // Fall through to host.profiles.list()
  }

  if (rawProfiles.length === 0) {
    try {
      const res = await host.profiles.list()
      if (Array.isArray(res?.profiles)) {
        rawProfiles = res.profiles
      }
    } catch {
      // Ignore
    }
  }

  if (rawProfiles.length === 0) {
    rawProfiles = [{ name: 'default', is_default: true }]
  }

  for (const p of rawProfiles) {
    if (p?.has_avatar) {
      ensureProfileAvatarAsset(normalizeProfile(p.name))
    }
  }

  const sortedProfiles = [...rawProfiles].sort((a, b) => {
    const aDef = Boolean(a?.is_default || normalizeProfile(a?.name) === 'default')
    const bDef = Boolean(b?.is_default || normalizeProfile(b?.name) === 'default')
    if (aDef !== bDef) return aDef ? -1 : 1
    return resolveDisplayName(a, a?.name).localeCompare(resolveDisplayName(b, b?.name))
  })

  if (gatewayState !== 'open') {
    return sortedProfiles.map(p => {
      const key = normalizeProfile(p.name)
      return {
        key,
        displayName: resolveDisplayName(p, key),
        profileRow: p,
        activeId: null,
        projects: [],
        explicitCount: 0,
        totalSessions: 0,
        totalTokens: 0,
        totalCostUsd: 0
      }
    })
  }

  const dismissed = readDismissedAutoProjects()

  const perProfile = await Promise.all(
    sortedProfiles.map(async profileRow => {
      const key = normalizeProfile(profileRow.name)
      const [treeRes, listRes] = await Promise.all([
        host
          .request('projects.tree', { profile: key, preview_limit: 40 })
          .catch(() => null),
        host
          .request('projects.list', { profile: key })
          .catch(() => null)
      ])

      const explicitById = new Map()
      if (Array.isArray(listRes?.projects)) {
        for (const p of listRes.projects) {
          if (p && p.id && !p.archived) {
            explicitById.set(p.id, p)
          }
        }
      }

      const merged = []
      const seenIds = new Set()
      const treeNodes = Array.isArray(treeRes?.projects) ? treeRes.projects : []

      for (const node of treeNodes) {
        if (!node || !node.id || node.archived) continue
        if (node.isAuto && dismissed.has(node.id)) continue
        // Auto-discovered repos without sessions in this profile are disk-scan
        // entries rather than profile-owned work; filter them out to match core.
        if (node.isAuto && !node.isNoProject && (node.sessionCount || 0) <= 0) {
          continue
        }
        if (!node.isNoProject && !node.isAuto && !explicitById.has(node.id)) {
          continue
        }

        const explicit = explicitById.get(node.id)
        const sessions = extractHydratedSessions(node, key)
        const rootPath =
          node.path ||
          explicit?.primary_path ||
          explicit?.folders?.[0]?.path ||
          null

        const item = {
          id: node.id,
          profile: key,
          label: node.isNoProject
            ? 'Home'
            : String(node.label || explicit?.name || pathLeaf(rootPath) || node.id),
          description: explicit?.description || null,
          path: rootPath,
          primary_path: explicit?.primary_path || rootPath,
          color: node.color ?? explicit?.color ?? null,
          icon: node.icon ?? explicit?.icon ?? null,
          isAuto: Boolean(node.isAuto),
          isNoProject: Boolean(node.isNoProject),
          sessionCount:
            typeof node.sessionCount === 'number' ? node.sessionCount : sessions.length,
          lastActive: typeof node.lastActive === 'number' ? node.lastActive : 0,
          totalTokens: typeof node.totalTokens === 'number' ? node.totalTokens : 0,
          totalCostUsd: typeof node.totalCostUsd === 'number' ? node.totalCostUsd : 0,
          repos: Array.isArray(node.repos) ? node.repos : [],
          folders: Array.isArray(explicit?.folders) ? explicit.folders : [],
          sessionIds: Array.isArray(node.sessionIds) ? node.sessionIds : [],
          previewSessions: sessions
        }

        seenIds.add(item.id)
        merged.push(item)
      }

      for (const [id, p] of explicitById.entries()) {
        if (seenIds.has(id)) continue
        const rootPath = p.primary_path || p.folders?.[0]?.path || null
        merged.push({
          id: p.id,
          profile: key,
          label: String(p.name || pathLeaf(rootPath) || p.id),
          description: p.description || null,
          path: rootPath,
          primary_path: p.primary_path || rootPath,
          color: p.color ?? null,
          icon: p.icon ?? null,
          isAuto: false,
          isNoProject: false,
          sessionCount: 0,
          lastActive: p.updated_at || p.created_at || 0,
          totalTokens: 0,
          totalCostUsd: 0,
          repos: [],
          folders: Array.isArray(p.folders) ? p.folders : [],
          sessionIds: [],
          previewSessions: []
        })
      }

      // Ensure a synthetic Home bucket exists if there are none yet
      if (!merged.some(p => p.isNoProject)) {
        merged.push({
          id: NO_PROJECT_ID,
          profile: key,
          label: 'Home',
          description: null,
          path: null,
          primary_path: null,
          color: null,
          icon: 'home',
          isAuto: false,
          isNoProject: true,
          sessionCount: 0,
          lastActive: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          repos: [],
          folders: [],
          sessionIds: [],
          previewSessions: []
        })
      }

      const activeId = treeRes?.active_id ?? listRes?.active_id ?? null
      const explicitCount = merged.filter(p => !p.isNoProject && !p.isAuto).length
      const totalSessions = merged.reduce((acc, p) => acc + (p.sessionCount || 0), 0)
      const totalTokens = merged.reduce((acc, p) => acc + (p.totalTokens || 0), 0)
      const totalCostUsd = merged.reduce((acc, p) => acc + (p.totalCostUsd || 0), 0)

      return {
        key,
        displayName: resolveDisplayName(profileRow, key),
        profileRow,
        activeId,
        projects: merged,
        explicitCount,
        totalSessions,
        totalTokens,
        totalCostUsd
      }
    })
  )

  return perProfile
}

function useProfileProjectsDirectory() {
  const gatewayState = useValue(host.state.gateway)

  return useQuery({
    queryKey: [ID, 'directory', gatewayState],
    queryFn: () => fetchProfileProjectsData(gatewayState),
    staleTime: 8_000,
    refetchInterval: 15_000
  })
}

function sortProfileProjects(projects, activeId, prefs) {
  const showAuto = prefs.showAutoProjects !== false
  const showHome = prefs.showHomeBucket !== false
  const showEmpty = prefs.showEmptyProjects !== false
  const sortMode = prefs.projectSort || 'recent'

  const filtered = projects.filter(p => {
    if (!p) return false
    if (p.isNoProject) {
      return Boolean(showHome)
    }
    if (p.isAuto) {
      return showAuto && (p.sessionCount || 0) > 0
    }
    if (!showEmpty && (p.sessionCount || 0) <= 0) {
      return false
    }
    return true
  })

  return [...filtered].sort((a, b) => {
    // "Home" always sits FIRST at the top of each profile's project list
    if (a.isNoProject !== b.isNoProject) return a.isNoProject ? -1 : 1

    // Explicit projects before auto-discovered repos
    if (!a.isAuto !== !b.isAuto) return a.isAuto ? 1 : -1

    const aActive = Boolean(activeId && a.id === activeId && !a.isAuto)
    const bActive = Boolean(activeId && b.id === activeId && !b.isAuto)
    if (aActive !== bActive) return aActive ? -1 : 1

    if (sortMode === 'name') {
      return String(a.label || '').localeCompare(String(b.label || ''), undefined, {
        sensitivity: 'base'
      })
    }

    if (sortMode === 'sessions') {
      const byCount = (b.sessionCount || 0) - (a.sessionCount || 0)
      if (byCount !== 0) return byCount
    }

    const byTime = (b.lastActive || 0) - (a.lastActive || 0)
    if (byTime !== 0) return byTime

    return String(a.label || '').localeCompare(String(b.label || ''), undefined, {
      sensitivity: 'base'
    })
  })
}

// ── Dialogs (Create / Edit Project, Confirm Delete) ──────────────────────────

function ProjectEditorDialog({ state, onClose, profiles, onSaved }) {
  const open = Boolean(state)
  const isEdit = state?.mode === 'edit'
  const [profile, setProfile] = useState(state?.profile || 'default')
  const [name, setName] = useState(state?.project?.label || '')
  const [folder, setFolder] = useState(state?.project?.path || '')
  const [color, setColor] = useState(state?.project?.color || null)
  const [icon, setIcon] = useState(state?.project?.icon || 'folder-library')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!state) return
    setProfile(state.profile || 'default')
    setName(state.project?.label || '')
    setFolder(state.project?.path || '')
    setColor(state.project?.color || null)
    setIcon(state.project?.icon || 'folder-library')
    setSaving(false)
  }, [state])

  const handleBrowse = async () => {
    const selectPaths = window.hermesDesktop?.selectPaths
    if (typeof selectPaths !== 'function') {
      host.notify({
        kind: 'warning',
        message: 'Native folder picker is unavailable in this environment.'
      })
      return
    }
    try {
      const picked = await selectPaths({
        directories: true,
        multiple: false,
        profile
      })
      const chosen = Array.isArray(picked) && picked[0] ? String(picked[0]).trim() : ''
      if (chosen) {
        setFolder(chosen)
        if (!name.trim()) {
          setName(pathLeaf(chosen) || chosen)
        }
      }
    } catch (err) {
      host.notifyError?.(err, 'Failed to pick folder')
    }
  }

  const handleSubmit = async event => {
    event?.preventDefault?.()
    if (saving) return

    const trimmedName = name.trim() || pathLeaf(folder) || ''
    const trimmedFolder = folder.trim()

    if (!trimmedName) {
      host.notify({ kind: 'warning', message: 'Please enter a project name.' })
      return
    }
    if (!isEdit && !trimmedFolder) {
      host.notify({ kind: 'warning', message: 'Please choose a project folder.' })
      return
    }

    setSaving(true)
    try {
      const targetProf = normalizeProfile(profile)
      if (isEdit && state?.project?.id) {
        const sourceProf = normalizeProfile(state.profile)
        const pid = state.project.id

        if (sourceProf !== targetProf) {
          // Transfer project to the newly selected profile
          const foldersToCopy =
            Array.isArray(state.project.folders) && state.project.folders.length > 0
              ? state.project.folders.map(f => f.path).filter(Boolean)
              : trimmedFolder
                ? [trimmedFolder]
                : []
          if (trimmedFolder && !foldersToCopy.includes(trimmedFolder)) {
            foldersToCopy.unshift(trimmedFolder)
          }

          await host.request('projects.create', {
            name: trimmedName,
            folders: foldersToCopy,
            primary_path: trimmedFolder || state.project.path || undefined,
            color: color || null,
            icon: icon || null,
            use: true,
            profile: targetProf
          })
          await host.request('projects.delete', {
            id: pid,
            profile: sourceProf
          })
          host.notify({
            durationMs: 2_500,
            kind: 'success',
            message: `Moved "${trimmedName}" to ${targetProf}`
          })
        } else {
          await host.request('projects.update', {
            id: pid,
            name: trimmedName,
            color: color || null,
            icon: icon || null,
            profile: targetProf
          })
          if (trimmedFolder && trimmedFolder !== state.project.path) {
            await host
              .request('projects.add_folder', {
                id: pid,
                path: trimmedFolder,
                is_primary: true,
                profile: targetProf
              })
              .catch(() => null)
            await host
              .request('projects.set_primary', {
                id: pid,
                path: trimmedFolder,
                profile: targetProf
              })
              .catch(() => null)
          }
          host.notify({
            durationMs: 2_000,
            kind: 'success',
            message: `Updated project "${trimmedName}"`
          })
        }
      } else {
        await host.request('projects.create', {
          name: trimmedName,
          folders: [trimmedFolder],
          primary_path: trimmedFolder,
          color: color || null,
          icon: icon || null,
          use: true,
          profile: targetProf
        })
        host.notify({
          durationMs: 2_000,
          kind: 'success',
          message: `Created project "${trimmedName}" in ${targetProf}`
        })
      }

      onSaved?.(targetProf)
      onClose()
    } catch (err) {
      host.notifyError?.(err, isEdit ? 'Failed to update project' : 'Failed to create project')
    } finally {
      setSaving(false)
    }
  }

  return jsx(Dialog, {
    open,
    onOpenChange: nextOpen => {
      if (!nextOpen) onClose()
    },
    children: jsx(DialogContent, {
      className: 'sm:max-w-md',
      children: jsxs('form', {
        onSubmit: handleSubmit,
        className: 'flex flex-col gap-4',
        children: [
          jsxs(DialogHeader, {
            children: [
              jsx(DialogTitle, {
                children: isEdit ? 'Edit Project' : 'New Project'
              }),
              jsx(DialogDescription, {
                children: isEdit
                  ? 'Update project name, appearance, workspace folder, or owning profile.'
                  : 'Create a project workspace scoped to a specific Hermes profile.'
              })
            ]
          }),
          jsxs('div', {
            className: 'flex flex-col gap-3',
            children: [
              // Profile selector
              jsxs('div', {
                className: 'flex flex-col gap-1.5',
                children: [
                  jsx('label', {
                    className: 'text-xs font-medium text-(--ui-text-secondary)',
                    children: 'Owning Profile'
                  }),
                  jsx('div', {
                    className: 'flex flex-wrap gap-1.5',
                    children: profiles.map(prof => {
                      const selected = prof.key === normalizeProfile(profile)
                      return jsx(
                        Button,
                        {
                          type: 'button',
                          size: 'sm',
                          variant: selected ? 'secondary' : 'ghost',
                          className: cn(
                            'h-7 gap-1.5 px-2.5 text-xs',
                            selected &&
                              'border border-(--ui-stroke-secondary) bg-(--ui-control-active-background) font-medium text-foreground'
                          ),
                          onClick: () => setProfile(prof.key),
                          children: jsxs('span', {
                            className: 'flex items-center gap-1.5',
                            children: [
                              jsx(ProfileAvatarGraphic, {
                                profileName: prof.key,
                                profileRow: prof.profileRow,
                                assetUrl: $avatarAssetMap.get()[prof.key] || null,
                                size: 14,
                                shapeStyle: 'rounded'
                              }),
                              jsx('span', { children: prof.displayName })
                            ]
                          })
                        },
                        prof.key
                      )
                    })
                  })
                ]
              }),
              // Folder path
              jsxs('div', {
                className: 'flex flex-col gap-1.5',
                children: [
                  jsx('label', {
                    className: 'text-xs font-medium text-(--ui-text-secondary)',
                    children: 'Workspace Folder'
                  }),
                  jsxs('div', {
                    className: 'flex items-center gap-1.5',
                    children: [
                      jsx(Input, {
                        value: folder,
                        onChange: e => {
                          const val = e.target.value
                          setFolder(val)
                          if (!isEdit && !name.trim() && val.trim()) {
                            setName(pathLeaf(val.trim()))
                          }
                        },
                        placeholder: '/path/to/workspace',
                        className: 'flex-1 font-mono text-xs'
                      }),
                      jsx(Button, {
                        type: 'button',
                        variant: 'secondary',
                        size: 'sm',
                        onClick: () => void handleBrowse(),
                        children: jsxs('span', {
                          className: 'flex items-center gap-1.5',
                          children: [
                            jsx(Codicon, { name: 'folder-opened', size: '0.8rem' }),
                            jsx('span', { children: 'Browse…' })
                          ]
                        })
                      })
                    ]
                  })
                ]
              }),
              // Project name
              jsxs('div', {
                className: 'flex flex-col gap-1.5',
                children: [
                  jsx('label', {
                    className: 'text-xs font-medium text-(--ui-text-secondary)',
                    children: 'Project Name'
                  }),
                  jsx(Input, {
                    value: name,
                    onChange: e => setName(e.target.value),
                    placeholder: 'My Project',
                    autoFocus: true,
                    maxLength: 100,
                    className: 'text-xs'
                  })
                ]
              }),
              // Icon selector
              jsxs('div', {
                className: 'flex flex-col gap-1.5',
                children: [
                  jsx('label', {
                    className: 'text-xs font-medium text-(--ui-text-secondary)',
                    children: 'Icon'
                  }),
                  jsx('div', {
                    className: 'flex flex-wrap gap-1',
                    children: PROJECT_ICONS.map(ic => {
                      const active = (icon || 'folder-library') === ic
                      return jsx(
                        Button,
                        {
                          type: 'button',
                          size: 'icon-xs',
                          variant: active ? 'secondary' : 'ghost',
                          className: cn(
                            'size-7 rounded-md',
                            active &&
                              'border border-(--ui-stroke-secondary) bg-(--ui-control-active-background) text-foreground'
                          ),
                          onClick: () => setIcon(ic),
                          children: jsx(Codicon, {
                            name: ic,
                            size: '0.875rem',
                            style: color ? { color } : undefined
                          })
                        },
                        ic
                      )
                    })
                  })
                ]
              }),
              // Color swatches
              typeof ColorSwatches === 'function' &&
                Array.isArray(PROFILE_SWATCHES) &&
                jsxs('div', {
                  className: 'flex flex-col gap-1.5',
                  children: [
                    jsx('label', {
                      className: 'text-xs font-medium text-(--ui-text-secondary)',
                      children: 'Color'
                    }),
                    jsx(ColorSwatches, {
                      swatches: PROFILE_SWATCHES,
                      value: color,
                      clearLabel: 'Default color',
                      onChange: nextColor => setColor(nextColor || null)
                    })
                  ]
                })
            ]
          }),
          jsxs(DialogFooter, {
            children: [
              jsx(Button, {
                type: 'button',
                variant: 'ghost',
                onClick: onClose,
                children: 'Cancel'
              }),
              jsx(Button, {
                type: 'submit',
                disabled: saving,
                children: saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Project'
              })
            ]
          })
        ]
      })
    })
  })
}

// ── Session Row inside a Project ─────────────────────────────────────────────

function ProjectSessionRow({
  session,
  profileKey,
  projectColor,
  profileTintColor,
  isSelected,
  siblingProjects,
  onRefresh
}) {
  const title =
    String(session.title || '').trim() ||
    String(session.preview || '')
      .replace(/\s+/g, ' ')
      .trim() ||
    'Untitled chat'
  const age = formatCompactAge(session.last_active || session.started_at)

  const handleOpen = event => {
    haptic('selection')
    if (event?.shiftKey && !event?.altKey && !event?.metaKey && !event?.ctrlKey) {
      const pinId = session._lineage_root_id || session.id
      host.sessions?.pin?.(pinId, true)
      host.notify({ durationMs: 1_800, kind: 'info', message: 'Pinned chat' })
      return
    }
    const inTab = Boolean(event?.metaKey || event?.ctrlKey || event?.button === 1)
    void host.openSession(session.id, {
      profile: profileKey,
      intent: inTab ? 'tab' : 'in-place'
    })
  }

  const handleMoveSessionToProject = async targetProject => {
    const isHome = Boolean(targetProject?.isNoProject || targetProject?.id === NO_PROJECT_ID)
    const targetCwd = isHome ? '~' : projectRootCwd(targetProject)
    if (!targetCwd) return

    haptic('selection')
    try {
      await host.request('session.workspace.move', {
        session_key: session._lineage_root_id || session.id,
        cwd: targetCwd,
        profile: profileKey
      })
      notifySidebarSessionsChanged()
      onRefresh?.()
      host.notify({
        durationMs: 2_000,
        kind: 'info',
        message: `Moved chat to ${isHome ? 'Home' : targetProject.label}`
      })
    } catch (err) {
      host.notifyError?.(err, 'Failed to move chat to project')
    }
  }

  const [archivedOptimistic, setArchivedOptimistic] = useState(false)

  const handleArchiveSession = async event => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    haptic('selection')
    const targetId = session.id
    const owner = profileKey && profileKey !== 'default' ? profileKey : null
    setArchivedOptimistic(true)
    if (isSelected) {
      host.newChat?.(profileKey)
    }
    try {
      const api = window.hermesDesktop?.api
      if (api) {
        await api({
          ...(owner ? { profile: owner } : {}),
          path: `/api/sessions/${encodeURIComponent(targetId)}`,
          method: 'PATCH',
          body: { archived: true, ...(owner ? { profile: owner } : {}) }
        })
      } else {
        await host.request('session.archive', {
          session_id: targetId,
          archived: true,
          ...(owner ? { profile: owner } : {})
        })
      }
      notifySidebarSessionsChanged()
      onRefresh?.()
      host.notify({
        action: {
          label: 'Undo',
          onClick: () => void handleUndoArchive(targetId, owner)
        },
        durationMs: 6_000,
        kind: 'success',
        message: 'Chat archived'
      })
    } catch (err) {
      setArchivedOptimistic(false)
      host.notifyError?.(err, 'Failed to archive chat')
    }
  }

  // Not tied to row state: the row may have unmounted by the time Undo is clicked.
  const handleUndoArchive = async (targetId, owner) => {
    try {
      const api = window.hermesDesktop?.api
      if (api) {
        await api({
          ...(owner ? { profile: owner } : {}),
          path: `/api/sessions/${encodeURIComponent(targetId)}`,
          method: 'PATCH',
          body: { archived: false, ...(owner ? { profile: owner } : {}) }
        })
      } else {
        await host.request('session.archive', {
          session_id: targetId,
          archived: false,
          ...(owner ? { profile: owner } : {})
        })
      }
      setArchivedOptimistic(false)
      notifySidebarSessionsChanged()
      onRefresh?.()
      host.notify({ durationMs: 1_800, kind: 'info', message: 'Chat restored' })
    } catch (err) {
      host.notifyError?.(err, 'Failed to undo archive')
    }
  }

  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleDeleteSession = async () => {
    const targetId = session.id
    const owner = profileKey && profileKey !== 'default' ? profileKey : null
    const api = window.hermesDesktop?.api
    if (!api) throw new Error('Desktop API unavailable')
    // Scope to the owning profile in the URL as well (see host deleteSession).
    await api({
      ...(owner ? { profile: owner } : {}),
      path: `/api/sessions/${encodeURIComponent(targetId)}${owner ? `?profile=${encodeURIComponent(owner)}` : ''}`,
      method: 'DELETE'
    })
    setArchivedOptimistic(true)
    if (isSelected) {
      host.newChat?.(profileKey)
    }
    notifySidebarSessionsChanged()
    onRefresh?.()
    host.notify({ durationMs: 2_000, kind: 'success', message: 'Chat deleted' })
  }

  const sessionWithColor = useMemo(
    () => (projectColor && !session.color ? { ...session, color: projectColor } : session),
    [session, projectColor]
  )

  const dotWrapRef = useRef(null)
  const [dotState, setDotState] = useState('idle')
  const isBusy = useValue(host.state.busy)

  useEffect(() => {
    const el = dotWrapRef.current
    if (!el || typeof MutationObserver === 'undefined') return undefined

    const sync = () => {
      const statusSpan = el.querySelector('[role="status"]')
      if (!statusSpan) {
        setDotState('idle')
        return
      }
      const cls = String(statusSpan.className || '')
      if (cls.includes('bg-amber-500')) {
        setDotState('needs-input')
      } else if (cls.includes('border-(--ui-accent)')) {
        setDotState('stalled')
      } else if (cls.includes('bg-(--ui-accent)')) {
        setDotState('working')
      } else {
        setDotState('idle')
      }
    }

    sync()
    const obs = new MutationObserver(sync)
    obs.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'role']
    })
    return () => obs.disconnect()
  }, [session.id])

  const showsArc =
    dotState === 'working' || Boolean(session.running) || Boolean(isSelected && isBusy)
  const liveTurn =
    showsArc || dotState === 'needs-input' || dotState === 'stalled'

  const selectedStyle =
    isSelected && profileTintColor
      ? {
          backgroundColor: profileColorSoft(profileTintColor, 20),
          boxShadow: `inset 0 0 0 1px ${profileColorSoft(profileTintColor, 36)}`
        }
      : undefined

  const rowElement = jsxs('div', {
    'data-working': liveTurn ? 'true' : undefined,
    style: selectedStyle,
    className: cn(
      'group relative flex min-h-6 w-full items-center justify-between gap-1.5 rounded-md pr-1.5 pl-1 text-xs transition-colors duration-100',
      isSelected
        ? cn(!profileTintColor && 'bg-(--ui-control-active-background)', 'font-medium text-foreground')
        : liveTurn
          ? 'text-foreground hover:bg-(--ui-control-hover-background)'
          : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground'
    ),
    children: [
      showsArc &&
        jsx('span', {
          'aria-hidden': 'true',
          className: 'arc-border arc-row',
          style: profileTintColor ? { '--arc-c1': profileTintColor } : undefined
        }),
      jsxs(RowButton, {
        className: 'flex min-w-0 flex-1 items-center gap-1.5 bg-transparent py-1 text-left',
        onClick: handleOpen,
        onAuxClick: e => {
          if (e.button === 1) {
            e.preventDefault()
            handleOpen(e)
          }
        },
        children: [
          jsx(SidebarRowLead, {
            className: 'size-4 shrink-0',
            children: jsx('span', {
              ref: dotWrapRef,
              className: 'inline-flex items-center justify-center',
              children:
                typeof SessionStatusDot === 'function'
                  ? jsx(SessionStatusDot, {
                      storedSessionId: session.id,
                      session: sessionWithColor
                    })
                  : jsx('span', {
                      className: 'size-1.5 rounded-full bg-(--ui-text-quaternary)',
                      style: projectColor ? { backgroundColor: projectColor } : undefined
                    })
            })
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.78125rem] leading-tight',
            title,
            children: title
          })
        ]
      }),
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-0.5',
        'data-row-actions': '',
        children: [
          age &&
            jsx('span', {
              className:
                'min-w-4 pr-0.5 text-right text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
              children: age
            }),
          jsx(Tip, {
            label: 'Archive chat',
            side: 'top',
            children: jsx(Button, {
              'aria-label': 'Archive chat',
              size: 'icon-xs',
              variant: 'ghost',
              className:
                'size-5 shrink-0 rounded-[4px] text-(--ui-text-tertiary) hover:bg-(--ui-control-active-background) hover:text-foreground',
              onClick: handleArchiveSession,
              onPointerDown: e => e.stopPropagation(),
              children: jsx(Codicon, { name: 'archive', size: '0.75rem' })
            })
          })
        ]
      })
    ]
  })

  if (archivedOptimistic) {
    return null
  }

  return jsx(ContextMenu, {
    children: [
      jsx(
        ContextMenuTrigger,
        {
          asChild: true,
          children: rowElement
        },
        'trigger'
      ),
      jsxs(
        ContextMenuContent,
        {
          className: 'min-w-48',
          children: [
            jsx(ContextMenuItem, {
              onSelect: () => handleOpen({}),
              children: jsxs('span', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Codicon, { name: 'comment', size: '0.8rem' }),
                  jsx('span', { children: 'Open chat' })
                ]
              })
            }),
            jsx(ContextMenuItem, {
              onSelect: () => handleOpen({ metaKey: true }),
              children: jsxs('span', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Codicon, { name: 'split-horizontal', size: '0.8rem' }),
                  jsx('span', { children: 'Open in new tab' })
                ]
              })
            }),
            jsx(ContextMenuItem, {
              onSelect: () => {
                const pinId = session._lineage_root_id || session.id
                host.sessions?.pin?.(pinId, true)
                host.notify({ durationMs: 1_800, kind: 'info', message: 'Pinned chat' })
              },
              children: jsxs('span', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Codicon, { name: 'pinned', size: '0.8rem' }),
                  jsx('span', { children: 'Pin chat' })
                ]
              })
            }),
            Array.isArray(siblingProjects) &&
              siblingProjects.length > 1 &&
              jsxs(ContextMenuSub, {
                children: [
                  jsx(ContextMenuSubTrigger, {
                    children: jsxs('span', {
                      className: 'flex items-center gap-2',
                      children: [
                        jsx(Codicon, { name: 'folder-library', size: '0.8rem' }),
                        jsx('span', { children: 'Move to project' })
                      ]
                    })
                  }),
                  jsx(ContextMenuSubContent, {
                    className: 'min-w-44 max-h-72 overflow-y-auto',
                    children: siblingProjects.map(proj =>
                      jsx(
                        ContextMenuItem,
                        {
                          onSelect: () => void handleMoveSessionToProject(proj),
                          children: jsxs('span', {
                            className: 'flex items-center gap-2 truncate',
                            children: [
                              jsx(ProjectGlyph, { project: proj, size: '0.75rem' }),
                              jsx('span', { className: 'truncate', children: proj.label })
                            ]
                          })
                        },
                        proj.id
                      )
                    )
                  })
                ]
              }),
            jsx(ContextMenuSeparator, {}),
            jsx(ContextMenuItem, {
              onSelect: () => void handleArchiveSession(),
              children: jsxs('span', {
                className: 'flex items-center gap-2 text-(--ui-text-secondary)',
                children: [
                  jsx(Codicon, { name: 'archive', size: '0.8rem' }),
                  jsx('span', { children: 'Archive chat' })
                ]
              })
            }),
            jsx(ContextMenuItem, {
              onSelect: () => setDeleteOpen(true),
              children: jsxs('span', {
                className: 'flex items-center gap-2 text-red-500',
                children: [
                  jsx(Codicon, { name: 'trash', size: '0.8rem' }),
                  jsx('span', { children: 'Delete session…' })
                ]
              })
            })
          ]
        },
        'content'
      ),
      typeof ConfirmDialog === 'function' &&
        jsx(
          ConfirmDialog,
          {
            open: deleteOpen,
            onClose: () => setDeleteOpen(false),
            title: `Delete "${title}"?`,
            description: 'This permanently deletes the session and its messages. This cannot be undone.',
            confirmLabel: 'Delete',
            destructive: true,
            dismissOnConfirm: true,
            onConfirm: () => handleDeleteSession()
          },
          'delete-dialog'
        )
    ]
  })
}

// ── Project Row inside a Profile ─────────────────────────────────────────────

function ProfileProjectRow({
  project,
  profileKey,
  profileDisplayName,
  profileTintColor,
  profileGuideColor,
  allProfiles,
  siblingProjects,
  isOpen,
  onToggleOpen,
  isCurrentWorkspace,
  focusedStoredId,
  prefs,
  searchQuery,
  onEditProject,
  onDeleteProject,
  onStartChatInProject,
  onMoveCurrentChatHere,
  canMoveCurrentChat,
  onTransferProject,
  onRefresh,
  os
}) {
  const expandedMap = useValue($expandedProjectTrees)
  const expandKey = `${profileKey}::${project.id}`
  const hydratedTree = expandedMap[expandKey] || null
  const [hydrating, setHydrating] = useState(false)

  const rootPath = projectRootCwd(project)
  const formattedPath = rootPath ? displayPath(rootPath) : ''
  const isExplicit = !project.isNoProject && !project.isAuto

  const allSessions = useMemo(() => {
    const base = hydratedTree
      ? extractHydratedSessions(hydratedTree, profileKey)
      : project.previewSessions || []

    if (!searchQuery) return base
    const q = searchQuery.toLowerCase()
    const projMatches =
      String(project.label || '')
        .toLowerCase()
        .includes(q) ||
      formattedPath.toLowerCase().includes(q)
    if (projMatches) return base

    return base.filter(
      s =>
        String(s.title || '')
          .toLowerCase()
          .includes(q) ||
        String(s.preview || '')
          .toLowerCase()
          .includes(q) ||
        String(s.git_branch || '')
          .toLowerCase()
          .includes(q)
    )
  }, [hydratedTree, project, profileKey, searchQuery, formattedPath])

  const numericLimit =
    prefs.previewLimit === 'all' || hydratedTree || searchQuery
      ? Infinity
      : Math.max(1, parseInt(prefs.previewLimit || '5', 10) || 5)

  const visibleSessions = allSessions.slice(0, numericLimit)
  const totalCount = Math.max(project.sessionCount || 0, allSessions.length)
  const hiddenCount = Math.max(0, totalCount - visibleSessions.length)

  const handleExpandAllSessions = async event => {
    event?.stopPropagation?.()
    if (hydrating) return

    if (allSessions.length >= totalCount) {
      $expandedProjectTrees.set({
        ...$expandedProjectTrees.get(),
        [expandKey]: project
      })
      return
    }

    setHydrating(true)
    try {
      const res = await host.request('projects.project_sessions', {
        profile: profileKey,
        project_id: project.id
      })
      if (res?.project) {
        $expandedProjectTrees.set({
          ...$expandedProjectTrees.get(),
          [expandKey]: res.project
        })
      } else {
        $expandedProjectTrees.set({
          ...$expandedProjectTrees.get(),
          [expandKey]: project
        })
      }
    } catch {
      $expandedProjectTrees.set({
        ...$expandedProjectTrees.get(),
        [expandKey]: project
      })
    } finally {
      setHydrating(false)
    }
  }

  const handleDismissAutoRepo = () => {
    const set = readDismissedAutoProjects()
    set.add(project.id)
    writeDismissedAutoProjects(set)
    onRefresh?.()
    host.notify({
      durationMs: 2_500,
      kind: 'info',
      message: `Hidden auto-discovered repo "${project.label}"`
    })
  }

  const renderMenuItems = MenuItemComponent =>
    [
      jsx(
        MenuItemComponent,
        {
          onSelect: () => onStartChatInProject(profileKey, project, false),
          children: jsxs('span', {
            className: 'flex items-center gap-2',
            children: [
              jsx(Codicon, { name: 'add', size: '0.8rem' }),
              jsx('span', { children: `New chat in ${project.label}` })
            ]
          })
        },
        'new-chat'
      ),
      jsx(
        MenuItemComponent,
        {
          onSelect: () => onStartChatInProject(profileKey, project, true),
          children: jsxs('span', {
            className: 'flex items-center gap-2',
            children: [
              jsx(Codicon, { name: 'split-horizontal', size: '0.8rem' }),
              jsx('span', { children: 'New chat in current draft' })
            ]
          })
        },
        'switch-draft'
      ),
      canMoveCurrentChat &&
        jsx(
          MenuItemComponent,
          {
            onSelect: () => onMoveCurrentChatHere(profileKey, project),
            children: jsxs('span', {
              className: 'flex items-center gap-2',
              children: [
                jsx(Codicon, { name: 'arrow-right', size: '0.8rem' }),
                jsx('span', { children: 'Move current chat here' })
              ]
            })
          },
          'move-chat'
        ),
      isExplicit &&
        jsx(
          MenuItemComponent,
          {
            onSelect: () => onEditProject(profileKey, project),
            children: jsxs('span', {
              className: 'flex items-center gap-2',
              children: [
                jsx(Codicon, { name: 'edit', size: '0.8rem' }),
                jsx('span', { children: 'Edit project…' })
              ]
            })
          },
          'edit'
        ),
      rootPath &&
        jsx(
          MenuItemComponent,
          {
            onSelect: () => {
              void os?.writeClipboard?.(rootPath)
              host.notify({ durationMs: 1_800, kind: 'info', message: 'Copied folder path' })
            },
            children: jsxs('span', {
              className: 'flex items-center gap-2',
              children: [
                jsx(Codicon, { name: 'copy', size: '0.8rem' }),
                jsx('span', { children: 'Copy folder path' })
              ]
            })
          },
          'copy-path'
        ),
      rootPath &&
        jsx(
          MenuItemComponent,
          {
            onSelect: () => {
              void os?.revealPath?.(rootPath)
            },
            children: jsxs('span', {
              className: 'flex items-center gap-2',
              children: [
                jsx(Codicon, { name: 'folder-opened', size: '0.8rem' }),
                jsx('span', { children: 'Reveal in File Manager' })
              ]
            })
          },
          'reveal-path'
        ),
      isExplicit &&
        jsx(
          MenuItemComponent,
          {
            onSelect: () => onDeleteProject(profileKey, project),
            children: jsxs('span', {
              className: 'flex items-center gap-2 text-(--ui-text-secondary)',
              children: [
                jsx(Codicon, { name: 'trash', size: '0.8rem' }),
                jsx('span', { children: 'Delete project…' })
              ]
            })
          },
          'delete'
        ),
      project.isAuto &&
        jsx(
          MenuItemComponent,
          {
            onSelect: handleDismissAutoRepo,
            children: jsxs('span', {
              className: 'flex items-center gap-2 text-(--ui-text-secondary)',
              children: [
                jsx(Codicon, { name: 'eye-closed', size: '0.8rem' }),
                jsx('span', { children: 'Hide auto-discovered repo' })
              ]
            })
          },
          'dismiss-auto'
        )
    ].filter(Boolean)

  const otherProfiles = allProfiles.filter(p => p.key !== profileKey)

  const headerRow = jsxs('div', {
    style:
      isCurrentWorkspace && profileTintColor
        ? { backgroundColor: profileColorSoft(profileTintColor, 11) }
        : undefined,
    className: cn(
      'group relative flex min-h-6.5 w-full items-center justify-between gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors duration-100',
      isCurrentWorkspace
        ? cn(!profileTintColor && 'bg-(--ui-control-active-background)/70', 'text-foreground')
        : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground'
    ),
    children: [
      jsxs(RowButton, {
        'aria-expanded': isOpen,
        className: 'flex min-w-0 flex-1 items-center gap-1.5 bg-transparent py-0.5 text-left',
        onClick: () => {
          haptic('tap')
          onToggleOpen()
        },
        children: [
          jsx(ProjectGlyph, { project, size: '0.8125rem' }),
          jsxs('div', {
            className: 'flex min-w-0 flex-1 flex-col',
            children: [
              jsxs('div', {
                className: 'flex min-w-0 items-center gap-1',
                children: [
                  jsx('span', {
                    className: cn(
                      'truncate text-[0.8125rem] leading-tight',
                      isCurrentWorkspace ? 'font-semibold text-foreground' : 'font-medium'
                    ),
                    title: formattedPath ? `${project.label} (${formattedPath})` : project.label,
                    children: project.label
                  }),
                  project.isAuto &&
                    jsx('span', {
                      className:
                        'shrink-0 rounded bg-(--ui-control-active-background) px-1 py-px text-[0.5625rem] text-(--ui-text-tertiary)',
                      children: 'repo'
                    }),
                  jsx(DisclosureCaret, {
                    className:
                      'shrink-0 text-(--ui-text-tertiary) opacity-60 transition group-hover:opacity-100',
                    open: isOpen
                  })
                ]
              }),
              prefs.showPathsOnRows !== false &&
                formattedPath &&
                jsx('span', {
                  className: 'truncate font-mono text-[0.625rem] leading-tight text-(--ui-text-quaternary)',
                  children: formattedPath
                })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-0.5',
        'data-row-actions': '',
        children: [
          totalCount > 0 &&
            jsx('span', {
              className:
                'min-w-3.5 pr-0.5 text-right text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
              title: `${totalCount} chat${totalCount === 1 ? '' : 's'}`,
              children: String(totalCount)
            }),
          !project.isNoProject &&
            jsx(DropdownMenu, {
              children: [
                jsx(
                  Tip,
                  {
                    label: `Project actions (${project.label})`,
                    side: 'top',
                    children: jsx(DropdownMenuTrigger, {
                      asChild: true,
                      children: jsx(Button, {
                        'aria-label': `Project actions for ${project.label}`,
                        size: 'icon-xs',
                        variant: 'ghost',
                        className:
                          'size-5 shrink-0 rounded-[4px] text-(--ui-text-tertiary) hover:bg-(--ui-control-active-background) hover:text-foreground',
                        onClick: e => e.stopPropagation(),
                        children: jsx(Codicon, { name: 'ellipsis', size: '0.75rem' })
                      })
                    })
                  },
                  'trigger'
                ),
                jsx(
                  DropdownMenuContent,
                  {
                    align: 'end',
                    className: 'min-w-48',
                    children: renderMenuItems(DropdownMenuItem)
                  },
                  'content'
                )
              ]
            }),
          jsx(Tip, {
            label: `New session in ${project.label} (${profileDisplayName})`,
            side: 'top',
            children: jsx(Button, {
              'aria-label': `New session in ${project.label} (${profileDisplayName})`,
              size: 'icon-xs',
              variant: 'ghost',
              className:
                'size-5 shrink-0 rounded-[4px] text-(--ui-text-tertiary) hover:bg-(--ui-control-active-background) hover:text-foreground',
              onClick: e => {
                e.stopPropagation()
                onStartChatInProject(profileKey, project, false)
              },
              children: jsx(Codicon, { name: 'add', size: '0.75rem' })
            })
          })
        ]
      })
    ]
  })

  return jsxs('div', {
    className: 'flex flex-col',
    'data-profile-project': `${profileKey}:${project.id}`,
    children: [
      jsx(ContextMenu, {
        children: [
          jsx(
            ContextMenuTrigger,
            {
              asChild: true,
              children: headerRow
            },
            'trigger'
          ),
          jsxs(
            ContextMenuContent,
            {
              className: 'min-w-52',
              children: [
                ...renderMenuItems(ContextMenuItem),
                isExplicit &&
                  otherProfiles.length > 0 &&
                  jsxs(Fragment, {
                    children: [
                      jsx(ContextMenuSeparator, {}),
                      jsxs(ContextMenuSub, {
                        children: [
                          jsx(ContextMenuSubTrigger, {
                            children: jsxs('span', {
                              className: 'flex items-center gap-2',
                              children: [
                                jsx(Codicon, { name: 'arrow-swap', size: '0.8rem' }),
                                jsx('span', { children: 'Transfer to profile' })
                              ]
                            })
                          }),
                          jsx(ContextMenuSubContent, {
                            className: 'min-w-44',
                            children: otherProfiles.map(targetProf =>
                              jsx(
                                ContextMenuItem,
                                {
                                  onSelect: () =>
                                    void onTransferProject(profileKey, targetProf.key, project),
                                  children: jsxs('span', {
                                    className: 'flex items-center gap-2',
                                    children: [
                                      jsx(ProfileAvatarGraphic, {
                                        profileName: targetProf.key,
                                        profileRow: targetProf.profileRow,
                                        assetUrl: $avatarAssetMap.get()[targetProf.key] || null,
                                        size: 14,
                                        shapeStyle: prefs.shapeStyle || 'rounded'
                                      }),
                                      jsx('span', {
                                        className: 'truncate',
                                        children: targetProf.displayName
                                      })
                                    ]
                                  })
                                },
                                targetProf.key
                              )
                            )
                          })
                        ]
                      })
                    ]
                  })
              ]
            },
            'content'
          )
        ]
      }),
      isOpen &&
        jsxs('div', {
          className: 'ml-2.5 flex flex-col gap-px border-l border-(--ui-stroke-tertiary) py-0.5 pl-1.5',
          style: profileGuideColor ? { borderColor: profileGuideColor } : undefined,
          children: [
            visibleSessions.length > 0
              ? visibleSessions.map(session => {
                  const isSelected =
                    Boolean(focusedStoredId) &&
                    (session.id === focusedStoredId ||
                      session._lineage_root_id === focusedStoredId)
                  return jsx(
                    ProjectSessionRow,
                    {
                      session,
                      profileKey,
                      projectColor: project.color,
                      profileTintColor,
                      isSelected,
                      siblingProjects,
                      onRefresh
                    },
                    `${profileKey}::${session.id}`
                  )
                })
              : jsxs('button', {
                  type: 'button',
                  className:
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[0.71875rem] text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-secondary)',
                  onClick: () => onStartChatInProject(profileKey, project, false),
                  children: [
                    jsx(Codicon, { name: 'add', size: '0.7rem' }),
                    jsx('span', { children: 'No chats yet — start a chat' })
                  ]
                }),
            hiddenCount > 0 &&
              jsxs('button', {
                type: 'button',
                disabled: hydrating,
                className:
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[0.6875rem] font-medium text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground',
                onClick: handleExpandAllSessions,
                children: [
                  hydrating
                    ? jsx(GlyphSpinner, { className: 'text-[0.6875rem]' })
                    : jsx(Codicon, { name: 'chevron-down', size: '0.7rem' }),
                  jsx('span', {
                    children: hydrating ? 'Loading chats…' : `Show ${hiddenCount} more…`
                  })
                ]
              }),
            hydratedTree &&
              allSessions.length > 5 &&
              jsxs('button', {
                type: 'button',
                className:
                  'flex items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[0.6875rem] text-(--ui-text-quaternary) transition-colors hover:text-(--ui-text-secondary)',
                onClick: () => {
                  const next = { ...$expandedProjectTrees.get() }
                  delete next[expandKey]
                  $expandedProjectTrees.set(next)
                },
                children: [
                  jsx(Codicon, { name: 'chevron-up', size: '0.7rem' }),
                  jsx('span', { children: 'Show fewer' })
                ]
              })
          ]
        })
    ]
  })
}

// ── Profile Section (Level 1) ────────────────────────────────────────────────

function ProfileProjectsSection({
  profGroup,
  allProfiles,
  isOpen,
  onToggleOpen,
  isProjectOpen,
  onToggleProjectOpen,
  onSetAllProjectsInProfile,
  activeProfileKey,
  rawCwd,
  focusedStoredId,
  prefs,
  searchQuery,
  assetUrl,
  onCreateProjectInProfile,
  onOpenFolderInProfile,
  onEditProject,
  onDeleteProject,
  onStartChatInProject,
  onOpenBotChat,
  onMoveCurrentChatHere,
  onTransferProject,
  onRefresh,
  os
}) {
  const { key: profileKey, displayName, profileRow, activeId, projects } = profGroup
  const isFocusedProfile = profileKey === activeProfileKey

  const canonical = profileRow?.canonical_session
  const canonicalTipId = canonical?.resolved_id || canonical?.id || null
  const isBotChatSelected = Boolean(
    focusedStoredId &&
      canonical &&
      [canonical.id, canonical.resolved_id]
        .filter(Boolean)
        .map(String)
        .includes(String(focusedStoredId))
  )

  const sortedProjects = useMemo(() => {
    const base = sortProfileProjects(projects, activeId, prefs)
    if (!searchQuery) return base
    const q = searchQuery.toLowerCase()
    const profileMatches =
      displayName.toLowerCase().includes(q) || profileKey.toLowerCase().includes(q)
    if (profileMatches) return base

    return base.filter(proj => {
      const rootPath = projectRootCwd(proj)
      const fmtPath = rootPath ? displayPath(rootPath) : ''
      if (
        String(proj.label || '')
          .toLowerCase()
          .includes(q) ||
        fmtPath.toLowerCase().includes(q)
      ) {
        return true
      }
      return (proj.previewSessions || []).some(
        s =>
          String(s.title || '')
            .toLowerCase()
            .includes(q) ||
          String(s.preview || '')
            .toLowerCase()
            .includes(q) ||
          String(s.git_branch || '')
            .toLowerCase()
            .includes(q)
      )
    })
  }, [projects, activeId, prefs, searchQuery, displayName, profileKey])

  const activeProjectForFocus = useMemo(() => {
    if (!isFocusedProfile) return null
    if (rawCwd) {
      const matched = matchProjectForCwd(rawCwd, projects)
      if (matched) return matched.id
    }
    try {
      if (window.localStorage.getItem(PROJECT_SCOPE_STORAGE_KEY) === NO_PROJECT_ID) {
        return NO_PROJECT_ID
      }
    } catch {
      // Ignore
    }
    return activeId || NO_PROJECT_ID
  }, [isFocusedProfile, rawCwd, projects, activeId])

  const nonHomeCount = sortedProjects.filter(p => !p.isNoProject).length
  const totalSessions = sortedProjects.reduce((acc, p) => acc + (p.sessionCount || 0), 0)

  const appearanceDigest = useValue($appearanceDigest)
  const tintColor = useMemo(
    () => resolveProfileTintColor(profileKey, profileRow, assetUrl),
    [profileKey, profileRow, assetUrl, appearanceDigest]
  )

  const handleSetProfileColor = async nextColor => {
    const clean = typeof nextColor === 'string' && nextColor.trim() ? nextColor.trim() : null
    haptic('selection')
    try {
      // 1. Update localStorage hermes.desktop.profileColors
      const rawColors = window.localStorage.getItem('hermes.desktop.profileColors')
      const parsedColors = rawColors ? JSON.parse(rawColors) : {}
      if (clean) {
        parsedColors[profileKey] = clean
      } else {
        delete parsedColors[profileKey]
      }
      window.localStorage.setItem('hermes.desktop.profileColors', JSON.stringify(parsedColors))

      // 2. Update localStorage hermes.plugin.hermes-bots.bot-meta-v2 / bot-meta
      const connId = String(host.state.connectionId?.get?.() || 'local').trim()
      const scopedKey = `${connId}::${profileKey}`
      const rawV2 = window.localStorage.getItem('hermes.plugin.hermes-bots.bot-meta-v2')
      if (rawV2) {
        const parsedV2 = JSON.parse(rawV2)
        if (parsedV2 && typeof parsedV2 === 'object') {
          const targetKey = scopedKey in parsedV2 ? scopedKey : profileKey
          parsedV2[targetKey] = {
            ...(parsedV2[targetKey] || {}),
            color: clean || undefined,
            custom: true
          }
          window.localStorage.setItem(
            'hermes.plugin.hermes-bots.bot-meta-v2',
            JSON.stringify(parsedV2)
          )
        }
      }

      $appearanceDigest.set(`${Date.now()}:${profileKey}:${clean || ''}`)

      // 3. Persist to server profile.yaml ui_meta
      const currentMeta = readLiveBotMeta(profileKey, profileRow)
      const { image: _img, pet: _pet, chat: _chat, ...restMeta } = currentMeta
      await host
        .request('profiles.configure', {
          name: profileKey,
          ui_meta: {
            'hermes-bots': {
              ...restMeta,
              color: clean || undefined,
              custom: true
            }
          }
        })
        .catch(() => null)

      void queryClient.invalidateQueries({ queryKey: [ID, 'directory'] })
      void queryClient.invalidateQueries({ queryKey: ['hermes-bots', 'roster'] })
      onRefresh?.()
    } catch {
      // Ignore storage errors
    }
  }
  const tintMode = prefs.profileTint || 'medium'
  const tintConfig =
    tintMode === 'off'
      ? null
      : tintMode === 'subtle'
        ? { fill: isFocusedProfile ? 3.5 : 2, border: isFocusedProfile ? 12 : 7, guide: 18 }
        : tintMode === 'strong'
          ? { fill: isFocusedProfile ? 9 : 6, border: isFocusedProfile ? 22 : 14, guide: 28 }
          : { fill: isFocusedProfile ? 5.5 : 3.5, border: isFocusedProfile ? 15 : 9, guide: 22 }

  const sectionTintStyle = tintColor
    ? {
        '--ui-control-hover-background': profileColorSoft(tintColor, 10),
        '--ui-control-active-background': profileColorSoft(tintColor, 18),
        '--chrome-action-hover': profileColorSoft(tintColor, 14),
        '--sidebar-accent': profileColorSoft(tintColor, 18),
        ...(tintConfig
          ? {
              backgroundColor: profileColorSoft(tintColor, tintConfig.fill),
              border: `1px solid ${profileColorSoft(tintColor, tintConfig.border)}`
            }
          : {})
      }
    : undefined

  const handleNewChatInProfile = event => {
    event?.stopPropagation?.()
    haptic('selection')
    // A bare host.newChat() resolves its cwd from core's in-memory project
    // scope, which plugins cannot update (they only write localStorage). With
    // Home selected in the project switcher that can be a stale "last project".
    // Route through the explicit Home flow so the draft is pinned detached.
    if (readStoredProjectScope() === NO_PROJECT_ID && typeof onStartChatInProject === 'function') {
      void onStartChatInProject(profileKey, { id: NO_PROJECT_ID, isNoProject: true }, false)
      return
    }
    host.newChat(profileKey)
  }

  const profileHeader = jsxs('div', {
    'data-focused': isFocusedProfile ? 'true' : undefined,
    style:
      isFocusedProfile && tintColor
        ? {
            backgroundImage: `linear-gradient(90deg, ${profileColorSoft(tintColor, 14)} 0%, ${profileColorSoft(tintColor, 5)} 60%, transparent 100%)`
          }
        : undefined,
    className: cn(
      'group flex min-h-7 w-full items-center justify-between gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-100',
      isFocusedProfile
        ? cn(!tintColor && 'bg-(--ui-control-active-background)', 'text-foreground')
        : 'hover:bg-(--ui-control-hover-background)'
    ),
    onPointerEnter: () => {
      host.warmProfile?.(profileKey)
    },
    children: [
      jsxs('div', {
        className: 'flex min-w-0 flex-1 items-center gap-1.5',
        children: [
          jsxs(RowButton, {
            'aria-expanded': isOpen,
            className: 'flex min-w-0 items-center gap-2 bg-transparent text-left',
            onClick: () => {
              haptic('tap')
              onToggleOpen()
            },
            children: [
              jsx(ProfileAvatarGraphic, {
                profileName: profileKey,
                profileRow,
                assetUrl,
                size: 18,
                shapeStyle: prefs.shapeStyle || 'rounded'
              }),
              jsxs('div', {
                className: 'flex min-w-0 items-center gap-1.5',
                children: [
                  jsx('span', {
                    className: 'truncate text-[0.8125rem] font-semibold text-foreground',
                    children: displayName
                  }),
                  displayName.toLowerCase() !== profileKey.toLowerCase() &&
                    jsx('span', {
                      className: 'truncate font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                      children: `@${profileKey}`
                    }),
                  jsx(DisclosureCaret, {
                    className:
                      'shrink-0 text-(--ui-text-tertiary) opacity-60 transition group-hover:opacity-100',
                    open: isOpen
                  })
                ]
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-0.5',
        'data-row-actions': '',
        children: [
          jsx('span', {
            className: 'pr-0.5 text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
            title: [
              `${nonHomeCount} project${nonHomeCount === 1 ? '' : 's'}`,
              `${totalSessions} chat${totalSessions === 1 ? '' : 's'}`,
              profGroup.totalTokens > 0 ? `${compactNumber(profGroup.totalTokens)} tokens` : null
            ]
              .filter(Boolean)
              .join(' · '),
            children:
              nonHomeCount > 0
                ? `${nonHomeCount}p · ${totalSessions}c`
                : totalSessions > 0
                  ? `${totalSessions}c`
                  : '0p'
          }),
          jsx(Tip, {
            label: `New project in ${displayName}`,
            side: 'top',
            children: jsx(Button, {
              'aria-label': `New project in ${displayName}`,
              size: 'icon-xs',
              variant: 'ghost',
              className:
                'size-5 shrink-0 rounded-[4px] text-(--ui-text-tertiary) hover:bg-(--ui-control-active-background) hover:text-foreground',
              onClick: e => {
                e.stopPropagation()
                onCreateProjectInProfile(profileKey)
              },
              children: jsx(Codicon, { name: 'new-folder', size: '0.75rem' })
            })
          })
        ]
      })
    ]
  })

  const openBotChat = e => {
    haptic('tap')
    void onOpenBotChat?.(profileKey, profileRow, {
      openTab: Boolean(e?.metaKey || e?.ctrlKey || e?.shiftKey || e?.button === 1)
    })
  }

  const botChatRow = jsx(
    'div',
    {
      style:
        isBotChatSelected && tintColor
          ? {
              backgroundColor: profileColorSoft(tintColor, 18),
              boxShadow: `inset 0 0 0 1px ${profileColorSoft(tintColor, 36)}`
            }
          : undefined,
      className: cn(
        'group relative flex min-h-6.5 w-full items-center rounded-md px-1.5 py-0.5 text-xs transition-colors duration-100',
        isBotChatSelected
          ? cn(!tintColor && 'bg-(--ui-control-active-background)', 'text-foreground')
          : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground'
      ),
      children: jsxs(RowButton, {
        'aria-label': `Open ${displayName} Bot Chat`,
        className: 'flex min-w-0 flex-1 items-center gap-1.5 bg-transparent py-0.5 text-left',
        onClick: openBotChat,
        onAuxClick: e => {
          if (e.button === 1) {
            e.preventDefault()
            openBotChat(e)
          }
        },
        children: [
          canonicalTipId && typeof SessionStatusDot === 'function'
            ? jsx(SessionStatusDot, { storedSessionId: canonicalTipId })
            : jsx(Codicon, { name: 'hubot', size: '0.8125rem', className: 'shrink-0 text-(--ui-text-tertiary)' }),
          jsx('span', {
            className: cn(
              'truncate text-[0.8125rem] leading-tight',
              isBotChatSelected ? 'font-semibold text-foreground' : 'font-medium'
            ),
            children: 'Bot Chat'
          })
        ]
      })
    },
    'bot-chat'
  )

  return jsxs('div', {
    className: cn(
      'flex flex-col transition-colors duration-150',
      tintConfig && tintColor ? 'mb-1 rounded-lg px-1 py-1' : 'pb-1'
    ),
    style: sectionTintStyle,
    'data-profile-section': profileKey,
    children: [
      jsx(ContextMenu, {
        children: [
          jsx(
            ContextMenuTrigger,
            {
              asChild: true,
              children: profileHeader
            },
            'trigger'
          ),
          jsxs(
            ContextMenuContent,
            {
              className: 'min-w-52',
              children: [
                jsx(ContextMenuItem, {
                  onSelect: () => void onOpenBotChat?.(profileKey, profileRow, { openTab: false }),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { name: 'hubot', size: '0.8rem' }),
                      jsx('span', { children: `Open ${displayName} Bot Chat` })
                    ]
                  })
                }),
                jsx(ContextMenuSeparator, {}),
                jsx(ContextMenuItem, {
                  onSelect: () => onCreateProjectInProfile(profileKey),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { name: 'new-folder', size: '0.8rem' }),
                      jsx('span', { children: `New project in ${displayName}…` })
                    ]
                  })
                }),
                jsx(ContextMenuItem, {
                  onSelect: () => void onOpenFolderInProfile(profileKey),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { name: 'folder-opened', size: '0.8rem' }),
                      jsx('span', { children: `Open folder as project in ${displayName}…` })
                    ]
                  })
                }),
                jsx(ContextMenuItem, {
                  onSelect: () => handleNewChatInProfile(),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { name: 'comment', size: '0.8rem' }),
                      jsx('span', { children: `New chat with ${displayName}` })
                    ]
                  })
                }),
                jsx(ContextMenuSeparator, {}),
                jsx(ContextMenuItem, {
                  onSelect: () =>
                    onSetAllProjectsInProfile(
                      profileKey,
                      sortedProjects.map(p => p.id),
                      true
                    ),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { name: 'expand-all', size: '0.8rem' }),
                      jsx('span', { children: 'Expand all projects' })
                    ]
                  })
                }),
                jsx(ContextMenuItem, {
                  onSelect: () =>
                    onSetAllProjectsInProfile(
                      profileKey,
                      sortedProjects.map(p => p.id),
                      false
                    ),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { name: 'collapse-all', size: '0.8rem' }),
                      jsx('span', { children: 'Collapse all projects' })
                    ]
                  })
                }),
                jsx(ContextMenuSeparator, {}),
                typeof ColorSwatches === 'function' &&
                  jsxs(ContextMenuSub, {
                    children: [
                      jsx(ContextMenuSubTrigger, {
                        children: jsxs('span', {
                          className: 'flex items-center gap-2',
                          children: [
                            jsx('span', {
                              className: 'size-2.5 shrink-0 rounded-full ring-1 ring-black/20',
                              style: { backgroundColor: tintColor || PRIMARY_AVATAR_COLOR }
                            }),
                            jsx('span', { children: 'Profile color' })
                          ]
                        })
                      }),
                      jsx(ContextMenuSubContent, {
                        className: 'p-2',
                        children: jsx(ColorSwatches, {
                          swatches: PROFILE_SWATCHES,
                          value: tintColor || null,
                          clearLabel: 'Default color',
                          onChange: nextColor => void handleSetProfileColor(nextColor)
                        })
                      })
                    ]
                  }),
                jsx(ContextMenuItem, {
                  onSelect: () => host.navigate('/profiles'),
                  children: jsxs('span', {
                    className: 'flex items-center gap-2 text-(--ui-text-secondary)',
                    children: [
                      jsx(Codicon, { name: 'settings-gear', size: '0.8rem' }),
                      jsx('span', { children: 'Manage profiles…' })
                    ]
                  })
                })
              ]
            },
            'content'
          )
        ]
      }),
      isOpen &&
        jsxs('div', {
          className: 'ml-2.5 flex flex-col gap-0.5 border-l border-(--ui-stroke-tertiary) pt-0.5 pl-1.5',
          style:
            tintConfig && tintColor
              ? { borderColor: profileColorSoft(tintColor, tintConfig.guide) }
              : undefined,
          children: [
            botChatRow,
            ...(sortedProjects.length > 0
              ? sortedProjects.map(project => {
                  const projOpen = Boolean(searchQuery) || isProjectOpen(profileKey, project)
                  const isCurrentWorkspace =
                    isFocusedProfile && activeProjectForFocus === project.id
                  const canMoveCurrentChat =
                    isFocusedProfile &&
                    Boolean(focusedStoredId || host.state.focusedSessionId?.get?.()) &&
                    !isCurrentWorkspace

                  return jsx(
                    ProfileProjectRow,
                    {
                      project,
                      profileKey,
                      profileDisplayName: displayName,
                      profileTintColor: tintColor,
                      profileGuideColor:
                        tintConfig && tintColor ? profileColorSoft(tintColor, tintConfig.guide) : undefined,
                      allProfiles,
                      siblingProjects: projects,
                      isOpen: projOpen,
                      onToggleOpen: () => onToggleProjectOpen(profileKey, project),
                      isCurrentWorkspace,
                      focusedStoredId,
                      prefs,
                      searchQuery,
                      onEditProject,
                      onDeleteProject,
                      onStartChatInProject,
                      onMoveCurrentChatHere,
                      canMoveCurrentChat,
                      onTransferProject,
                      onRefresh,
                      os
                    },
                    `${profileKey}::${project.id}`
                  )
                })
              : [
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      className:
                        'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-secondary)',
                      onClick: () => onCreateProjectInProfile(profileKey),
                      children: [
                        jsx(Codicon, { name: 'new-folder', size: '0.75rem' }),
                        jsx('span', { children: `Create a project in ${displayName}…` })
                      ]
                    },
                    'empty-create'
                  )
                ])
          ]
        })
    ]
  })
}

// ── Main Sidebar View Component ──────────────────────────────────────────────

function ProfileProjectsPane({ prefsAtom, updatePrefs, storage, os }) {
  const prefs = useValue(prefsAtom)
  const assetMap = useValue($avatarAssetMap)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const gatewayProfile = useValue(host.state.profile)
  const rawCwd = useValue(host.state.cwd)
  const focusedStoredId = useValue(host.state.focusedStoredSessionId)
  const focusedRuntimeId = useValue(host.state.focusedSessionId)
  const activeRuntimeId = useValue(host.state.activeSessionId)
  const externalDialogReq = useValue($openDialogRequest)

  const activeProfileKey = normalizeProfile(focusedProfile || gatewayProfile)

  const { data: profileGroups = [], isLoading, refetch } = useProfileProjectsDirectory()

  const [searchQuery, setSearchQuery] = useState('')
  const [editorState, setEditorState] = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const [profileOpenMap, setProfileOpenMap] = useState(() =>
    storage.get('profileOpenMap', {})
  )
  const [projectOpenMap, setProjectOpenMap] = useState(() =>
    storage.get('projectOpenMap', {})
  )

  useEffect(() => {
    if (externalDialogReq) {
      setEditorState(externalDialogReq)
      $openDialogRequest.set(null)
    }
  }, [externalDialogReq])

  const isProfileOpen = profileKey => {
    if (searchQuery.trim()) return true
    if (profileKey in profileOpenMap) return Boolean(profileOpenMap[profileKey])
    return true
  }

  const toggleProfileOpen = profileKey => {
    setProfileOpenMap(prev => {
      const current = profileKey in prev ? Boolean(prev[profileKey]) : true
      const next = { ...prev, [profileKey]: !current }
      storage.set('profileOpenMap', next)
      return next
    })
  }

  const isProjectOpen = (profileKey, project) => {
    const key = `${profileKey}::${project.id}`
    if (key in projectOpenMap) return Boolean(projectOpenMap[key])
    // Default explicit projects with sessions open, Home collapsed unless active
    if (project.isNoProject) return false
    return (project.sessionCount || 0) > 0
  }

  const toggleProjectOpen = (profileKey, project) => {
    const key = `${profileKey}::${project.id}`
    setProjectOpenMap(prev => {
      const current =
        key in prev
          ? Boolean(prev[key])
          : !project.isNoProject && (project.sessionCount || 0) > 0
      const next = { ...prev, [key]: !current }
      storage.set('projectOpenMap', next)
      return next
    })
  }

  const setAllProjectsInProfile = (profileKey, projectIds, openVal) => {
    setProjectOpenMap(prev => {
      const next = { ...prev }
      for (const pid of projectIds) {
        next[`${profileKey}::${pid}`] = Boolean(openVal)
      }
      storage.set('projectOpenMap', next)
      return next
    })
    if (openVal) {
      setProfileOpenMap(prev => {
        const next = { ...prev, [profileKey]: true }
        storage.set('profileOpenMap', next)
        return next
      })
    }
  }

  const trimmedQuery = searchQuery.trim()

  const visibleProfileGroups = useMemo(() => {
    return profileGroups.filter(group => {
      const projects = sortProfileProjects(group.projects, group.activeId, prefs)
      if (trimmedQuery) {
        const q = trimmedQuery.toLowerCase()
        if (
          group.displayName.toLowerCase().includes(q) ||
          group.key.toLowerCase().includes(q)
        ) {
          return true
        }
        return projects.some(proj => {
          const rootPath = projectRootCwd(proj)
          const fmtPath = rootPath ? displayPath(rootPath) : ''
          if (
            String(proj.label || '')
              .toLowerCase()
              .includes(q) ||
            fmtPath.toLowerCase().includes(q)
          ) {
            return true
          }
          return (proj.previewSessions || []).some(
            s =>
              String(s.title || '')
                .toLowerCase()
                .includes(q) ||
              String(s.preview || '')
                .toLowerCase()
                .includes(q) ||
              String(s.git_branch || '')
                .toLowerCase()
                .includes(q)
          )
        })
      }

      if (prefs.showEmptyProfiles === false && projects.length === 0) {
        return false
      }
      return true
    })
  }, [profileGroups, prefs, trimmedQuery])

  const allProfilesCollapsed =
    visibleProfileGroups.length > 0 &&
    visibleProfileGroups.every(g => !isProfileOpen(g.key))

  const handleToggleCollapseAll = () => {
    haptic('tap')
    const targetOpen = allProfilesCollapsed
    const nextProf = { ...profileOpenMap }
    const nextProj = { ...projectOpenMap }

    for (const g of visibleProfileGroups) {
      nextProf[g.key] = targetOpen
      for (const p of g.projects) {
        nextProj[`${g.key}::${p.id}`] = targetOpen && !p.isNoProject
      }
    }

    setProfileOpenMap(nextProf)
    setProjectOpenMap(nextProj)
    storage.set('profileOpenMap', nextProf)
    storage.set('projectOpenMap', nextProj)
  }

  const handleOpenBotChat = async (targetProfileKey, profileRow, options = {}) => {
    haptic('selection')
    try {
      await openProfileBotChat(targetProfileKey, profileRow, options)
    } catch (err) {
      host.notifyError?.(
        err,
        `Failed to open Bot Chat for "${resolveDisplayName(profileRow, targetProfileKey)}"`
      )
    }
  }

  const handleStartChatInProject = async (targetProfileKey, project, draftOnly = false) => {
    haptic('selection')
    const prof = normalizeProfile(targetProfileKey)
    const isHome = Boolean(project?.isNoProject || project?.id === NO_PROJECT_ID)
    const targetId = isHome ? NO_PROJECT_ID : project.id
    const targetPath = isHome ? '' : projectRootCwd(project)

    try {
      $pendingDraftTarget.set({
        profile: prof,
        cwd: targetPath,
        projectId: targetId,
        isHome,
        armedAt: Date.now()
      })

      // Set cwd & projectScope BEFORE calling host.newChat(prof) so core's
      // useFreshSessionRequest reads the target workspace immediately.
      applyDraftWorkspaceCwd(targetPath, targetId, prof)

      if (isHome) {
        await host
          .request('projects.set_active', { id: null, profile: prof })
          .catch(() => null)
      } else if (String(targetId).startsWith('p_')) {
        await host
          .request('projects.set_active', { id: targetId, profile: prof })
          .catch(() => null)
      }

      if (!draftOnly || focusedStoredId || focusedRuntimeId || activeRuntimeId) {
        host.newChat(prof)
      } else if (prof !== activeProfileKey) {
        host.newChat(prof)
      }

      // Re-arm after host.newChat(prof) so async profile-switch effects
      // (leaveForeignProjectScope, gateway scope refresh) keep the target cwd/scope.
      applyDraftWorkspaceCwd(targetPath, targetId, prof)

      void queryClient.invalidateQueries({ queryKey: [ID, 'directory'] })
      void queryClient.invalidateQueries({ queryKey: ['project-switcher-pill', 'projects'] })
      void queryClient.invalidateQueries({ queryKey: ['profile-switcher-pill', 'profiles'] })
    } catch (err) {
      host.notifyError?.(err, `Failed to start chat in "${project?.label || targetId}"`)
    }
  }

  const handleMoveCurrentChatHere = async (targetProfileKey, project) => {
    haptic('selection')
    const prof = normalizeProfile(targetProfileKey)
    const isHome = Boolean(project?.isNoProject || project?.id === NO_PROJECT_ID)
    const moveCwd = isHome ? '~' : projectRootCwd(project)
    if (!moveCwd) return

    const storedId = focusedStoredId || null
    const runtimeId = focusedRuntimeId || activeRuntimeId || null

    try {
      let moved = false
      if (storedId) {
        try {
          const res = await host.request('session.workspace.move', {
            session_key: storedId,
            cwd: moveCwd,
            profile: prof
          })
          const resolved = res?.cwd || moveCwd
          if (resolved && typeof host.state.cwd?.set === 'function') {
            host.state.cwd.set(resolved)
          }
          moved = true
        } catch {
          // Fall back to session.cwd.set
        }
      }

      if (!moved && runtimeId) {
        const res = await host.request('session.cwd.set', {
          session_id: runtimeId,
          cwd: moveCwd
        })
        const resolved = res?.cwd || moveCwd
        if (resolved && typeof host.state.cwd?.set === 'function') {
          host.state.cwd.set(resolved)
        }
        moved = true
      }

      if (moved) {
        notifySidebarSessionsChanged()
        void refetch()
        host.notify({
          durationMs: 2_000,
          kind: 'info',
          message: `Moved chat to ${isHome ? 'Home' : project.label}`
        })
      }
    } catch (err) {
      host.notifyError?.(err, 'Failed to move current chat')
    }
  }

  const handleOpenFolderInProfile = async targetProfileKey => {
    haptic('tap')
    const prof = normalizeProfile(targetProfileKey)
    const selectPaths = window.hermesDesktop?.selectPaths
    if (typeof selectPaths !== 'function') {
      setEditorState({ mode: 'create', profile: prof })
      return
    }

    try {
      const picked = await selectPaths({
        directories: true,
        multiple: false,
        profile: prof
      })
      const folder = Array.isArray(picked) && picked[0] ? String(picked[0]).trim() : ''
      if (!folder) return

      const name = pathLeaf(folder) || folder
      await host.request('projects.create', {
        name,
        folders: [folder],
        primary_path: folder,
        use: true,
        profile: prof
      })

      setProfileOpenMap(prev => {
        const next = { ...prev, [prof]: true }
        storage.set('profileOpenMap', next)
        return next
      })
      void refetch()
      host.notify({
        durationMs: 2_000,
        kind: 'success',
        message: `Added project "${name}" to ${prof}`
      })
    } catch (err) {
      host.notifyError?.(err, 'Failed to open folder as project')
    }
  }

  const handleTransferProject = async (sourceProfileKey, targetProfileKey, project) => {
    haptic('selection')
    const src = normalizeProfile(sourceProfileKey)
    const dst = normalizeProfile(targetProfileKey)
    if (src === dst || !project?.id) return

    try {
      const foldersToCopy =
        Array.isArray(project.folders) && project.folders.length > 0
          ? project.folders.map(f => f.path).filter(Boolean)
          : project.path
            ? [project.path]
            : []

      await host.request('projects.create', {
        name: project.label,
        folders: foldersToCopy,
        primary_path: project.primary_path || project.path || undefined,
        description: project.description || undefined,
        color: project.color || null,
        icon: project.icon || null,
        use: true,
        profile: dst
      })

      await host.request('projects.delete', {
        id: project.id,
        profile: src
      })

      setProfileOpenMap(prev => {
        const next = { ...prev, [dst]: true }
        storage.set('profileOpenMap', next)
        return next
      })

      void refetch()
      host.notify({
        durationMs: 2_500,
        kind: 'success',
        message: `Transferred "${project.label}" from ${src} to ${dst}`
      })
    } catch (err) {
      host.notifyError?.(err, `Failed to transfer "${project.label}"`)
    }
  }

  const handleConfirmDeleteProject = async () => {
    if (!deleteConfirm) return
    const { profileKey, project } = deleteConfirm
    setDeleteConfirm(null)
    try {
      await host.request('projects.delete', {
        id: project.id,
        profile: profileKey
      })
      void refetch()
      host.notify({
        durationMs: 2_000,
        kind: 'info',
        message: `Deleted project "${project.label}"`
      })
    } catch (err) {
      host.notifyError?.(err, `Failed to delete "${project.label}"`)
    }
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden select-none',
    children: [
      // Top header bar
      jsxs('div', {
        className: 'flex shrink-0 items-center justify-between gap-2 px-2.5 pt-2.5 pb-1.5',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 items-center gap-1.5',
            children: [
              jsx('span', {
                className:
                  'text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                children: 'Projects by Profile'
              })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-0.5',
            children: [
              jsx(Tip, {
                label: allProfilesCollapsed ? 'Expand all' : 'Collapse all',
                side: 'bottom',
                children: jsx(Button, {
                  'aria-label': allProfilesCollapsed ? 'Expand all' : 'Collapse all',
                  size: 'icon-xs',
                  variant: 'ghost',
                  className: 'rounded-md text-(--ui-text-tertiary) hover:text-foreground',
                  onClick: handleToggleCollapseAll,
                  children: jsx(Codicon, {
                    name: allProfilesCollapsed ? 'expand-all' : 'collapse-all',
                    size: '0.8rem'
                  })
                })
              }),
              // Filter & View Options menu
              jsx(DropdownMenu, {
                children: [
                  jsx(
                    Tip,
                    {
                      label: 'View & sort options',
                      side: 'bottom',
                      children: jsx(DropdownMenuTrigger, {
                        asChild: true,
                        children: jsx(Button, {
                          'aria-label': 'View and sort options',
                          size: 'icon-xs',
                          variant: 'ghost',
                          className: 'rounded-md text-(--ui-text-tertiary) hover:text-foreground',
                          children: jsx(Codicon, { name: 'list-filter', size: '0.8rem' })
                        })
                      })
                    },
                    'trigger'
                  ),
                  jsxs(
                    DropdownMenuContent,
                    {
                      align: 'end',
                      className: 'min-w-52',
                      children: [
                        jsx('div', {
                          className:
                            'px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                          children: 'Sort Projects By'
                        }),
                        ...[
                          ['recent', 'Recent activity', 'clock'],
                          ['name', 'Name (A–Z)', 'case-sensitive'],
                          ['sessions', 'Session count', 'symbol-numeric']
                        ].map(([id, label, icon]) =>
                          jsx(
                            DropdownMenuItem,
                            {
                              onSelect: e => {
                                e.preventDefault()
                                updatePrefs({ projectSort: id })
                              },
                              children: jsxs('span', {
                                className: 'flex w-full items-center justify-between gap-2',
                                children: [
                                  jsxs('span', {
                                    className: 'flex items-center gap-2',
                                    children: [
                                      jsx(Codicon, { name: icon, size: '0.8rem' }),
                                      jsx('span', { children: label })
                                    ]
                                  }),
                                  (prefs.projectSort || 'recent') === id &&
                                    jsx(Codicon, { name: 'check', size: '0.75rem' })
                                ]
                              })
                            },
                            `sort:${id}`
                          )
                        ),
                        jsx(DropdownMenuSeparator, {}),
                        jsx('div', {
                          className:
                            'px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                          children: 'Show'
                        }),
                        ...[
                          ['showAutoProjects', 'Auto-discovered repos'],
                          ['showHomeBucket', 'Home (no-project) bucket'],
                          ['showEmptyProjects', 'Empty projects'],
                          ['showEmptyProfiles', 'Profiles without projects'],
                          ['showPathsOnRows', 'Workspace folder paths']
                        ].map(([key, label]) => {
                          const checked = prefs[key] !== false
                          return jsx(
                            DropdownMenuItem,
                            {
                              onSelect: e => {
                                e.preventDefault()
                                updatePrefs({ [key]: !checked })
                              },
                              children: jsxs('span', {
                                className: 'flex w-full items-center justify-between gap-2',
                                children: [
                                  jsx('span', { children: label }),
                                  checked && jsx(Codicon, { name: 'check', size: '0.75rem' })
                                ]
                              })
                            },
                            `toggle:${key}`
                          )
                        })
                      ]
                    },
                    'content'
                  )
                ]
              }),
              // New Project dropdown
              jsx(DropdownMenu, {
                children: [
                  jsx(
                    Tip,
                    {
                      label: 'New project…',
                      side: 'bottom',
                      children: jsx(DropdownMenuTrigger, {
                        asChild: true,
                        children: jsx(Button, {
                          'aria-label': 'New project',
                          size: 'icon-xs',
                          variant: 'ghost',
                          className: 'rounded-md text-(--ui-text-tertiary) hover:text-foreground',
                          children: jsx(Codicon, { name: 'add', size: '0.8rem' })
                        })
                      })
                    },
                    'trigger'
                  ),
                  jsxs(
                    DropdownMenuContent,
                    {
                      align: 'end',
                      className: 'min-w-52',
                      children: [
                        jsx(DropdownMenuItem, {
                          onSelect: () =>
                            setEditorState({ mode: 'create', profile: activeProfileKey }),
                          children: jsxs('span', {
                            className: 'flex items-center gap-2',
                            children: [
                              jsx(Codicon, { name: 'new-folder', size: '0.8rem' }),
                              jsx('span', { children: 'New project…' })
                            ]
                          })
                        }),
                        jsx(DropdownMenuItem, {
                          onSelect: () => void handleOpenFolderInProfile(activeProfileKey),
                          children: jsxs('span', {
                            className: 'flex items-center gap-2',
                            children: [
                              jsx(Codicon, { name: 'folder-opened', size: '0.8rem' }),
                              jsx('span', { children: 'Open folder as project…' })
                            ]
                          })
                        }),
                        profileGroups.length > 1 &&
                          jsxs(Fragment, {
                            children: [
                              jsx(DropdownMenuSeparator, {}),
                              jsx('div', {
                                className:
                                  'px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                                children: 'Create Project In Profile'
                              }),
                              ...profileGroups.map(prof =>
                                jsx(
                                  DropdownMenuItem,
                                  {
                                    onSelect: () =>
                                      setEditorState({ mode: 'create', profile: prof.key }),
                                    children: jsxs('span', {
                                      className: 'flex items-center gap-2',
                                      children: [
                                        jsx(ProfileAvatarGraphic, {
                                          profileName: prof.key,
                                          profileRow: prof.profileRow,
                                          assetUrl: assetMap[prof.key] || null,
                                          size: 14,
                                          shapeStyle: prefs.shapeStyle || 'rounded'
                                        }),
                                        jsx('span', {
                                          className: 'truncate',
                                          children: prof.displayName
                                        })
                                      ]
                                    })
                                  },
                                  prof.key
                                )
                              )
                            ]
                          })
                      ]
                    },
                    'content'
                  )
                ]
              })
            ]
          })
        ]
      }),
      // Search field
      jsx('div', {
        className: 'shrink-0 px-2.5 pb-1.5',
        children: jsx(SearchField, {
          'aria-label': 'Filter profiles, projects, or chats',
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: 'Filter profiles, projects, chats…'
        })
      }),
      // Scrollable tree content
      jsx('div', {
        className:
          'min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1.5 pb-2 scrollbar-fade [scrollbar-gutter:stable]',
        children:
          isLoading && profileGroups.length === 0
            ? jsx('div', {
                className: 'flex h-32 items-center justify-center',
                children: jsx(GlyphSpinner, { className: 'text-(--ui-text-tertiary)' })
              })
            : visibleProfileGroups.length === 0
              ? jsxs('div', {
                  className:
                    'grid min-h-28 place-items-center gap-2 rounded-lg px-3 py-4 text-center text-xs text-(--ui-text-tertiary)',
                  children: [
                    jsx('div', {
                      children: trimmedQuery
                        ? `No profiles, projects, or chats matching "${trimmedQuery}"`
                        : 'No projects found across your profiles.'
                    }),
                    !trimmedQuery &&
                      jsx(Button, {
                        size: 'sm',
                        variant: 'secondary',
                        onClick: () =>
                          setEditorState({ mode: 'create', profile: activeProfileKey }),
                        children: 'New Project'
                      })
                  ]
                })
              : jsxs('div', {
                  className: 'flex flex-col gap-1',
                  children: visibleProfileGroups.map(profGroup =>
                    jsx(
                      ProfileProjectsSection,
                      {
                        profGroup,
                        allProfiles: profileGroups,
                        isOpen: isProfileOpen(profGroup.key),
                        onToggleOpen: () => toggleProfileOpen(profGroup.key),
                        isProjectOpen,
                        onToggleProjectOpen: toggleProjectOpen,
                        onSetAllProjectsInProfile: setAllProjectsInProfile,
                        activeProfileKey,
                        rawCwd,
                        focusedStoredId,
                        prefs,
                        searchQuery: trimmedQuery,
                        assetUrl: assetMap[profGroup.key] || null,
                        onCreateProjectInProfile: profKey =>
                          setEditorState({ mode: 'create', profile: profKey }),
                        onOpenFolderInProfile: handleOpenFolderInProfile,
                        onEditProject: (profKey, project) =>
                          setEditorState({ mode: 'edit', profile: profKey, project }),
                        onDeleteProject: (profKey, project) =>
                          setDeleteConfirm({ profileKey: profKey, project }),
                        onStartChatInProject: handleStartChatInProject,
                        onOpenBotChat: handleOpenBotChat,
                        onMoveCurrentChatHere: handleMoveCurrentChatHere,
                        onTransferProject: handleTransferProject,
                        onRefresh: () => void refetch(),
                        os
                      },
                      profGroup.key
                    )
                  )
                })
      }),
      // Create / Edit Project Modal
      jsx(ProjectEditorDialog, {
        state: editorState,
        onClose: () => setEditorState(null),
        profiles: profileGroups,
        onSaved: savedProf => {
          setProfileOpenMap(prev => {
            const next = { ...prev, [savedProf]: true }
            storage.set('profileOpenMap', next)
            return next
          })
          void refetch()
        }
      }),
      // Delete Project Confirmation
      typeof ConfirmDialog === 'function' &&
        jsx(ConfirmDialog, {
          open: Boolean(deleteConfirm),
          onClose: () => setDeleteConfirm(null),
          title: deleteConfirm ? `Delete project "${deleteConfirm.project.label}"?` : 'Delete project?',
          description:
            'This removes the project definition from this profile. Existing chat sessions and files on disk are not deleted.',
          confirmLabel: 'Delete',
          destructive: true,
          dismissOnConfirm: true,
          onConfirm: () => handleConfirmDeleteProject()
        })
    ]
  })
}

export default {
  id: ID,
  name: 'Profile Projects Sidebar',
  description:
    'Adds a Projects view tab in the sidebar broken down first by Profile, then by Project, and then by Session.',
  register(ctx) {
    // Status dot palette: red = needs action (approval/clarify), yellow = agent
    // working. Upstream paints these amber/accent, so override by class match.
    const dotStyle = document.createElement('style')
    dotStyle.id = `hermes-plugin-${ID}-status-dots`
    dotStyle.textContent = `
      span[role="status"][class*="bg-amber-500"] { background-color: #ef4444 !important; }
      span[role="status"][class*="bg-(--ui-accent)"] { background-color: #eab308 !important; }
      span[role="status"][class*="border-(--ui-accent)"] { border-color: #eab308 !important; }
    `
    document.getElementById(dotStyle.id)?.remove()
    document.head.appendChild(dotStyle)
    ctx.onDispose?.(() => dotStyle.remove())

    const prefs = atom({ ...DEFAULT_PREFS, ...ctx.storage.get('prefs', {}) })

    const updatePrefs = patch => {
      const next = { ...prefs.get(), ...patch }
      prefs.set(next)
      ctx.storage.set('prefs', next)
    }

    const invalidateAll = () => {
      void queryClient.invalidateQueries({ queryKey: [ID, 'directory'] })
    }

    const computeAppearanceDigest = () => {
      try {
        const c = window.localStorage.getItem('hermes.desktop.profileColors') || ''
        const v2 = window.localStorage.getItem('hermes.plugin.hermes-bots.bot-meta-v2') || ''
        const v1 = window.localStorage.getItem('hermes.plugin.hermes-bots.bot-meta') || ''
        return `${c.length}:${c}|${v2.length}:${v2.slice(0, 600)}:${v2.slice(-600)}|${v1.length}:${v1.slice(0, 400)}`
      } catch {
        return ''
      }
    }

    $appearanceDigest.set(computeAppearanceDigest())

    const syncAppearanceChanges = () => {
      const next = computeAppearanceDigest()
      if (next !== $appearanceDigest.get()) {
        $appearanceDigest.set(next)
        invalidateAll()
      }
    }

    const appearanceInterval = window.setInterval(syncAppearanceChanges, 400)
    window.addEventListener('storage', syncAppearanceChanges)
    window.addEventListener('focus', syncAppearanceChanges)
    ctx.onDispose?.(() => {
      window.clearInterval(appearanceInterval)
      window.removeEventListener('storage', syncAppearanceChanges)
      window.removeEventListener('focus', syncAppearanceChanges)
    })

    try {
      const cache = queryClient.getQueryCache?.()
      if (cache && typeof cache.subscribe === 'function') {
        const unsubCache = cache.subscribe(event => {
          const qk = event?.query?.queryKey
          if (Array.isArray(qk) && (qk[0] === 'hermes-bots' || qk[0] === 'profiles')) {
            syncAppearanceChanges()
            $appearanceDigest.set(`${computeAppearanceDigest()}@${Date.now()}`)
            invalidateAll()
          }
        })
        if (typeof unsubCache === 'function') {
          ctx.onDispose?.(unsubCache)
        }
      }
    } catch {
      // Ignore query cache subscription errors
    }

    ctx.onEvent('projects.changed', invalidateAll)
    ctx.onEvent('profiles.changed', () => {
      syncAppearanceChanges()
      invalidateAll()
    })
    ctx.onEvent('sessions.changed', invalidateAll)
    ctx.onEvent('session.created', ev => {
      invalidateAll()
      const pending = $pendingDraftTarget.get()
      if (!pending || Date.now() - pending.armedAt > 600_000) return
      $pendingDraftTarget.set(null)

      const runtimeId = ev?.session_id || host.state.activeSessionId?.get?.()
      const createdCwd = String(ev?.cwd || host.state.cwd?.get?.() || '').trim()
      const desiredCwd = String(pending.cwd || '').trim()

      if (runtimeId && desiredCwd && createdCwd !== desiredCwd) {
        void host
          .request('session.cwd.set', {
            session_id: runtimeId,
            cwd: desiredCwd
          })
          .then(res => {
            const resolved = res?.cwd || desiredCwd
            if (resolved && typeof host.state.cwd?.set === 'function') {
              host.state.cwd.set(resolved)
            }
            invalidateAll()
          })
          .catch(() => null)
      } else if (runtimeId && pending.isHome && createdCwd) {
        void host
          .request('session.cwd.set', {
            session_id: runtimeId,
            cwd: '~'
          })
          .then(() => {
            if (typeof host.state.cwd?.set === 'function') {
              host.state.cwd.set('')
            }
            invalidateAll()
          })
          .catch(() => null)
      }
    })
    ctx.onEvent('message.complete', invalidateAll)

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const ch = new BroadcastChannel('hermes:sessions')
        ch.addEventListener('message', invalidateAll)
        ctx.onDispose?.(() => ch.close())
      } catch {
        // Ignore
      }
    }

    // Register the "Projects" tab in the left sidebar tab strip alongside SESSIONS | BOTS
    ctx.register({
      id: 'pane',
      area: PANES_AREA || 'panes',
      title: 'Projects',
      data: {
        placement: 'left',
        width: '260px',
        collapsible: true,
        hideOnly: true,
        dock: {
          pane: 'sessions',
          pos: 'center',
          enforce: true
        }
      },
      render: function ProjectsSidebarPaneSlot() {
        return jsx(ProfileProjectsPane, {
          prefsAtom: prefs,
          updatePrefs,
          storage: ctx.storage,
          os: ctx.os
        })
      }
    })

    // Register Command Palette (⌘K) actions
    ctx.registerMany([
      {
        id: 'focus-pane',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.focus`,
          label: 'Projects Sidebar: Focus Projects by Profile View',
          keywords: ['projects', 'profile', 'sidebar', 'workspace', 'tree'],
          run: () => {
            host.revealPane?.(`${ID}:pane`)
          }
        }
      },
      {
        id: 'new-project-cmd',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.new-project`,
          label: 'Projects Sidebar: New Project in Profile…',
          keywords: ['new', 'create', 'project', 'profile', 'workspace'],
          run: () => {
            host.revealPane?.(`${ID}:pane`)
            const prof = normalizeProfile(
              host.state.focusedSessionProfile?.get?.() || host.state.profile?.get?.()
            )
            $openDialogRequest.set({ mode: 'create', profile: prof })
          }
        }
      },
      {
        id: 'focus-keybind',
        area: KEYBINDS_AREA,
        data: {
          id: `${ID}.focus`,
          label: 'Focus Projects by Profile Sidebar',
          category: 'Projects',
          defaults: ['alt+shift+p'],
          run: () => {
            host.revealPane?.(`${ID}:pane`)
          }
        }
      }
    ])

    // Register Settings -> Plugins page
    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Profile Projects Sidebar',
      icon: 'folder-library',
      render: function SettingsView() {
        const currentPrefs = useValue(prefs)

        return jsxs(Fragment, {
          children: [
            jsx(ListRow, {
              title: 'Sort projects by',
              description: 'Default ordering of projects inside each profile section.',
              action: jsx(SegmentedControl, {
                value: currentPrefs.projectSort || 'recent',
                onChange: val => updatePrefs({ projectSort: val }),
                options: [
                  { id: 'recent', label: 'Recent Activity' },
                  { id: 'name', label: 'Name' },
                  { id: 'sessions', label: 'Session Count' }
                ]
              })
            }),
            jsx(ListRow, {
              title: 'Preview chats per project',
              description:
                'How many recent chats to show initially when a project is expanded before offering "Show more".',
              action: jsx(SegmentedControl, {
                value: String(currentPrefs.previewLimit || '5'),
                onChange: val => updatePrefs({ previewLimit: val }),
                options: [
                  { id: '3', label: '3' },
                  { id: '5', label: '5' },
                  { id: '10', label: '10' },
                  { id: 'all', label: 'All' }
                ]
              })
            }),
            jsx(ListRow, {
              title: 'Profile avatar frame shape',
              description: 'Corner style for profile avatars on profile section headers.',
              action: jsx(SegmentedControl, {
                value: currentPrefs.shapeStyle || 'rounded',
                onChange: val => updatePrefs({ shapeStyle: val }),
                options: [
                  { id: 'rounded', label: 'Squircle' },
                  { id: 'circle', label: 'Circle' }
                ]
              })
            }),
            jsx(ListRow, {
              title: 'Profile background tint',
              description:
                'Tint each profile section with a translucent background in that profile’s signature color.',
              action: jsx(SegmentedControl, {
                value: currentPrefs.profileTint || 'medium',
                onChange: val => updatePrefs({ profileTint: val }),
                options: [
                  { id: 'off', label: 'Off' },
                  { id: 'subtle', label: 'Subtle' },
                  { id: 'medium', label: 'Medium' },
                  { id: 'strong', label: 'Strong' }
                ]
              })
            }),
            jsx(ToggleRow, {
              label: 'Show auto-discovered repositories',
              description:
                'Include Git repositories that have chat sessions in a profile even if not explicitly added to projects.db.',
              checked: currentPrefs.showAutoProjects !== false,
              onChange: val => updatePrefs({ showAutoProjects: val })
            }),
            jsx(ToggleRow, {
              label: 'Show Home (no-project) bucket',
              description:
                'Include each profile’s Home bucket for chats started outside a project workspace.',
              checked: currentPrefs.showHomeBucket !== false,
              onChange: val => updatePrefs({ showHomeBucket: val })
            }),
            jsx(ToggleRow, {
              label: 'Show empty explicit projects',
              description:
                'Display explicitly created projects even when they have zero chat sessions.',
              checked: currentPrefs.showEmptyProjects !== false,
              onChange: val => updatePrefs({ showEmptyProjects: val })
            }),
            jsx(ToggleRow, {
              label: 'Show profiles without projects',
              description:
                'Keep profiles visible even when they have no projects yet so you can quickly add projects to them.',
              checked: currentPrefs.showEmptyProfiles !== false,
              onChange: val => updatePrefs({ showEmptyProfiles: val })
            }),
            jsx(ToggleRow, {
              label: 'Show workspace folder paths on project rows',
              description:
                'Display the compact filesystem path (~ /path) beneath each project title.',
              checked: currentPrefs.showPathsOnRows !== false,
              onChange: val => updatePrefs({ showPathsOnRows: val })
            })
          ]
        })
      }
    })
  }
}
