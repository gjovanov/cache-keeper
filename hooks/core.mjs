// Cache Keeper: the arithmetic and the words.
//
// Pure functions, no I/O. The status line (Node) and the function-hooks module
// (inside Claude Code) both import this file, so it never touches a file, a
// clock or a process: every time is a number of milliseconds since the epoch,
// passed in.

export const VERSION = '0.4.3'

// ------------------------------------------------------------------ prices

/**
 * USD per million tokens.
 * @typedef {{ input: number, output: number, write5m: number, write1h: number, read: number }} Prices
 */

/**
 * Claude Code's own model catalog (`pricing_tiers`), so these figures agree with `/cost`. The prices of
 * Claude Haiku 5.5, Claude Sonnet 5.5 and Claude Fable 5.2 are as Claude Code's bundled claude-api docs
 * give them, which the catalog of 2.1.322 matches. `long`: the card a request is priced on when its
 * prompt is over `above` tokens.
 * @type {Record<string, Prices & { long?: Prices & { above: number } }>}
 */
const TIER = {
  t2_10: { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  t2_10_read010: { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.1 },
  t3_15: { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  t5_25: { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  t15_75: { input: 15, output: 75, write5m: 18.75, write1h: 30, read: 1.5 },
  t10_50: { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  t10_50_read025: { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  t4_20_read020: { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 },
  t8_40_read020: { input: 8, output: 40, write5m: 10, write1h: 16, read: 0.2 },
  haiku35: { input: 0.8, output: 4, write5m: 1, write1h: 1.6, read: 0.08 },
  haiku45: { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
  // Two cards by the prompt's length: up to 100k tokens, and over it.
  haiku55: {
    input: 0.1,
    output: 0.5,
    write5m: 0.125,
    write1h: 0.2,
    read: 0.01,
    long: { above: 100_000, input: 0.5, output: 2.5, write5m: 0.625, write1h: 1, read: 0.05 },
  },
}

/** Model id -> tier, as the same catalog maps them. */
const MODEL_TIER = {
  'claude-3-5-haiku': TIER.haiku35,
  'claude-haiku-4-5': TIER.haiku45,
  'claude-haiku-5-5': TIER.haiku55,
  'claude-3-5-sonnet': TIER.t3_15,
  'claude-3-7-sonnet': TIER.t3_15,
  'claude-sonnet-4-0': TIER.t3_15,
  'claude-sonnet-4-5': TIER.t3_15,
  'claude-sonnet-4-6': TIER.t3_15,
  'claude-sonnet-5': TIER.t2_10,
  'claude-sonnet-5-5': TIER.t2_10_read010,
  'claude-opus-4-0': TIER.t15_75,
  'claude-opus-4-1': TIER.t15_75,
  'claude-opus-4-5': TIER.t5_25,
  'claude-opus-4-6': TIER.t5_25,
  'claude-opus-4-7': TIER.t5_25,
  'claude-opus-4-8': TIER.t5_25,
  'claude-opus-5': TIER.t5_25,
  'claude-opus-5-5': TIER.t4_20_read020,
  'claude-fable-5': TIER.t10_50,
  'claude-fable-5-1': TIER.t10_50_read025,
  'claude-fable-5-2': TIER.t8_40_read020,
}

/** Fast mode, from the same build. Only these three models offer it. */
const FAST = {
  'claude-opus-5-5': { input: 8, output: 40, write5m: 10, write1h: 16, read: 0.4 },
  'claude-opus-5': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  'claude-opus-4-8': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
}

/**
 * The catalog id a model string names, or null when this table does not know it. Strips the
 * suffixes Claude Code and the providers add (`[1m]`, a date, `@date`, `-v1:0`, a region prefix).
 * Matching is exact on purpose: a near-miss would quote some other model's price.
 * @param {unknown} id
 * @returns {string | null}
 */
export function modelKey(id) {
  if (typeof id !== 'string') return null
  let s = id.trim().toLowerCase()
  const at = s.indexOf('claude-')
  if (at < 0) return null
  s = s
    .slice(at)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-latest$/, '')
    .replace(/-\d{8}$/, '')
  if (Object.hasOwn(MODEL_TIER, s)) return s
  if (s === 'claude-sonnet-4') return 'claude-sonnet-4-0'
  if (s === 'claude-opus-4') return 'claude-opus-4-0'
  return null
}

/**
 * @param {unknown} model
 * @param {boolean} [fast]
 * @param {number | null} [promptTokens]  the request's prompt, for a model priced by its length: unknown reads as short
 * @returns {Prices | null}
 */
export function pricesFor(model, fast = false, promptTokens = null) {
  const key = modelKey(model)
  if (key === null) return null
  if (fast && Object.hasOwn(FAST, key)) return FAST[key]
  const { long, ...card } = MODEL_TIER[key]
  const isLong = long !== undefined && typeof promptTokens === 'number' && promptTokens > long.above
  return isLong ? { input: long.input, output: long.output, write5m: long.write5m, write1h: long.write1h, read: long.read } : card
}

// ------------------------------------------------------------------- cache

export const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/**
 * What is known about the prompt cache of a session's main thread.
 * `lastAt` is when a request last read or wrote it (the TTL counts from a request's start).
 * `lastAt` null with `observed` true: requests were sent, but the last one cached nothing.
 * `fallback`: no request measured, its start known (questionClock); its TTL is the fallback.
 * @typedef {{
 *   observed: boolean,
 *   lastAt: number | null,
 *   ttl: '5m' | '1h' | null,
 *   source: 'claude' | 'transcript' | 'fallback',
 *   recacheTokens: number | null,
 *   hitRatio?: number | null,
 *   misses?: number | null,
 *   lastMissCauses?: string[] | null,
 * }} CacheFacts
 */

/**
 * Claude Code's own tracker, as the status line hands it over (`prompt_cache`). Its `expires_at`
 * already counts fork agents that read the main thread's cache, which a transcript cannot show.
 * @param {unknown} pc
 * @returns {CacheFacts | null}
 */
export function cacheFromPromptCache(pc) {
  if (!isObj(pc)) return null
  const ttl = pc.ttl === '1h' || pc.ttl === '5m' ? pc.ttl : null
  const expiresAt = num(pc.expires_at)
  const causes = isObj(pc.last_miss_cause) && Array.isArray(pc.last_miss_cause.causes) ? pc.last_miss_cause.causes.filter(isStr) : null
  return {
    observed: pc.caching_observed === true || expiresAt !== null,
    lastAt: expiresAt === null ? null : expiresAt * 1000 - TTL_MS[ttl ?? '5m'],
    ttl,
    source: 'claude',
    recacheTokens: num(pc.recache_tokens_if_cold),
    hitRatio: num(pc.hit_ratio),
    misses: num(pc.misses),
    lastMissCauses: causes,
  }
}

/**
 * The last main-thread request in the tail of a transcript (`.jsonl`). Used where this process has
 * sent no request yet (a resumed session), whose cache the server may still hold.
 *
 * The TTL comes from the response itself (`usage.cache_creation.ephemeral_1h_input_tokens` versus
 * `_5m_`); a request that wrote nothing keeps the TTL of the one before, as Claude Code's tracker
 * does. The start time is the latest `user` entry before the reply (the prompt or the tool results
 * it answered): the reply's own timestamp is written after it streamed, minutes late on a long one.
 * @param {string} tail  the end of the file
 * @param {boolean} wholeFile  the tail starts at the beginning of the file, so its first line is whole
 * @returns {(CacheFacts & { model: string | null }) | null}
 */
export function cacheFromTranscript(tail, wholeFile) {
  if (typeof tail !== 'string' || tail === '') return null
  const lines = tail.split('\n')
  if (!wholeFile) lines.shift()
  const entries = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // a line torn by a concurrent write
    }
  }
  let last = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isMainReply(entries[i])) {
      last = i
      break
    }
  }
  if (last < 0) return null
  const message = entries[last].message
  let first = last
  while (first > 0 && isMainReply(entries[first - 1]) && entries[first - 1].message.id === message.id) first--

  let startedAt = null
  let anyAt = null
  for (let i = first - 1; i >= 0; i--) {
    const e = entries[i]
    if (!isObj(e) || e.isSidechain === true) continue
    const t = Date.parse(e.timestamp)
    if (!Number.isFinite(t)) continue
    if (anyAt === null) anyAt = t
    if (e.type === 'user') {
      startedAt = t
      break
    }
  }
  if (startedAt === null) startedAt = anyAt ?? Date.parse(entries[first].timestamp)
  if (!Number.isFinite(startedAt)) return null

  const u = message.usage
  const input = whole(u.input_tokens)
  const read = whole(u.cache_read_input_tokens)
  const written = whole(u.cache_creation_input_tokens)
  let ttl = ttlOfUsage(u)
  for (let i = first - 1; i >= 0 && ttl === null; i--) if (isMainReply(entries[i])) ttl = ttlOfUsage(entries[i].message.usage)
  const observed = read + written > 0
  return {
    observed,
    lastAt: observed ? startedAt : null,
    ttl,
    source: 'transcript',
    recacheTokens: input + read + written,
    model: isStr(message.model) ? message.model : null,
  }
}

function isMainReply(e) {
  return (
    isObj(e) &&
    e.type === 'assistant' &&
    e.isSidechain !== true &&
    isObj(e.message) &&
    isObj(e.message.usage) &&
    e.message.model !== '<synthetic>'
  )
}

function ttlOfUsage(u) {
  const cc = isObj(u) ? u.cache_creation : undefined
  if (!isObj(cc)) return null
  if (whole(cc.ephemeral_1h_input_tokens) > 0) return '1h'
  if (whole(cc.ephemeral_5m_input_tokens) > 0) return '5m'
  return null
}

// ---------------------------------------------------------------- snapshot

/**
 * Everything the strip draws for one session, in one JSON-safe object. The status line writes it to
 * `live/<session>.json` on every run; the module above the prompt reads it there.
 * `source`: 'statusline' when Claude Code's tracker fed it, 'usage' when only `$.session.usage()` did.
 * @typedef {{
 *   v: 1, at: number, source: 'statusline' | 'usage', sessionId: string | null, sessionName: string | null, cwd: string | null,
 *   transcriptPath: string | null, model: string | null, fast: boolean,
 *   cache: CacheFacts | null,
 *   context: { tokens: number | null, window: number | null },
 *   limits: { fiveHour: Limit | null, sevenDay: Limit | null, scoped?: ScopedLimit[] | null },
 *   costUsd: number | null,
 * }} Snapshot
 * @typedef {{ pct: number, resetsAt: number | null }} Limit
 */

/**
 * @param {any} j  the JSON Claude Code pipes to a status line command
 * @param {CacheFacts | null} fromTranscript  the fallback, for a session with no request in this process yet
 * @param {number} now
 * @returns {Snapshot}
 */
export function snapshotOfStatusLine(j, fromTranscript, now) {
  const o = isObj(j) ? j : {}
  const cw = isObj(o.context_window) ? o.context_window : {}
  const tokens = num(cw.total_input_tokens)
  const rl = isObj(o.rate_limits) ? o.rate_limits : {}
  return {
    v: 1,
    at: now,
    source: 'statusline',
    sessionId: str(o.session_id),
    sessionName: str(o.session_name),
    cwd: str(isObj(o.workspace) ? o.workspace.current_dir : null) ?? str(o.cwd),
    transcriptPath: str(o.transcript_path),
    model: str(isObj(o.model) ? o.model.id : null),
    fast: o.fast_mode === true,
    cache: cacheFromPromptCache(o.prompt_cache) ?? fromTranscript ?? null,
    context: { tokens: tokens === 0 ? null : tokens, window: num(cw.context_window_size) },
    limits: { fiveHour: limitOfStatusLine(rl.five_hour), sevenDay: limitOfStatusLine(rl.seven_day) },
    costUsd: num(isObj(o.cost) ? o.cost.total_cost_usd : null),
  }
}

function limitOfStatusLine(l) {
  if (!isObj(l)) return null
  const pct = num(l.used_percentage)
  const resets = num(l.resets_at)
  return pct === null ? null : { pct, resetsAt: resets === null ? null : resets * 1000 }
}

/**
 * The same object from `$.session.usage()`, for the module when no status line has run for this
 * session: everything but the cache, which only Claude Code's tracker (the status line) can tell.
 * @param {any} u
 * @param {{ sessionId: string | null, model: string | null, now: number }} meta
 * @returns {Snapshot}
 */
export function snapshotOfUsage(u, meta) {
  const o = isObj(u) ? u : {}
  const ctx = isObj(o.context) ? o.context : {}
  const limits = windowsOfRateLimits(o.rateLimits)
  return {
    v: 1,
    at: meta.now,
    source: 'usage',
    sessionId: meta.sessionId,
    sessionName: null,
    cwd: null,
    transcriptPath: null,
    model: meta.model,
    fast: false,
    cache: null,
    context: { tokens: num(ctx.tokens), window: num(ctx.window) },
    limits,
    costUsd: num(isObj(o.cost) ? o.cost.usd : null),
  }
}

// ---------------------------------------------------------- account limits

/** The endpoint behind Claude Code's /usage: the account's windows as they stand when asked. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** What Claude Code's own client sends with an OAuth bearer. The engine adds the credential itself. */
export const USAGE_HEADERS = Object.freeze({ 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' })

/** How long an account reading stands in for a session's own. Past it, the session's own shows again. */
export const ACCOUNT_MAX_AGE_MS = 30 * 60_000

/** How long one session's claim on the next poll holds the others off. */
export const CLAIM_MS = 15_000

/**
 * Two readings of one window end within this much of each other: the endpoint writes microseconds,
 * the headers whole seconds. Two windows of one login end hours apart.
 */
const SAME_WINDOW_MS = 2 * 3_600_000

/**
 * The account's usage windows as the freshest reading any session has: the usage endpoint's answer,
 * or a response's rate-limit headers. One file (`limits.json`) for every session, so an idle session
 * shows what the busy ones and the endpoint see now, not its own last response.
 * `polledAt` is when the endpoint was last asked, `answeredAt` when it last answered: the model-scoped
 * limits come from nowhere else, so they are as old as that.
 * @typedef {{ name: string, pct: number, resetsAt: number | null }} ScopedLimit
 * @typedef {{
 *   v: 1, at: number, source: 'usage' | 'response',
 *   fiveHour: Limit | null, sevenDay: Limit | null, scoped: ScopedLimit[] | null,
 *   polledAt: number | null, answeredAt: number | null, by: string | null,
 *   failures: number, backoffUntil: number, error: string | null,
 *   claimBy: string | null, claimUntil: number,
 * }} AccountLimits
 */

/** A record with nothing read yet: only the poll's bookkeeping. */
const NO_ACCOUNT = Object.freeze({
  v: 1,
  at: 0,
  source: 'usage',
  fiveHour: null,
  sevenDay: null,
  scoped: null,
  polledAt: null,
  answeredAt: null,
  by: null,
  failures: 0,
  backoffUntil: 0,
  error: null,
  claimBy: null,
  claimUntil: 0,
})

/**
 * The usage endpoint's answer: `five_hour` and `seven_day` as `{ utilization, resets_at }`, and the
 * model-scoped weekly limits (`limits[]` of kind `weekly_scoped`), which no response header carries.
 * @param {unknown} json
 * @returns {{ fiveHour: Limit | null, sevenDay: Limit | null, scoped: ScopedLimit[] } | null}
 */
export function limitsOfUsage(json) {
  if (!isObj(json)) return null
  const fiveHour = limitOfUsage(json.five_hour)
  const sevenDay = limitOfUsage(json.seven_day)
  if (fiveHour === null && sevenDay === null) return null
  const scoped = []
  for (const l of Array.isArray(json.limits) ? json.limits : []) {
    if (!isObj(l) || l.kind !== 'weekly_scoped') continue
    const name = isObj(l.scope) && isObj(l.scope.model) ? str(l.scope.model.display_name) : null
    const pct = num(l.percent)
    if (name !== null && pct !== null) scoped.push({ name, pct, resetsAt: msOfIso(l.resets_at) })
  }
  return { fiveHour, sevenDay, scoped }
}

function limitOfUsage(w) {
  if (!isObj(w)) return null
  const pct = num(w.utilization)
  return pct === null ? null : { pct, resetsAt: msOfIso(w.resets_at) }
}

/**
 * A response's windows, as `session.measure` and `$.session.usage()` hand them over.
 * @param {unknown} rateLimits
 * @returns {{ fiveHour: Limit | null, sevenDay: Limit | null }}
 */
export function windowsOfRateLimits(rateLimits) {
  const limits = { fiveHour: null, sevenDay: null }
  for (const l of Array.isArray(rateLimits) ? rateLimits : []) {
    if (!isObj(l)) continue
    const pct = num(l.percentUsed)
    const limit = pct === null ? null : { pct, resetsAt: msOfIso(l.resetsAt) }
    if (l.kind === 'five_hour') limits.fiveHour = limit
    if (l.kind === 'seven_day') limits.sevenDay = limit
  }
  return limits
}

/**
 * What `limits.json` held, or null where it holds nothing of this shape.
 * @param {unknown} raw
 * @returns {AccountLimits | null}
 */
export function accountOf(raw) {
  if (!isObj(raw) || raw.v !== 1) return null
  const limit = (l) => (isObj(l) && num(l.pct) !== null ? { pct: num(l.pct), resetsAt: num(l.resetsAt) } : null)
  const scoped = Array.isArray(raw.scoped)
    ? raw.scoped.filter((s) => isObj(s) && str(s.name) !== null && num(s.pct) !== null).map((s) => ({ name: s.name, pct: s.pct, resetsAt: num(s.resetsAt) }))
    : null
  return {
    v: 1,
    at: num(raw.at) ?? 0,
    source: raw.source === 'response' ? 'response' : 'usage',
    fiveHour: limit(raw.fiveHour),
    sevenDay: limit(raw.sevenDay),
    scoped,
    polledAt: num(raw.polledAt),
    // A record from 0.2.0 has no `answeredAt`: its last poll answered when it holds no error.
    answeredAt: num(raw.answeredAt) ?? (str(raw.error) === null ? num(raw.polledAt) : null),
    by: str(raw.by),
    failures: whole(raw.failures),
    backoffUntil: num(raw.backoffUntil) ?? 0,
    error: str(raw.error),
    claimBy: str(raw.claimBy),
    claimUntil: num(raw.claimUntil) ?? 0,
  }
}

/**
 * Whether this session asks the usage endpoint now. One session at a time does: the record says when
 * it was last asked, a claim holds the others off while one asks, and a failure backs every session
 * off together. `jitterMs` is fixed per session, so the same session tends to be the one.
 * @param {AccountLimits | null} account
 * @param {number} now
 * @param {{ pollMs: number, me: string, jitterMs: number }} opts
 */
export function isPollDue(account, now, opts) {
  if (opts.pollMs <= 0) return false
  const a = account ?? NO_ACCOUNT
  if (a.backoffUntil > now) return false
  if (a.claimUntil > now && a.claimBy !== opts.me) return false
  return now - (a.polledAt ?? 0) >= opts.pollMs + opts.jitterMs
}

/** The record with this session's claim on the poll it is about to make. */
export function claimed(account, me, now) {
  return { ...(account ?? NO_ACCOUNT), claimBy: me, claimUntil: now + CLAIM_MS }
}

/** The record with an unused claim given back (this session holds no subscription credential). */
export function released(account) {
  return { ...(account ?? NO_ACCOUNT), claimBy: null, claimUntil: 0 }
}

/** The record after a poll that answered. */
export function polled(account, read, me, now) {
  const a = account ?? NO_ACCOUNT
  return { ...a, at: now, source: 'usage', ...read, polledAt: now, answeredAt: now, by: me, failures: 0, backoffUntil: 0, error: null, claimBy: null, claimUntil: 0 }
}

/** The record after a poll that failed: what it held stays, and every session waits, doubling up to 30 min. */
export function pollFailed(account, me, now, why, pollMs) {
  const a = account ?? NO_ACCOUNT
  const failures = a.failures + 1
  const wait = Math.min(30 * 60_000, Math.max(pollMs, 60_000) * 2 ** (failures - 1))
  return { ...a, polledAt: now, by: me, failures, backoffUntil: now + wait, error: String(why).slice(0, 160), claimBy: null, claimUntil: 0 }
}

/**
 * The record after a response moved a window in some session, or null where it is no newer than what
 * the record holds. A response's headers leave the server when its request starts, so after a long turn
 * they trail what another session or the endpoint has read since: taking the latest reading made every
 * strip step back a point. Within one window the figure only grows, so the higher one stands; a window
 * that has ended gives way to a live one; a live window the record does not hold (the next one, or
 * another login's) replaces it.
 * @param {AccountLimits | null} account
 * @param {{ fiveHour: Limit | null, sevenDay: Limit | null }} windows
 * @param {number} now
 * @returns {AccountLimits | null}
 */
export function measured(account, windows, now) {
  const a = account ?? NO_ACCOUNT
  const take = (held, read) => (read === null || isOlderReading(held, read, now) ? held : read)
  const fiveHour = take(a.fiveHour, windows.fiveHour)
  const sevenDay = take(a.sevenDay, windows.sevenDay)
  if (fiveHour === a.fiveHour && sevenDay === a.sevenDay) return null
  return { ...a, at: now, source: 'response', fiveHour, sevenDay }
}

/** Whether a reading of a window is older than the one held: lower in the same window, or from one that has ended. */
function isOlderReading(held, read, now) {
  if (held === null || held.resetsAt === null || read.resetsAt === null) return false
  if (isSameWindow(read, held)) return read.pct < held.pct
  return read.resetsAt < held.resetsAt && read.resetsAt <= now
}

/** Two readings of one window: both say when it resets, and those agree. */
function isSameWindow(a, b) {
  return a !== null && b !== null && a.resetsAt !== null && b.resetsAt !== null && Math.abs(a.resetsAt - b.resetsAt) <= SAME_WINDOW_MS
}

/**
 * Whether the account reading speaks for this session, and if not, why. Two logins can share one
 * config dir: /login replaces the token on disk, but an idle session holds the old one until it sends,
 * and its poll answers for the old login, whose figures then showed in the new login's strips. The
 * weekly window tells them apart while this session's own is live. One reset early reads the same way,
 * so an idle session keeps its own figures until it next sends.
 * @param {Snapshot} snapshot  this session's own
 * @param {AccountLimits | null} account
 * @param {number} now
 * @param {{ isSubscription?: boolean }} [opts]
 * @returns {'applies' | 'none' | 'stale' | 'no-subscription' | 'another-login'}
 */
export function accountFit(snapshot, account, now, opts = {}) {
  if (account === null || (account.fiveHour === null && account.sevenDay === null)) return 'none'
  if (now - account.at > ACCOUNT_MAX_AGE_MS) return 'stale'
  const own = snapshot.limits
  if (opts.isSubscription !== true && own.fiveHour === null && own.sevenDay === null) return 'no-subscription'
  const week = own.sevenDay
  const isOwnWeekLive = week !== null && week.resetsAt !== null && week.resetsAt > now
  if (isOwnWeekLive && account.sevenDay !== null && account.sevenDay.resetsAt !== null && !isSameWindow(week, account.sevenDay)) return 'another-login'
  return 'applies'
}

/**
 * The snapshot with the account's windows in place of the session's own: a session that sends
 * nothing keeps its own last response's figures, while the account reading is at most a poll old.
 * Left alone where the reading does not speak for this session (accountFit). The model-scoped limits
 * only while the endpoint's last answer is fresh (responses keep the record's `at` young, but never
 * carry them), and each only beside the week it was read in: a response that brought another week, or
 * another login's (whose week would otherwise show beside the old login's model limit), leaves it behind.
 * @param {Snapshot} snapshot
 * @param {AccountLimits | null} account
 * @param {number} now
 * @param {{ isSubscription?: boolean }} [opts]
 * @returns {Snapshot}
 */
export function withAccountLimits(snapshot, account, now, opts = {}) {
  if (account === null || accountFit(snapshot, account, now, opts) !== 'applies') return snapshot
  const own = snapshot.limits
  const fresh = account.answeredAt !== null && now - account.answeredAt <= ACCOUNT_MAX_AGE_MS ? account.scoped : null
  const week = account.sevenDay
  const scoped = fresh?.filter((s) => week === null || s.resetsAt === null || week.resetsAt === null || isSameWindow(s, week)) ?? null
  return {
    ...snapshot,
    limits: { fiveHour: account.fiveHour ?? own.fiveHour, sevenDay: account.sevenDay ?? own.sevenDay, scoped: scoped ?? own.scoped ?? null },
  }
}

// ------------------------------------------------------------------ config

/**
 * @typedef {{
 *   ttl: 'auto' | number,
 *   fallbackTtlMinutes: number,
 *   warnMinutes: number,
 *   notify: boolean,
 *   statusLine: 'auto' | 'always' | 'off',
 *   brief: 'paste' | 'send',
 *   limitsPollSeconds: number,
 *   holdColdAt: number,
 * }} Config
 */

/** @type {Config} */
export const DEFAULT_CONFIG = Object.freeze({
  ttl: 'auto',
  fallbackTtlMinutes: 60,
  warnMinutes: 5,
  notify: true,
  statusLine: 'auto',
  brief: 'paste',
  limitsPollSeconds: 60,
  // The cold-send guard: a message typed into a cold session that would re-read this many tokens or
  // more is held (0: never).
  holdColdAt: 150_000,
})

/** The most tokens a threshold may name: past any context window. */
const MAX_TOKENS = 100_000_000

/**
 * A count of tokens as a person types it: `150000`, `150k`, `1.5m`; `off` is 0. Null for anything else.
 * @param {unknown} text
 * @returns {number | null}
 */
export function tokensOf(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/[_,]/g, '')
  if (s === 'off') return 0
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s)
  if (m === null) return null
  const n = Math.round(Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1))
  return Number.isFinite(n) && n >= 0 && n <= MAX_TOKENS ? n : null
}

