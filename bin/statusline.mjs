#!/usr/bin/env node
// Cache Keeper's status line command.
//
// Claude Code runs it after every update (and every `refreshInterval` seconds), piping a JSON
// object that carries its own prompt-cache tracker (`prompt_cache`), the context window, the
// 5-hour and weekly limits and the session's cost. This script:
//   1. writes that, as one snapshot, to <claude dir>/cache-keeper/live/<session>.json, where the
//      strip above the prompt (hooks/register.ts) reads it;
//   2. while that strip is not running, prints the same facts as the status line, and sends the
//      desktop notification before the cache goes cold.
// The 5-hour and weekly figures it draws come from <claude dir>/cache-keeper/limits.json when that
// is fresher than this session's own last response (see hooks/register.ts, "account limits").
// It must never hang or throw: a status line that fails takes the footer with it.

import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as core from '../hooks/core.mjs'

const DEADLINE_MS = 1500
const NOTIFY_TIMEOUT_MS = 5000
const MODULE_FRESH_MS = 15_000
const TAIL_BYTES = [1 << 20, 8 << 20]
const PRUNE_AFTER_MS = 3 * 24 * 3_600_000

setTimeout(() => process.exit(0), DEADLINE_MS).unref()

try {
  main()
} catch (error) {
  // Print nothing rather than an error where the footer goes; CACHE_KEEPER_DEBUG=1 says why.
  if (process.env.CACHE_KEEPER_DEBUG) {
    process.stderr.write(`cache-keeper statusline: ${error instanceof Error ? error.stack : String(error)}\n`)
  }
}

function main() {
  if (process.stdin.isTTY) {
    process.stdout.write('cache-keeper statusline: reads the JSON Claude Code pipes to a status line command\n')
    return
  }

  const input = JSON.parse(readFileSync(0, 'utf8'))
  const now = Date.now()
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'cache-keeper')
  const live = join(dir, 'live')

  mkdirSync(live, { recursive: true })
  mkdirSync(join(dir, 'handoffs'), { recursive: true })

  const config = core.configOf(readJson(join(dir, 'config.json')))
  const id = safeName(typeof input.session_id === 'string' ? input.session_id : 'unknown')
  const snapshotPath = join(live, `${id}.json`)
  const previous = readJson(snapshotPath)

  // Claude Code's tracker answers only once this process has sent a request. Before that (a resumed
  // session) the transcript's last request says whether the server may still hold the cache.
  const tx = input.prompt_cache ? null : transcriptFacts(input.transcript_path, previous)
  const snapshot = { ...core.snapshotOfStatusLine(input, tx?.facts ?? null, now), ...(tx !== null && { tx }) }

  writeAtomic(snapshotPath, JSON.stringify(snapshot))

  const stripRunning = isFresh(join(live, `${id}.module`), now)
  // The account's limits as the freshest session or poll read them; the snapshot keeps this session's own.
  const account = core.accountOf(readJson(join(dir, 'limits.json')))
  // CACHE_KEEPER_ASSUME_COLD: the cache counts as cold; CACHE_KEEPER_TTL: the TTL it forces. As in the module (a test in the real engine).
  const assumeCold = isSet(process.env.CACHE_KEEPER_ASSUME_COLD)
  const view = core.viewOf(core.withAccountLimits(snapshot, account, now), now, core.withTtl(config, core.ttlOverrideOf(process.env.CACHE_KEEPER_TTL)), { assumeCold })
  const show = config.statusLine === 'always' || (config.statusLine === 'auto' && !stripRunning)

  if (show) {
    const width = Number(process.env.COLUMNS) > 20 ? Number(process.env.COLUMNS) - 2 : 118
    process.stdout.write(core.ansiLine(core.fit(core.segmentsOf(view, now, { seconds: false }), width, 3)))
  }

  // After the line is out, so a slow notifier can never cost the footer its update.
  if (!stripRunning) {
    maybeNotify(view, config, join(live, `${id}.notified`), id)
  }

  if (Math.random() < 0.02) {
    prune(live, now)
  }
}

/** The transcript's last request, read again only when the file has grown. */
function transcriptFacts(path, previous) {
  if (typeof path !== 'string' || path === '') {
    return null
  }

  let size
  let mtimeMs

  try {
    ;({ size, mtimeMs } = statSync(path))
  } catch {
    return null
  }

  const held = previous?.tx

  if (held && held.path === path && held.size === size && held.mtimeMs === mtimeMs) {
    return held
  }

  let facts = null

  for (const want of TAIL_BYTES) {
    const { text, whole } = readTail(path, want)

    facts = core.cacheFromTranscript(text, whole)

    if (facts !== null || whole) {
      break
    }
  }

  return { path, size, mtimeMs, facts }
}

function readTail(path, want) {
  const fd = openSync(path, 'r')

  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - want)
    const buffer = Buffer.alloc(size - start)

    readSync(fd, buffer, 0, buffer.length, start)

    return { text: buffer.toString('utf8'), whole: start === 0 }
  } finally {
    closeSync(fd)
  }
}

/** Once per cache expiry, a desktop notification when the warning window opens. */
function maybeNotify(view, config, markerPath, tag) {
  const cache = view.cache

  if (!config.notify || config.warnMinutes <= 0 || cache.state !== 'warning' || cache.expiresAt === null) {
    return
  }

  let marker = ''

  try {
    marker = readFileSync(markerPath, 'utf8').trim()
  } catch {
    // not notified yet
  }

  if (marker === String(cache.expiresAt)) {
    return
  }

  writeFileSync(markerPath, String(cache.expiresAt))

  const notifier = core.notifyArgv(process.platform, { ...core.warningNotice(view), tag })

  // Waited for, not detached: on Windows a detached powershell.exe has no console and runs nothing
  // (it exits 0), while a child left running is killed with this process by libuv's job object.
  // Measured at ~300 ms, once per cache expiry. The texts travel in the child's environment.
  if (notifier !== null) {
    const { argv, env } = notifier

    spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true, timeout: NOTIFY_TIMEOUT_MS, env: { ...process.env, ...env } })
  }
}

/** An environment variable that is set to something. */
function isSet(value) {
  return typeof value === 'string' && value !== '' && value !== '0'
}

function isFresh(path, now) {
  try {
    return now - statSync(path).mtimeMs < MODULE_FRESH_MS
  } catch {
    return false
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`

  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch {
    // Windows can refuse a rename over a file another process holds open: write in place.
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
    writeFileSync(path, text)
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function prune(live, now) {
  for (const name of readdirSync(live)) {
    const path = join(live, name)

    try {
      if (now - statSync(path).mtimeMs > PRUNE_AFTER_MS) {
        unlinkSync(path)
      }
    } catch {
      // raced with another session
    }
  }
}

function safeName(id) {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}