/**
 * A config from whatever `config.json` held: each field checked, a bad one left at its default.
 * @param {unknown} raw
 * @returns {Config}
 */
export function configOf(raw) {
  const o = isObj(raw) ? raw : {}
  const minutes = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null)
  return {
    ttl: o.ttl === 'auto' ? 'auto' : minutes(o.ttl, 1, 1440) ?? DEFAULT_CONFIG.ttl,
    fallbackTtlMinutes: minutes(o.fallbackTtlMinutes, 1, 1440) ?? DEFAULT_CONFIG.fallbackTtlMinutes,
    warnMinutes: minutes(o.warnMinutes, 0, 120) ?? DEFAULT_CONFIG.warnMinutes,
    notify: typeof o.notify === 'boolean' ? o.notify : DEFAULT_CONFIG.notify,
    statusLine: o.statusLine === 'always' || o.statusLine === 'off' || o.statusLine === 'auto' ? o.statusLine : DEFAULT_CONFIG.statusLine,
    brief: o.brief === 'send' || o.brief === 'paste' ? o.brief : DEFAULT_CONFIG.brief,
    limitsPollSeconds: o.limitsPollSeconds === 0 ? 0 : minutes(o.limitsPollSeconds, 15, 3600) ?? DEFAULT_CONFIG.limitsPollSeconds,
    holdColdAt: Number.isInteger(o.holdColdAt) && o.holdColdAt >= 0 && o.holdColdAt <= MAX_TOKENS ? o.holdColdAt : DEFAULT_CONFIG.holdColdAt,
  }
}

/**
 * CACHE_KEEPER_TTL, the TTL a test in the real engine forces, where config.json is every session's: minutes
 * (1 to 1440) or `auto`, as the `ttl` setting takes them. Null for anything else, which leaves the setting.
 * @param {unknown} text
 * @returns {number | 'auto' | null}
 */
export function ttlOverrideOf(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (s === 'auto') return 'auto'
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= 1440 ? n : null
}

/**
 * The config with the TTL an override forces (ttlOverrideOf); null leaves it as it is.
 * @param {Config} config
 * @param {number | 'auto' | null} ttl
 * @returns {Config}
 */
export function withTtl(config, ttl) {
  return ttl === null ? config : { ...config, ttl }
}

export const CONFIG_USAGE = [
  '/cache-keeper                     status and settings',
  '/cache-keeper handoff             Handoff & Clear, as the button does',
  '/cache-keeper latest              Use Latest Handoff (also /use-latest-handoff): clear, and go on from the handoff',
  '                                  the session wrote, when it did no work after it; no model call',
  '/cache-keeper pack                Pack & Clear (also /pack-and-clear): acct-sync builds a pack from the session',
  '                                  without a model call, then clear and go on from it',
  '/cache-keeper ttl auto|<minutes>  auto = the window Claude Code measured; minutes forces one',
  '/cache-keeper fallback <minutes>  the window to assume when none was measured (default 60)',
  '/cache-keeper warn <minutes>      how long before cold to notify (default 5; 0 = off)',
  '/cache-keeper notify on|off       desktop notification',
  '/cache-keeper statusline auto|always|off  the line under the prompt (auto: only without the strip)',
  '/cache-keeper brief paste|send    after Handoff & Clear, put the brief in the prompt or send it',
  '/cache-keeper limits <sec>|off    how often one session reads the account limits from /usage (default 60)',
  '/cache-keeper hold <tokens>|off   hold a message typed into a cold session that would re-read this many',
  '                                  tokens or more (default 150k); Enter again sends it, the buttons carry it',
  '/cache-keeper test-notify         send the notification now',
].join('\n')

/**
 * One `/cache-keeper <key> <value>` edit.
 * @param {Config} config
 * @param {string} args
 * @returns {{ config: Config, text: string } | { error: string } | { action: 'status' | 'test-notify' | 'handoff' | 'latest' | 'pack' }}
 */
export function configEdit(config, args) {
  const words = String(args ?? '').trim().toLowerCase().split(/\s+/).filter((w) => w !== '')
  const [key, value] = words
  if (key === undefined || key === 'status') return { action: 'status' }
  if (key === 'test-notify') return { action: 'test-notify' }
  if (key === 'handoff') return { action: 'handoff' }
  if (key === 'latest') return { action: 'latest' }
  if (key === 'pack') return { action: 'pack' }
  const n = value === undefined ? NaN : Number(value)
  const set = (patch, text) => ({ config: configOf({ ...config, ...patch }), text })
  switch (key) {
    case 'ttl':
      if (value === 'auto') return set({ ttl: 'auto' }, 'TTL: auto (the window Claude Code measured, else the fallback)')
      if (Number.isFinite(n) && n >= 1 && n <= 1440) return set({ ttl: n }, `TTL: forced to ${n} min`)
      return { error: 'ttl takes auto or 1-1440 minutes' }
    case 'fallback':
      if (Number.isFinite(n) && n >= 1 && n <= 1440) return set({ fallbackTtlMinutes: n }, `Fallback TTL: ${n} min`)
      return { error: 'fallback takes 1-1440 minutes' }
    case 'warn':
      if (Number.isFinite(n) && n >= 0 && n <= 120) return set({ warnMinutes: n }, n === 0 ? 'Warning: off' : `Warning: ${n} min before cold`)
      return { error: 'warn takes 0-120 minutes' }
    case 'notify':
      if (value === 'on' || value === 'off') return set({ notify: value === 'on' }, `Desktop notification: ${value}`)
      return { error: 'notify takes on or off' }
    case 'statusline':
      if (value === 'auto' || value === 'always' || value === 'off') return set({ statusLine: value }, `Status line: ${value}`)
      return { error: 'statusline takes auto, always or off' }
    case 'brief':
      if (value === 'paste' || value === 'send') return set({ brief: value }, `After Handoff & Clear the brief is ${value === 'paste' ? 'pasted into the prompt' : 'sent'}`)
      return { error: 'brief takes paste or send' }
    case 'limits':
      if (value === 'off' || value === '0') return set({ limitsPollSeconds: 0 }, "Account limits: not polled; the strip shows what this and the other sessions' responses report")
      if (Number.isFinite(n) && n >= 15 && n <= 3600) return set({ limitsPollSeconds: n }, `Account limits: read from the usage endpoint every ${n} s, by one session at a time`)
      return { error: 'limits takes off or 15-3600 seconds' }
    case 'hold': {
      const tokens = value === undefined ? null : tokensOf(value)
      if (tokens === 0) return set({ holdColdAt: 0 }, 'Cold-send guard: off; a message to a cold cache is sent as typed')
      if (tokens !== null && tokens >= 1000) return set({ holdColdAt: tokens }, `Cold-send guard: a message typed into a cold session is held when it would re-read ${tokenLabel(tokens)} tokens or more`)
      return { error: 'hold takes off or a number of tokens, 1000 or more (150000, 150k, 1.5m)' }
    }
    default:
      return { error: `unknown setting "${key}"\n${CONFIG_USAGE}` }
  }
}

// -------------------------------------------------------------------- view

/**
 * `unknown`: nothing can tell (no status line has run for this session); `none`: no request yet.
 * @typedef {{
 *   state: 'unknown' | 'none' | 'off' | 'warm' | 'warning' | 'cold',
 *   ttlMs: number, ttlLabel: string, assumed: boolean,
 *   expiresAt: number | null, remainingMs: number | null,
 *   source: 'claude' | 'transcript' | 'override' | 'fallback' | null,
 *   isAssumedCold?: true,
 * }} CacheView
 * `tokensFrom`: which reading `tokensIfCold` is (newestTokens), and when it was read. `clock`: what `cache` counts
 * from (questionClock), and the start of the turn whose question is open, if one is (else null).
 * @typedef {{
 *   cache: CacheView, clock: { name: 'snapshot' | 'turn-start', turnAt: number | null }, tokensIfCold: number | null,
 *   tokensFrom: { source: 'statusline' | 'usage' | null, at: number | null },
 *   next: { warm: number, cold: number } | null,
 *   snapshot: Snapshot,
 * }} View
 */

/**
 * @param {CacheFacts | null} facts
 * @param {number} now
 * @param {Config} config
 * @param {boolean} [knowable]  false where no status line feeds the facts, so their absence means nothing
 * @returns {CacheView}
 */
export function cacheView(facts, now, config, knowable = true) {
  const forced = typeof config.ttl === 'number' ? config.ttl * 60_000 : null
  const measured = facts !== null && facts.ttl !== null ? TTL_MS[facts.ttl] : null
  const ttlMs = forced ?? measured ?? config.fallbackTtlMinutes * 60_000
  const assumed = forced === null && measured === null
  const ttlLabel = minutesLabel(ttlMs) + (assumed ? '?' : '')
  const source = forced !== null ? 'override' : measured !== null ? facts.source : facts !== null ? 'fallback' : null
  if (facts === null) return { state: knowable ? 'none' : 'unknown', ttlMs, ttlLabel, assumed, expiresAt: null, remainingMs: null, source }
  if (facts.lastAt === null) return { state: 'off', ttlMs, ttlLabel, assumed, expiresAt: null, remainingMs: null, source }
  const expiresAt = facts.lastAt + ttlMs
  const remainingMs = expiresAt - now
  const state = remainingMs <= 0 ? 'cold' : remainingMs <= config.warnMinutes * 60_000 ? 'warning' : 'warm'
  return { state, ttlMs, ttlLabel, assumed, expiresAt, remainingMs, source }
}

/**
 * What the session usage said, read by the module: the input tokens of the live window's last
 * response, and when it was read.
 * @typedef {{ tokens: number, at: number }} UsageReading
 */

/**
 * The input tokens of the live window's last response, from `$.session.usage()`: uncached,
 * cache-written and cache-read together. Null before the first response (or after a compaction).
 * @param {unknown} u
 * @returns {number | null}
 */
export function usageTokens(u) {
  const ctx = isObj(u) && isObj(u.context) ? u.context : {}
  return whole(ctx.tokens) > 0 ? ctx.tokens : null
}

/**
 * The newest figure for what the next request re-reads once the cache is cold. Two readings count the
 * same tokens, the last request's whole prompt: the snapshot's (Claude Code's cache tracker, else the
 * context size, as the status line wrote them, or an earlier usage read) and the session usage's, read
 * by the module. The one read later is the newer figure: the status line is not run while Claude's
 * question is open, and the one written before a session's first request has no figure at all. A tie
 * goes to the snapshot. A reading without a figure gives none.
 * @param {Snapshot} snapshot
 * @param {UsageReading | null} [usage]
 * @returns {{ tokens: number | null, source: 'statusline' | 'usage' | null, at: number | null }}
 */
export function newestTokens(snapshot, usage = null) {
  const recache = snapshot.cache?.recacheTokens ?? null
  const own = recache !== null && recache > 0 ? recache : snapshot.context.tokens !== null && snapshot.context.tokens > 0 ? snapshot.context.tokens : null
  const read = isObj(usage) && whole(usage.tokens) > 0 && Number.isFinite(usage.at) ? usage : null
  if (read !== null && (own === null || read.at > snapshot.at)) return { tokens: read.tokens, source: 'usage', at: read.at }
  return own === null ? { tokens: null, source: null, at: null } : { tokens: own, source: snapshot.source, at: snapshot.at }
}

/**
 * The cache's clock while Claude's question is open. The status line is not run then, so the snapshot's last
 * request can be one before the request that asked, or none; that one read the cache at its start, at or after
 * the start of its turn. So the clock is the later of the two: never later than the real last touch, so it
 * can't miss a hold. It can be early, by the time from the later of the two to the asking request's start: next
 * to nothing when the turn's first request asks; where earlier requests of the turn ran first, the time since
 * the start of the last one the status line saw, as with the snapshot alone. Not the time the question opened:
 * the request asks at its end, past the time it read the cache.
 *
 * No request measured yet (`none`: a status line ran, nothing cached so far): the turn's start, on the
 * fallback TTL. Unchanged: nothing knowable (`unknown`), caching off (`lastAt` null), and no turn start known
 * (the module loaded again mid-turn).
 * @param {CacheFacts | null} facts  the snapshot's
 * @param {number | null} turnAt  when the turn whose question is open started, by the module's clock; null: none
 * @param {boolean} knowable  a status line feeds the facts, so their absence means no request yet
 * @returns {{ facts: CacheFacts | null, clock: 'snapshot' | 'turn-start' }}
 */
export function questionClock(facts, turnAt, knowable) {
  if (typeof turnAt !== 'number' || !Number.isFinite(turnAt)) return { facts, clock: 'snapshot' }
  if (facts === null) {
    return knowable ? { facts: { observed: true, lastAt: turnAt, ttl: null, source: 'fallback', recacheTokens: null }, clock: 'turn-start' } : { facts, clock: 'snapshot' }
  }
  if (facts.lastAt === null || facts.lastAt >= turnAt) return { facts, clock: 'snapshot' }
  return { facts: { ...facts, lastAt: turnAt }, clock: 'turn-start' }
}

/**
 * @param {Snapshot} snapshot
 * @param {number} now
 * @param {Config} config
 * @param {{ assumeCold?: boolean, usage?: UsageReading | null, turnAt?: number | null }} [opts]  `assumeCold`: the
 *   cache counts as cold whatever was measured (CACHE_KEEPER_ASSUME_COLD, for a test in the real engine); `usage`:
 *   the session usage's figure, which stands where it is newer than the snapshot's (newestTokens); `turnAt`: the
 *   start of the turn whose question is open, which the cache's clock counts from where it is later (questionClock)
 * @returns {View}
 */
export function viewOf(snapshot, now, config, opts = {}) {
  const knowable = snapshot.source !== 'usage'
  const turnAt = typeof opts.turnAt === 'number' && Number.isFinite(opts.turnAt) ? opts.turnAt : null
  const asked = questionClock(snapshot.cache, turnAt, knowable)
  const measured = cacheView(asked.facts, now, config, knowable)
  const cache = opts.assumeCold === true ? { ...measured, state: 'cold', isAssumedCold: true } : measured
  const figure = newestTokens(snapshot, opts.usage ?? null)
  const tokensIfCold = figure.tokens
  const prices = pricesFor(snapshot.model, snapshot.fast, tokensIfCold)
  // A cold start writes with the TTL Claude Code asks for, which the last write showed.
  const writeTtl = snapshot.cache?.ttl ?? (config.fallbackTtlMinutes > 5 ? '1h' : '5m')
  const next =
    prices !== null && tokensIfCold !== null && tokensIfCold > 0
      ? { warm: (tokensIfCold * prices.read) / 1e6, cold: (tokensIfCold * (writeTtl === '5m' ? prices.write5m : prices.write1h)) / 1e6 }
      : null
  return { cache, clock: { name: asked.clock, turnAt }, tokensIfCold, tokensFrom: { source: figure.source, at: figure.at }, next, snapshot }
}

/**
 * One piece of the strip. A narrow terminal drops the lowest `priority` first. A `glue` segment is a
 * detail of the one before it: drawn after a space instead of a separator, and gone when it goes.
 * @typedef {{ id: string, text: string, tone: 'good' | 'warn' | 'bad' | 'dim' | 'plain', priority: number, glue?: boolean }} Segment
 */

/**
 * @param {View} view
 * @param {number} now
 * @param {{ seconds: boolean }} opts  `seconds`: the countdown ticks every second (the strip), or in minutes (the status line)
 * @returns {Segment[]}
 */
export function segmentsOf(view, now, opts) {
  const { cache, next, snapshot } = view
  const out = []
  const left = cache.remainingMs ?? 0
  switch (cache.state) {
    case 'unknown':
      out.push(seg('cache', '○ cache ?', 'dim', 100))
      break
    case 'none':
      out.push(seg('cache', '○ no cache yet', 'dim', 100))
      break
    case 'off':
      out.push(seg('cache', '○ cache off', 'dim', 100))
      break
    case 'cold':
      out.push(seg('cache', cache.isAssumedCold ? '○ cache cold (assumed)' : '○ cache cold', 'bad', 100))
      break
    default:
      out.push(seg('cache', `● cache ${opts.seconds ? countdown(left) : minutesLeft(left)}`, cache.state === 'warning' ? 'warn' : 'good', 100))
  }
  // An assumed cold state has no time of its own: the measured expiry may still be ahead.
  if (cache.expiresAt !== null && cache.isAssumedCold !== true) {
    const when = clockLabel(cache.expiresAt, now)
    out.push(seg('expiry', cache.state === 'cold' ? `since ${when}` : `→${when} ${cache.ttlLabel}`, 'dim', 40, true))
  }
  if (next !== null && cache.state !== 'off' && cache.state !== 'unknown') {
    if (cache.state === 'cold') out.push(seg('next', `next msg ${usd(next.cold)}`, 'bad', 90))
    else if (cache.state === 'none') out.push(seg('next', `next msg ${usd(next.cold)}`, 'plain', 90))
    // One segment: the price once cold is the point, the warm one what it is weighed against.
    else out.push(seg('next', `next msg ${usd(next.warm)}, cold ${usd(next.cold)}`, cache.state === 'warning' ? 'warn' : 'plain', 90))
  }
  const { tokens, window } = snapshot.context
  if (tokens !== null) {
    out.push(seg('ctx', `ctx ${tokenLabel(tokens)}`, 'plain', 80))
    if (window !== null) out.push(seg('ctx-window', `/${tokenLabel(window)}`, 'dim', 30, true, true))
  }
  const { fiveHour, sevenDay } = snapshot.limits
  if (fiveHour !== null) {
    out.push(seg('5h', `5h ${pctLabel(fiveHour.pct)}`, pctTone(fiveHour.pct), 70))
    if (fiveHour.resetsAt !== null) out.push(seg('5h-reset', `↻${clockLabel(fiveHour.resetsAt, now)}`, 'dim', 20, true))
  }
  if (sevenDay !== null) {
    out.push(seg('7d', `wk ${pctLabel(sevenDay.pct)}`, pctTone(sevenDay.pct), 65))
    if (sevenDay.resetsAt !== null) out.push(seg('7d-reset', `↻${dayLabel(sevenDay.resetsAt, now)}`, 'dim', 15, true))
  }
  // A model's own weekly limit (`Fable 80%`), which only the usage endpoint reports.
  for (const s of snapshot.limits.scoped ?? []) out.push(seg(`scoped:${s.name}`, `${s.name} ${pctLabel(s.pct)}`, pctTone(s.pct), 64))
  if (snapshot.costUsd !== null) out.push(seg('cost', `session ${usd(snapshot.costUsd)} API`, 'plain', 60))
  return out
}

/**
 * The segments that fit in `width` columns, in their order, dropping the lowest priority first.
 * @param {Segment[]} segments
 * @param {number} width
 * @param {number} separator  the width of what is drawn between two segments that are not glued
 * @returns {Segment[]}
 */
export function fit(segments, width, separator) {
  const kept = segments.filter((s, i) => !(s.glue && i === 0))
  while (lineWidth(kept, separator) > width) {
    // The last segment standing stays, cut short where it is drawn; only its details can still go.
    const isLastParent = kept.filter((s) => !s.glue).length <= 1
    let low = -1
    for (let i = 0; i < kept.length; i++) {
      if (isLastParent && !kept[i].glue) continue
      if (low < 0 || kept[i].priority < kept[low].priority) low = i
    }
    if (low < 0) break
    let end = low + 1
    if (!kept[low].glue) while (end < kept.length && kept[end].glue) end++
    kept.splice(low, end - low)
  }
  return kept
}

/** What a run of segments takes on screen. */
export function lineWidth(segments, separator) {
  return segments.reduce((sum, s, i) => sum + widthOf(s.text) + (i === 0 ? 0 : joinerOf(s, separator)), 0)
}

const joinerOf = (s, separator) => (s.tight ? 0 : s.glue ? 1 : separator)

/** Columns a string takes, counting each code point as one (the strip draws no wide characters). */
export const widthOf = (text) => [...text].length

const ANSI = { good: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[2m', plain: '' }

/**
 * @param {Segment[]} segments
 * @returns {string}
 */
export function ansiLine(segments) {
  return segments
    .map((s, i) => {
      const joiner = i === 0 ? '' : s.tight ? '' : s.glue ? ' ' : '\x1b[2m · \x1b[0m'
      return joiner + (ANSI[s.tone] ? `${ANSI[s.tone]}${s.text}\x1b[0m` : s.text)
    })
    .join('')
}

// ------------------------------------------------------------ notification

/**
 * @param {View} view
 * @returns {{ title: string, body: string }}
 */
export function warningNotice(view) {
  const s = view.snapshot
  const mins = Math.max(1, Math.ceil((view.cache.remainingMs ?? 0) / 60_000))
  const who = s.sessionName ?? baseName(s.cwd) ?? 'a Claude Code session'
  const facts = [
    view.tokensIfCold !== null ? `${tokenLabel(view.tokensIfCold)} tokens cached` : null,
    view.next !== null ? `next message ${usd(view.next.warm)} now, ${usd(view.next.cold)} once cold` : null,
  ].filter((x) => x !== null)
  return {
    title: `Cache goes cold in ${mins} min · ${who}`,
    body: `${facts.length > 0 ? `${facts.join(' · ')}. ` : ''}Send a message to keep it warm, or press Handoff & Clear.`,
  }
}

/**
 * What Windows PowerShell runs to show the toast: one fixed text, the same for every notification. The
 * title, body and tag reach it as environment variables (`$env:CACHE_KEEPER_TOAST_*`), never as code,
 * so nothing a session is named can change what runs, and the command line carries no encoded payload.
 * Only .NET and WinRT calls, no cmdlet, so a module path inherited from PowerShell 7 cannot break it;
 * no double quote, so a command line has nothing to re-split.
 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$x = [Windows.Data.Xml.Dom.XmlDocument]::new()',
  "$x.LoadXml('<toast><visual><binding template=''ToastGeneric''><text></text><text></text></binding></visual></toast>')",
  "$n = $x.GetElementsByTagName('text')",
  '[void]$n.Item(0).AppendChild($x.CreateTextNode([string]$env:CACHE_KEEPER_TOAST_TITLE))',
  '[void]$n.Item(1).AppendChild($x.CreateTextNode([string]$env:CACHE_KEEPER_TOAST_BODY))',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($x)',
  '$toast.Tag = [string]$env:CACHE_KEEPER_TOAST_TAG',
  "$toast.Group = 'cache-keeper'",
  // Windows PowerShell's own app id (the System32 known-folder GUID): the toast shows under its name.
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join('; ')

/**
 * The command that shows a desktop notification, and the variables it reads, or null where there is
 * none to use. Windows: a toast through Windows PowerShell (5.1, which projects the WinRT notification
 * API that PowerShell 7 does not), running TOAST_SCRIPT with the texts in its environment. A `-File`
 * script would need its execution policy lifted on a machine that keeps the default (Restricted);
 * a command text needs none. macOS and Linux take the texts as arguments, which no shell reads.
 * @param {string} platform  process.platform
 * @param {{ title: string, body: string, tag?: string }} notice
 * @returns {{ argv: string[], env: Record<string, string> } | null}
 */
export function notifyArgv(platform, notice) {
  const title = notice.title.slice(0, 200)
  const body = notice.body.slice(0, 600)
  if (platform === 'win32') {
    const tag = (notice.tag ?? 'cache-keeper').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || 'cache-keeper'
    return {
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', TOAST_SCRIPT],
      env: { CACHE_KEEPER_TOAST_TITLE: title, CACHE_KEEPER_TOAST_BODY: body, CACHE_KEEPER_TOAST_TAG: tag },
    }
  }
  if (platform === 'darwin') {
    return { argv: ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], env: {} }
  }
  if (platform === 'linux') return { argv: ['notify-send', '--app-name=Claude Code', title, body], env: {} }
  return null
}

// ----------------------------------------------------------------- handoff

export const HANDOFF_MARK = '[Cache Keeper · Handoff & Clear]'

/** The prompt the Handoff & Clear button sends. Claude answers with the brief and nothing else. */
export function handoffPrompt() {
  return [
    `${HANDOFF_MARK} Write a handoff brief so that a fresh session, which will remember nothing of this one, can carry on the work. Right after your reply this session is cleared and the brief is pasted into the new one.`,
    '',
    'Rules:',
    '- Do not call any tools. Write from what you already know.',
    '- Reply with the brief only, between <handoff> and </handoff>.',
    '- Be specific: real paths, commands, ids, numbers and versions. No filler, no recap of these rules.',
    '- Keep it as short as it can be while still complete; well under 900 words.',
    '',
    'Use these sections, leaving out any that would be empty:',
    '## Goal',
    '## Where things stand (done, in progress, and the evidence for each)',
    "## Decisions and constraints (including the user's stated preferences)",
    '## Key files and places (path:line and what is there)',
    '## Commands and checks (what was run and what it showed)',
    '## Open questions and risks',
    '## Next steps (ordered and concrete)',
  ].join('\n')
}

/**
 * The brief out of Claude's answer: what sits between the tags, or the whole answer when it forgot them.
 * @param {unknown} answer
 * @returns {string | null}
 */
export function briefOf(answer) {
  if (typeof answer !== 'string') return null
  const tagged = /<handoff>([\s\S]*?)<\/handoff>/i.exec(answer)
  const text = (tagged !== null ? tagged[1] : answer).trim()
  return text.length >= 40 ? text : null
}

/**
 * What lands in the fresh session's prompt box.
 * @param {string} brief
 * @param {{ sessionName: string | null, sessionId: string | null, at: number }} from
 * @returns {string}
 */
export function pastedBrief(brief, from) {
  const who = from.sessionName ?? (from.sessionId !== null ? from.sessionId.slice(0, 8) : 'the previous session')
  return `Continue from this handoff brief, written by my previous session (${who}, ${new Date(from.at).toISOString().slice(0, 16).replace('T', ' ')} UTC; /resume still opens its full transcript).\n\n${brief}\n`
}

/** A file name for a saved brief: sortable, and safe on every file system. */
export function briefFileName(at, sessionId) {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${(sessionId ?? 'session').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)}.md`
}

// ------------------------------------------------- once the cache is cold

/**
 * Once the cache is cold, Handoff & Clear would send the whole conversation again at the cache-write
 * price to ask for its brief. Two ways need no model call: the handoff the session already wrote,
 * when nothing was done after it (Use Latest Handoff), and a pack acct-sync builds from the
 * transcript (Pack & Clear).
 */

// The same rule as acct-sync's isHandoffDoc. Most files sessions write in those folders are side
// notes (PR bodies, step logs, drafts, release notes): only a handoff may stand in for the conversation.
const HANDOFF_PATH = /[\\/]\.claude[^\n]*[\\/](handoffs[\\/][^\n]+\.md|hub[\\/][^\n]*handoff[^\\/\n]*\.md)$/i
const HANDOFF_STAMP = /^(\d{4}-\d{2}-\d{2}|\d{8})[-T_ ]?\d{4}/
const BRIEF_DIR = /[\\/]\.claude[^\n]*[\\/](autohandoff[\\/]briefs|cache-keeper[\\/]handoffs)[\\/][^\\/\n]+$/i
/** The first line of a handoff whose name does not say it is one. */
export const HANDOFF_HEADING = /^\uFEFF?#\s+([^\n]{0,40}?\s)?hand-?off\b/i

/**
 * Whether a file is a handoff document, from its path: `yes`, `no`, or `heading` when only its first
 * line can tell (a file under handoffs/ named neither for its time nor "handoff"). Under
 * `handoffs/<project>/` (not its `acct/` packs) a handoff is named for when it was written
 * (`2026-01-31-0930-<slug>.md`) or has "handoff" in its name; under `hub/` it has "handoff" in its
 * name. A brief Cache Keeper or autohandoff saved for this session counts too.
 * @param {unknown} path
 * @param {string | null} sessionId
 * @returns {'yes' | 'no' | 'heading'}
 */
export function handoffDocKind(path, sessionId) {
  const f = String(path ?? '').replace(/\\/g, '/')
  if (!/\.md$/i.test(f)) return 'no'
  const base = f.slice(f.lastIndexOf('/') + 1)
  const sid8 = String(sessionId ?? '').slice(0, 8)
  if (BRIEF_DIR.test(f)) return sid8.length === 8 && base.endsWith(`-${sid8}.md`) ? 'yes' : 'no'
  if (!HANDOFF_PATH.test(f) || /\/acct\//i.test(f)) return 'no'
  return /handoff/i.test(base) || HANDOFF_STAMP.test(base) ? 'yes' : 'heading'
}

/** The hub whose own handoff a file is (`hub/<id>/hub-handoff.md`): that hub resumes with `/hub resume <id>`. */
export function hubOf(path) {
  const m = /[\\/]\.claude[^\n]*[\\/]hub[\\/]([A-Za-z0-9_.-]+)[\\/]hub-handoff\.md$/i.exec(String(path ?? ''))
  return m === null ? null : m[1]
}

/**
 * The handoff this session can go on from, as handoff-guard recorded it in `live/<sid>.json`: its
 * newest handoff, with no work done after it. Or why there is none.
 * @param {unknown} record
 * @param {string | null} sessionId
 * @returns {{ path: string, at: number, hub: string | null, check: boolean } | { why: string }}
 *          `check`: the path alone does not say it is a handoff; its first line must
 */
export function latestHandoff(record, sessionId) {
  if (!isObj(record) || record.v !== 1 || sessionId === null || record.sid !== sessionId) return { why: 'handoff-guard keeps no record of this session' }
  if (record.role === 'worker') return { why: "a hub worker's handoff is its hub's to use" }
  if (record.endedAt !== null && record.endedAt !== undefined) return { why: 'its handoff-guard record says the session ended' }
  const track = isObj(record.track) ? record.track : {}
  const path = isStr(track.handoffPath) && track.handoffPath !== '' ? track.handoffPath.replace(/\\/g, '/') : null
  const at = num(track.handoffAt) ?? 0
  const after = whole(track.turnsAfter) ?? 0
  if (path === null || at <= 0) return { why: 'the session has written no handoff' }
  if (record.upToDate !== true) return { why: `the session did more work after its last handoff (${after} turn${after === 1 ? '' : 's'} since ${baseName(path)})` }
  const kind = handoffDocKind(path, sessionId)
  if (kind === 'no') return { why: `the newest file it wrote among the handoffs, ${baseName(path)}, is not a handoff` }
  return { path, at, hub: hubOf(path), check: kind === 'heading' }
}

/** How the fresh session is told who wrote what it goes on from. */
function whoOf(from) {
  return from.sessionName ?? (from.sessionId !== null ? from.sessionId.slice(0, 8) : 'the previous session')
}
const utc = (at) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/**
 * What lands in the fresh session's prompt after Use Latest Handoff. A hub's own handoff is the hub's
 * to resume. Begins as a brief does, so autohandoff keeps it for what it is while it waits unsent.
 * @param {{ path: string, at: number, hub: string | null }} latest
 * @param {{ sessionName: string | null, sessionId: string | null, at: number }} from
 */
export function pastedLatest(latest, from) {
  if (latest.hub !== null) return `/hub resume ${latest.hub}\n`
  return [
    `Continue from this handoff brief, written by my previous session (${whoOf(from)}) at ${utc(latest.at)}, before its prompt cache went cold; it did no work after that. Read ${latest.path} in full first, then carry on from it.`,
    '',
    '/clear kept the process: shells, subagents and schedules the old conversation started keep running, and their notices may arrive here.',
    '',
  ].join('\n')
}

/**
 * What lands in the fresh session's prompt after Pack & Clear.
 * @param {string} pack
 * @param {{ sessionName: string | null, sessionId: string | null, at: number }} from
 */
export function pastedPack(pack, from) {
  return `Continue from this handoff brief: a pack acct-sync built, without a model call, from my previous session (${whoOf(from)}, cleared at ${utc(from.at)} because its prompt cache had gone cold). Read ${pack} in full first, then carry on from it.\n`
}

/** The acct-sync command that builds the pack: a transcript by session id, or an engine export by its path. */
export function packArgv(tool, ref) {
  return ['node', tool, 'handoff', ref, '--kind', 'clear', '--json']
}

/**
 * What an acct-sync run came to: the pack, or that it found no transcript (the engine's export is
 * the way then), or what went wrong.
 * @param {{ exitCode?: unknown, stdout?: unknown, stderr?: unknown } | null | undefined} run
 * @returns {{ pack: string, tokens: number | null } | { missing: true } | { error: string }}
 */
export function packOf(run) {
  const stderr = str(run?.stderr) ?? ''
  if (/no session matches/i.test(stderr)) return { missing: true }
  const out = str(run?.stdout) ?? ''
  const start = out.indexOf('{')
  let json = null
  try {
    json = start >= 0 ? JSON.parse(out.slice(start)) : null
  } catch {
    json = null
  }
  if (run?.exitCode === 0 && isObj(json) && isStr(json.pack) && json.pack !== '') return { pack: json.pack, tokens: num(json.tokens) }
  const said = (stderr.trim() || out.trim()).replace(/^acct-sync:\s*/, '').replace(/\s+/g, ' ').slice(0, 200)
  return { error: said !== '' ? said : `acct-sync ended with exit code ${String(run?.exitCode ?? '?')}` }
}

// ------------------------------------------------------- the cold-send guard

/**
 * A message the guard holds back from a cold send, or an answer to Claude's question held the same way,
 * as `live/<session>.held.json` keeps it: Enter on the same text sends it, the cold-cache ways carry it.
 * @typedef {{ v: 1, sid: string, kind: 'prompt' | 'answer', text: string, at: number, attachments: number }} Held
 */

/**
 * What `live/<session>.held.json` holds for this session, or null (none, another session's, or a used one).
 * @param {unknown} raw
 * @param {string | null} sessionId
 * @returns {Held | null}
 */
export function heldOf(raw, sessionId) {
  if (!isObj(raw) || raw.v !== 1 || sessionId === null || raw.sid !== sessionId || !isStr(raw.text) || raw.text.trim() === '') return null
  return {
    v: 1,
    sid: raw.sid,
    kind: raw.kind === 'answer' ? 'answer' : 'prompt',
    text: raw.text,
    at: num(raw.at) ?? 0,
    attachments: whole(raw.attachments),
  }
}

/** The person's own words: typed at the terminal or sent through Remote Control. No origin at all counts too. */
export function isPersonOrigin(origin) {
  if (origin === undefined || origin === null) return true
  return isObj(origin) && (origin.kind === 'composer' || origin.kind === 'bridge')
}

/**
 * Why a message was held, as the person reads it in place of the send: what sending would cost, and
 * what to do. `ways` are the cold-cache ways the strip offers now, `[label, command]`.
 * @param {View} view
 * @param {{ kind: 'prompt' | 'answer', ways: [string, string][], attachments?: number }} opts
 */
export function heldReason(view, opts) {
  const what = opts.kind === 'answer' ? 'your answer' : 'this message'
  const tokens = view.tokensIfCold !== null ? `${tokenLabel(view.tokensIfCold)} tokens` : 'the whole conversation'
  const price = view.next !== null ? ` (next msg ${usd(view.next.cold)})` : ''
  const ways = opts.ways.map(([label, command]) => `${label} (${command})`)
  const carry =
    ways.length > 0
      ? ` ${ways.join(' or ')} carries it to a fresh session instead.`
      : ' Handoff & Clear (/cache-keeper handoff) asks Claude for a brief at about that price, then goes on in a fresh session.'
  const media = whole(opts.attachments) > 0 ? ` ${attachmentsNote(whole(opts.attachments))}` : ''
  return `Cache Keeper held ${what}: the prompt cache is cold, so sending it would read ${tokens} again uncached${price}. It is back in the prompt: Enter sends it anyway.${carry}${media}`
}

/**
 * What becomes of what was attached to a held message: the prompt box takes text alone, so neither Enter
 * on it nor a cold-cache way keeps an image or a file.
 * @param {number} count
 */
export function attachmentsNote(count) {
  if (!(count > 0)) return ''
  return count === 1 ? 'The image or file attached to it is not kept: attach it again.' : `The ${count} images or files attached to it are not kept: attach them again.`
}

/**
 * The strip with what the guard holds: right after what the next message costs, kept on a narrow
 * terminal before all but the cache itself.
 * @param {Segment[]} segments
 * @param {Held | null} held
 * @returns {Segment[]}
 */
export function withHeld(segments, held) {
  if (held === null) return segments
  const mark = seg('held', held.kind === 'answer' ? 'answer held' : 'message held', 'warn', 95)
  const after = Math.max(segments.findIndex((s) => s.id === 'next'), segments.findIndex((s) => s.id === 'expiry'), segments.findIndex((s) => s.id === 'cache'))
  return [...segments.slice(0, after + 1), mark, ...segments.slice(after + 1)]
}

/**
 * The line under Claude's open question once the cache is cold: what answering does now.
 * @param {View} view
 */
export function questionNotice(view) {
  const tokens = view.tokensIfCold !== null ? `${tokenLabel(view.tokensIfCold)} tokens` : 'the whole conversation'
  const price = view.next !== null ? `, ${usd(view.next.cold)}` : ''
  return `Cache Keeper: the cache went cold, so your answer will be held, not read (that would read ${tokens} again${price}). Then Enter sends it here, or a button on the strip carries it to a fresh session.`
}

/** What the model reads in place of the answer the guard held: the turn ends before it can. */
export const ANSWER_HELD = 'Cache Keeper held the answer: the prompt cache was cold, so the turn was ended before the answer was read. The person sends it as their next message, here or in a fresh session.'

/**
 * An answer to Claude's question (AskUserQuestion) as a message of its own: each question with what was
 * chosen, then any words of the person's own. Begins "My answer to its question", so it reads after a
 * pointer to the previous session's handoff, and here, where "its" is Claude's.
 * @param {unknown} questions  the call's `questions`
 * @param {unknown} answer  the tool's result: `answers` (question text -> answer), `response`, `annotations`, `followUp`
 * @returns {string}
 */
export function answerText(questions, answer) {
  const a = isObj(answer) ? answer : {}
  const answers = isObj(a.answers) ? a.answers : {}
  const notes = isObj(a.annotations) ? a.annotations : {}
  const asked = (Array.isArray(questions) ? questions : []).filter((q) => isObj(q) && str(q.question) !== null)
  const used = new Set()
  const lines = [asked.length > 1 ? 'My answer to its questions:' : 'My answer to its question:']
  const noteOf = (key) => {
    const n = notes[key]
    return str(n) ?? (isObj(n) ? str(n.notes) ?? str(n.note) : null)
  }
  for (const q of asked) {
    const key = Object.hasOwn(answers, q.question) ? q.question : str(q.header) !== null && Object.hasOwn(answers, q.header) ? q.header : null
    if (key !== null) used.add(key)
    const chosen = key === null ? null : str(String(answers[key] ?? ''))
    lines.push(`- ${q.question}`, `  ${chosen ?? '(no answer chosen)'}`)
    const note = noteOf(q.question)
    if (note !== null) lines.push(`  Note: ${note}`)
  }
  for (const [key, value] of Object.entries(answers)) {
    if (!used.has(key) && str(String(value ?? '')) !== null) lines.push(`- ${key}`, `  ${String(value)}`)
  }
  if (str(a.response) !== null) lines.push(`In my own words: ${a.response}`)
  if (a.followUp === true) lines.push('I also asked for another round of questions.')
  return lines.join('\n')
}

/**
 * Whether the dialog's result holds anything the person gave: an option chosen, words typed, or a
 * request for another round. A dialog closed with nothing in it holds none.
 * @param {unknown} answer
 */
export function isAnswer(answer) {
  if (!isObj(answer)) return false
  const answers = isObj(answer.answers) ? Object.values(answer.answers) : []
  const said = (v) => typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' || typeof v === 'boolean'
  return answers.some(said) || (typeof answer.response === 'string' && answer.response.trim() !== '') || answer.followUp === true
}

/**
 * What the fresh prompt gets after a cold-cache way: the pointer, then the held text, then a draft the
 * box held that is neither (a button pressed over a draft). Nothing is lost, nothing twice.
 * @param {string} pointer
 * @param {string | null} held
 * @param {string | null} draft
 */
export function carriedText(pointer, held, draft) {
  const parts = []
  for (const s of [held, draft]) {
    if (typeof s !== 'string' || s.trim() === '' || parts.some((p) => p.trim() === s.trim())) continue
    parts.push(s === held ? s.replace(/\s+$/, '') : s)
  }
  if (parts.length === 0) return pointer
  return pointer === '' ? parts.join('\n\n') : `${pointer}\n${parts.join('\n\n')}`
}

/** What the export may come to: `$.fs.write` refuses a file over 4 MiB. */
export const EXPORT_BUDGET = 3_500_000

/**
 * How much of each piece the export keeps, tightened a step at a time until it fits the budget. The
 * pack reads little of any piece: 500 characters of a tool's result, 220 of a command, a file's path
 * (not what was written to it), and none of the thinking.
 */
const EXPORT_CAPS = [
  { result: 4000, input: 2000, text: 24_000 },
  { result: 1000, input: 600, text: 8000 },
  { result: 300, input: 240, text: 2500 },
]

/**
 * A conversation Claude Code saved no transcript for, as acct-sync takes it (`handoff <export>.json`):
 * the messages the engine holds, as JSON text within `budget` bytes. Media and thinking are left
 * out, and long pieces cut; where that is not enough, the oldest messages go (the first stays: after
 * a compaction it is the summary). `trimmed` says what was cut.
 *
 * A question Claude asked (an AskUserQuestion call) keeps its input whole at every tier: the pack shows
 * it in full. `openQuestion` names the call still waiting on the person: whatever result the engine
 * holds for it is left out, so the export shows it as asked and not answered.
 * @param {{ messages: unknown, sessionId: string, cwd: string | null, configDir: string | null, at: number,
 *   startedAt: number | null, lastTurnAt: number | null, model: string | null, title: string | null,
 *   why: string | null, contextTokens: number | null,
 *   handoff: { path: string, at: number, turnsAfter: number } | null, openQuestion?: string | null }} facts
 * @param {number} [budget]
 * @returns {string}
 */
export function engineExport(facts, budget = EXPORT_BUDGET) {
  const open = str(facts.openQuestion)
  const isOpenResult = (b) => open !== null && isObj(b) && b.type === 'tool_result' && b.tool_use_id === open
  const all = []

  for (const m of Array.isArray(facts.messages) ? facts.messages : []) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) continue
    if (!Array.isArray(m.content) || !m.content.some(isOpenResult)) {
      all.push(m)
      continue
    }
    // The open question's result, as the engine may hold one for a call still running: left out.
    const content = m.content.filter((b) => !isOpenResult(b))
    if (content.length > 0) all.push({ ...m, content })
  }
  const head = {
    kind: 'cache-keeper engine export',
    sessionId: facts.sessionId,
    cwd: facts.cwd,
    configDir: facts.configDir,
    exportedAt: facts.at,
    startedAt: facts.startedAt,
    lastTurnAt: facts.lastTurnAt,
    model: facts.model,
    title: facts.title,
    why: facts.why,
    usage: facts.contextTokens !== null ? { input_tokens: facts.contextTokens, output_tokens: 0 } : null,
    handoffs: facts.handoff !== null ? [facts.handoff] : [],
  }
  let messages = []
  let caps = null

  for (const tier of [null, ...EXPORT_CAPS]) {
    caps = tier
    messages = all.map((m) => leanMessage(m, tier))
    const text = JSON.stringify({ ...head, trimmed: trimmedOf(caps, 0, all, messages), messages })

    if (utf8Bytes(text) <= budget) return text
  }

  // Still over: the oldest messages go, the first kept.
  const sizes = messages.map((m) => utf8Bytes(JSON.stringify(m)) + 1)
  let total = utf8Bytes(JSON.stringify({ ...head, trimmed: trimmedOf(caps, messages.length, all, messages), messages: [] })) + sizes.reduce((a, b) => a + b, 0)
  let dropped = 0

  while (total > budget && 1 + dropped < messages.length - 1) {
    total -= sizes[1 + dropped]
    dropped += 1
  }

  const kept = [...messages.slice(0, 1), ...messages.slice(1 + dropped)]

  return JSON.stringify({ ...head, trimmed: trimmedOf(caps, dropped, all, kept), messages: kept })
}

/** One message as the export keeps it; `caps` null keeps every piece whole, media and thinking still out. */
function leanMessage(m, caps) {
  const text = (s) => cut(s, caps?.text)

  if (typeof m.content === 'string') return { role: m.role, content: text(m.content) }

  const lean = (b) => {
    if (!isObj(b)) return null
    switch (b.type) {
      case 'text':
        return { type: 'text', text: text(str(b.text) ?? '') }
      case 'tool_use':
        // A question Claude asked stays whole: what was asked, and every option, is what the pack shows.
        return { type: 'tool_use', id: b.id, name: b.name, input: b.name === 'AskUserQuestion' ? b.input : cutDeep(b.input, caps?.input, 0) }
      case 'tool_result': {
        const content = typeof b.content === 'string' ? cut(b.content, caps?.result) : Array.isArray(b.content) ? b.content.map((x) => (isObj(x) && x.type === 'text' ? { type: 'text', text: cut(str(x.text) ?? '', caps?.result) } : isObj(x) ? { type: x.type } : null)).filter((x) => x !== null) : ''
        return { type: 'tool_result', tool_use_id: b.tool_use_id, ...(b.is_error === true ? { is_error: true } : {}), content }
      }
      case 'thinking':
      case 'redacted_thinking':
        return null
      default:
        // Media, server tools and anything newer: what it was, not what it held.
        return { type: str(b.type) ?? 'unknown' }
    }
  }

  return { role: m.role, content: Array.isArray(m.content) ? m.content.map(lean).filter((x) => x !== null) : [] }
}

function trimmedOf(caps, dropped, all, kept) {
  if (caps === null && dropped === 0) return null
  return { resultChars: caps?.result ?? null, inputChars: caps?.input ?? null, textChars: caps?.text ?? null, droppedMessages: dropped, messages: all.length, kept: kept.length }
}

/** A string cut to `n` characters, saying how much went. */
function cut(s, n) {
  if (typeof s !== 'string' || n === undefined || s.length <= n) return s
  return `${s.slice(0, n)} … [${s.length - n} more characters cut from the export]`
}

/** Every string in a tool's input cut to `n` characters: what was written to a file is not what the pack reads. */
function cutDeep(v, n, depth) {
  if (typeof v === 'string') return cut(v, n)
  if (n === undefined || depth > 4) return v
  if (Array.isArray(v)) return v.map((x) => cutDeep(x, n, depth + 1))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutDeep(x, n, depth + 1)]))
  return v
}

/** UTF-8 bytes of a string, as the file will hold it. */
export function utf8Bytes(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i += 1
    } else n += 3
  }
  return n
}

// -------------------------------------------------------------- formatting

/** @param {number} n */
export function tokenLabel(n) {
  if (n >= 1_000_000) return `${trim(n / 1_000_000, n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${trim(n / 1000, 1)}k`
  return String(Math.round(n))
}

/** @param {number} x */
export function usd(x) {
  if (!Number.isFinite(x)) return '?'
  if (x === 0) return '$0'
  if (x < 0.01) return '<$0.01'
  if (x < 100) return `$${x.toFixed(2)}`
  if (x < 10_000) return `$${Math.round(x)}`
  return `$${trim(x / 1000, 1)}k`
}

/** 47:12, or 1:02:03 past an hour. */
export function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** For a line redrawn every few seconds: 47m, then <1m. */
export function minutesLeft(ms) {
  const m = Math.floor(ms / 60_000)
  return m >= 1 ? `${m}m` : '<1m'
}

/** Local wall-clock time, with the weekday when it is not today. */
export function clockLabel(at, now) {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay(d, new Date(now)) ? hm : `${WEEKDAYS[d.getDay()]} ${hm}`
}

/** The weekday a weekly limit resets on, or the time when that is today. */
export function dayLabel(at, now) {
  const d = new Date(at)
  return sameDay(d, new Date(now)) ? clockLabel(at, now) : WEEKDAYS[d.getDay()]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const pctLabel = (p) => `${Math.round(p)}%`
const pctTone = (p) => (p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'plain')
const minutesLabel = (ms) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`)
const trim = (x, digits) => String(Number(x.toFixed(digits)))
const seg = (id, text, tone, priority, glue = false, tight = false) => ({ id, text, tone, priority, ...(glue && { glue }), ...(tight && { tight }) })

// ----------------------------------------------------------------- helpers

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isStr(v) {
  return typeof v === 'string'
}
function str(v) {
  return typeof v === 'string' && v !== '' ? v : null
}
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
/** An ISO 8601 time in ms. The usage endpoint writes microseconds, which not every Date.parse reads. */
function msOfIso(v) {
  if (!isStr(v)) return null
  const ms = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(ms) ? ms : null
}
function whole(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}
function baseName(path) {
  if (typeof path !== 'string' || path === '') return null
  const parts = path.split(/[\\/]/).filter((p) => p !== '')
  return parts.length > 0 ? parts[parts.length - 1] : null
}
