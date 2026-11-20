import type { EngineInterface, On } from 'claude-code'

import * as core from './core.mjs'
import { stripView, type StripButton } from './strip.tsx'

/**
 * Cache Keeper, the part that lives inside Claude Code: a strip above the prompt with the prompt
 * cache's countdown and what the session costs, a desktop notification before the cache goes cold,
 * and the Handoff & Clear button. Once the cache is cold the strip offers two ways on that need no
 * model call: Use Latest Handoff (the handoff the session wrote, when it did no work after it) and
 * Pack & Clear (a pack acct-sync builds from the transcript; offered where acct-sync is installed).
 *
 * The cold-send guard: a message the person sends into a cold session large enough to be costly to
 * read again is held, not sent, and the cold-cache ways carry it to the fresh session after the
 * pointer. Enter on the same text sends it anyway. An answer to Claude's question is held the same
 * way, its turn ended before the model reads it.
 *
 * What the cache is doing comes from the status line command (`bin/statusline.mjs`), which is handed
 * Claude Code's own cache tracker on every run and writes it to `live/<session>.json`. The module
 * reads that file; without it the strip still shows what `$.session.usage()` knows.
 */

const TICK_MS = 1000
const REFRESH_TICKS = 2
const HEARTBEAT_TICKS = 5
const USAGE_TICKS = 15
const TOAST_MS = 12_000
/** One acct-sync run: a pack from a 500 MB transcript takes about 25 s. */
const PACK_TIMEOUT_MS = 240_000
/** How long Claude must be idle before a queued cold-cache way runs without its turn's end. */
const QUEUE_IDLE_MS = 1000
/** After a hold, when the text goes back in the prompt: once the engine has done with the submission. */
const REFILL_MS = 100
/** How long ending a turn may take before the module goes on as if it had (the abort keeps going). */
const ABORT_WAIT_MS = 2000
/** How long a read of the session usage may take: past it the read counts as refused, and the last figure stands. */
const USAGE_WAIT_MS = 1000
/** The most a session's trace file keeps (CACHE_KEEPER_TRACE): past it, the older half goes. */
const TRACE_MAX_CHARS = 1_000_000

/**
 * How long each step of a handoff may take before the strip stops waiting for it. The brief is a
 * fork of the whole session, which on a 1M-token transcript can take minutes; a queued handoff
 * waits for however long Claude's turn runs; a pack may take two acct-sync runs.
 */
const STALE_MS: Record<Exclude<Phase, 'idle'>, number> = {
  queued: 6 * 3_600_000,
  writing: 15 * 60_000,
  preparing: 2 * PACK_TIMEOUT_MS + 60_000,
  clearing: 60_000,
  filling: 30_000,
}

/** Which way on: a brief Claude writes (Handoff & Clear), the handoff the session wrote, or a pack. */
type Kind = 'brief' | 'latest' | 'pack'
type ColdKind = Exclude<Kind, 'brief'>
type Phase = 'idle' | 'queued' | 'writing' | 'preparing' | 'clearing' | 'filling'
type From = { sessionId: string | null; sessionName: string | null; at: number }
/** A message the guard holds back, or an answer to Claude's question: Enter sends it, the cold-cache ways carry it. */
type Held = NonNullable<ReturnType<typeof core.heldOf>>
/**
 * Claude's question (AskUserQuestion) the main loop's turn waits on, from its call until it is answered.
 * `traced`: the last cold-send answer the trace has for it. `turnAt`: when the turn that asked started, which its
 * cache clock counts from (core.questionClock); null when the module did not see that turn start.
 */
type Question = { toolUseId: string; questions: unknown[]; at: number; turnId: string | null; turnAt: number | null; isNoticed: boolean; traced: boolean | null }
/**
 * What there is to go on from, once it is known: the text the fresh prompt gets, the file it names, and
 * (from the moment of the clear) the held text that follows the pointer.
 */
type Ready = { kind: Kind; since: number; from: From; text: string; file: string | null; carry?: Held | null }
type Handoff =
  | { phase: 'idle' }
  | { phase: 'queued' | 'writing' | 'preparing'; kind: Kind; since: number; from: From }
  | ({ phase: 'clearing' | 'filling' } & Ready)

const LABEL: Record<Kind, string> = { brief: 'Handoff & Clear', latest: 'Use Latest Handoff', pack: 'Pack & Clear' }

/** The handoff the session can go on from: handoff-guard's record, its file read. */
type Latest = { path: string; at: number; hub: string | null }
/** What handoff-guard's record says of the session's newest handoff, current or not. */
type GuardTrack = { path: string; at: number; turnsAfter: number }

type Timer = { cancel: () => void }
type Snapshot = ReturnType<typeof core.snapshotOfUsage>
type Account = ReturnType<typeof core.accountOf>
/** The session usage's figure as the module last read it: the live window's last response's input tokens, and when. */
type UsageReading = { tokens: number; at: number }
/** How a read of the session usage went, for the trace: a figure, none yet, or refused. */
type UsageRead = { read: 'figure' | 'none' | 'refused'; tokens: number | null }

/**
 * The engine as `session.start` bound it. Every member spells `$.noun.event(...)` here, where the
 * engine reads what the module calls off its source; the rest of the module calls these.
 */
type Host = ReturnType<typeof hostOf>

function hostOf($: EngineInterface) {
  return {
    sessionId: () => $.session.id(),
    usage: () => $.session.usage(),
    model: () => $.session.model(),
    configDir: () => $.env.get('CLAUDE_CONFIG_DIR'),
    userProfile: () => $.env.get('USERPROFILE'),
    home: () => $.env.get('HOME'),
    // Windows sets OS=Windows_NT for every process; the engine has no platform of its own to read.
    osName: () => $.env.get('OS'),
    // The guard's overrides for a test in the real engine, where config.json is every session's.
    holdColdAtOverride: () => $.env.get('CACHE_KEEPER_HOLD_COLD_AT'),
    assumeColdOverride: () => $.env.get('CACHE_KEEPER_ASSUME_COLD'),
    traceOverride: () => $.env.get('CACHE_KEEPER_TRACE'),
    ttlOverride: () => $.env.get('CACHE_KEEPER_TTL'),
    now: () => $.clock.now(),
    every: (ms: number, fn: () => void) => $.clock.every(ms, fn) as Timer,
    after: (ms: number, fn: () => void) => $.clock.after(ms, fn) as Timer,
    read: (path: string) => $.fs.read(path) as Promise<string>,
    write: (path: string, text: string) => $.fs.write(path, text),
    stat: (path: string) => $.fs.stat(path) as Promise<{ mtimeMs?: number } | undefined>,
    invalidate: () => $.ui.invalidate('ui.render'),
    toast: (text: string, timeoutMs: number) => $.ui.toast(text, { timeoutMs }),
    registerCommand: (spec: { name: string; description: string; argumentHint?: string }) => $.command.register(spec),
    runCommand: (command: string) => $.command.run({ command }),
    fork: (prompt: string) => $.model.fork({ prompt }) as Promise<{ isAnswered?: boolean; text?: unknown; reason?: unknown; status?: unknown }>,
    submit: (text: string) => $.prompt.submit({ text }),
    fill: (text: string) => $.prompt.fill({ text, mode: 'replace' }) as Promise<{ isFilled?: boolean }>,
    readPrompt: () => $.prompt.read() as Promise<unknown>,
    // Waited for: a detached powershell.exe runs nothing. The texts travel in `env`, never in the code it runs.
    notify: (argv: string[], env: Record<string, string>) => $.process.run(argv, { timeoutMs: 20_000, env }),
    run: (argv: string[], timeoutMs: number) => $.process.run(argv, { timeoutMs }) as Promise<{ exitCode?: unknown; stdout?: unknown; stderr?: unknown }>,
    hubWorker: () => $.env.get('HUB_WORKER'),
    childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'),
    cwd: () => $.session.cwd(),
    // The conversation as the next request would send it: what Pack & Clear hands acct-sync when no transcript was saved.
    messages: () => $.session.messages({ as: 'api' }) as Promise<unknown>,
    // The session's credential, as an opaque handle: the engine sets the header, the token never reaches the module.
    authorize: () => $.session.authorize() as Promise<{ handle: string; kind: string } | null>,
    fetch: (url: string, init: { auth?: string; headers?: Record<string, string> }) => $.http.fetch(url, init) as Promise<{ status: number; ok: boolean; text: string }>,
    // Ends the main loop's running turn, its tools stopped, with no model call: a dialog's turn, or the one an answer came back in.
    abort: (turnId: string) => $.turn.abort({ turnId }),
    // A line under Claude's open question; refused once the question is answered, which changes nothing here.
    notice: (toolUseId: string, text: string | undefined) => quietly(() => $.ui.notice(toolUseId, text)),
    // A dim line in the transcript, which the model does not read.
    log: (text: string) => quietly(() => $.ui.log(text)),
  }
}

/** A display call whose refusal changes nothing: neither its throw nor a rejection reaches the caller. */
function quietly(call: () => unknown): void {
  try {
    const answer = call()

    if (answer instanceof Promise) {
      answer.catch(() => undefined)
    }
  } catch {
    // refused
  }
}

/** The plugin declares no `userConfig`: its settings live in config.json, shared with the status line. */
export function register(on: On) {
  const state = {
    host: null as Host | null,
    isInteractive: false,
    /** Claude Code's config directory: CLAUDE_CONFIG_DIR, else <home>/.claude. */
    root: null as string | null,
    dir: null as string | null,
    /** A hub worker: its hub hands it over and addresses it by its session id, so no cold-cache buttons. */
    isWorker: false,
    latest: null as Latest | null,
    /** Why there is no handoff to go on from, a path in it shown by `path`: plain in a toast, in a code span in a reply. */
    latestWhy: ((): string => 'not read yet') as (path: (p: string) => string) => string,
    guardTrack: null as GuardTrack | null,
    guardStamp: Number.NaN,
    platform: 'linux',
    sessionId: null as string | null,
    config: core.configOf(undefined),
    configStamp: Number.NaN,
    snapshot: null as Snapshot | null,
    snapshotStamp: Number.NaN,
    fromUsage: null as Snapshot | null,
    /** The session usage's figure, read at each hold decision: newer than the snapshot's where a request came since. */
    usage: null as UsageReading | null,
    account: null as Account,
    accountStamp: Number.NaN,
    authKind: null as string | null,
    boundAt: 0,
    isBound: false,
    heldRateLimits: null as unknown,
    isPolling: false,
    now: 0,
    isWorking: false,
    notifiedFor: null as number | null,
    handoff: { phase: 'idle' } as Handoff,
    ticks: 0,
    isTicking: false,
    timers: new Set<Timer>(),
    /** The guard's overrides, from the environment at bind: a test in the real engine never writes config.json. */
    overrides: { holdColdAt: null as number | null, isAssumedCold: false, isTraced: false, ttl: null as number | 'auto' | null },
    /** The trace's writes, one after another: each appends to what the one before wrote. */
    traceChain: Promise.resolve() as Promise<void>,
    /** Whether acct-sync, which Pack & Clear needs, is installed; null until looked for. */
    hasPackTool: null as boolean | null,
    /** The main loop's running turn, from its `turn.start` to its end. */
    turnId: null as string | null,
    /** When the main loop's last turn started, by the module's clock; null until the module sees one start. */
    turnAt: null as number | null,
    /** Claude's question that turn waits on, from the call to its answer. */
    question: null as Question | null,
    /** What the guard holds for this session, as `live/<session>.held.json` keeps it. */
    held: null as Held | null,
    /** A conversation the /clear just started, whose first message is never held: it re-reads nothing. */
    isFresh: false,
    /** A held text that follows a command pointer (`/hub resume <id>`): filled in once that command has run. */
    afterPointer: null as Held | null,
    /** The turn this module last ended with `$.turn.abort`, until its end is heard. */
    abortedTurnId: null as string | null,
  }

  // ---------------------------------------------------------------- reading

  /** This session's own figures: its status line snapshot, or what the session usage knows. */
  function own(): Snapshot {
    return state.snapshot ?? state.fromUsage ?? core.snapshotOfUsage(null, { sessionId: state.sessionId, model: null, now: state.now })
  }

  /** This session's figures, with the account's limits as the freshest session or poll read them. */
  function current(): Snapshot {
    return core.withAccountLimits(own(), state.account, state.now, { isSubscription: state.authKind === 'bearer' })
  }

  function liveFile(suffix: string, sessionId = state.sessionId): string | null {
    return state.dir === null || sessionId === null ? null : `${state.dir}/live/${safeName(sessionId)}${suffix}`
  }

  /** The settings as they stand now: config.json's, with the TTL CACHE_KEEPER_TTL forces. */
  function configNow(): ReturnType<typeof core.configOf> {
    return core.withTtl(state.config, state.overrides.ttl)
  }

  /**
   * The strip's view, which the guard, the warning and the status read too. Its token figure is the
   * newest there is: the snapshot's, or the session usage's where that was read since (core.newestTokens).
   * While Claude's question is open its cache clock counts from the start of the turn that asked, where
   * that is later than the snapshot's last request (core.questionClock): `turnAt`, which defaults to the
   * open question's. The typed guard passes null: it goes by the snapshot alone.
   */
  function viewNow(turnAt: number | null = state.question?.turnAt ?? null): ReturnType<typeof core.viewOf> {
    return core.viewOf(current(), state.now, configNow(), { assumeCold: state.overrides.isAssumedCold, usage: state.usage, turnAt })
  }

  /**
   * The session usage, read with a bound: one that has not answered within USAGE_WAIT_MS rejects as a
   * refusal would, so neither the answer's tool call nor the tick waits on it. The read itself goes on.
   */
  function usageWithin(host: Host): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = host.after(USAGE_WAIT_MS, () => {
        state.timers.delete(timer)
        reject(new Error(`the session usage did not answer within ${USAGE_WAIT_MS} ms`))
      })
      const settle = () => {
        timer.cancel()
        state.timers.delete(timer)
      }

      state.timers.add(timer)
      host.usage().then(
        (value: unknown) => {
          settle()
          resolve(value)
        },
        (error: unknown) => {
          settle()
          reject(error)
        },
      )
    })
  }

  /**
   * Reads the session usage now, for a hold decision: its figure is the last request's whole prompt, which
   * the status line's snapshot may predate (a session's first request, or one that raised Claude's
   * question while the status line is not run). A refused read, or one that took past USAGE_WAIT_MS, keeps
   * the last figure; a read with none (no response yet, or a compaction since) drops it, as the window it
   * measured is gone.
   */
  async function readUsage(host: Host): Promise<UsageRead> {
    let usage: unknown

    try {
      usage = await usageWithin(host)
    } catch {
      return { read: 'refused', tokens: null }
    }

    const tokens = core.usageTokens(usage)

    if (tokens === null) {
      state.usage = null

      return { read: 'none', tokens: null }
    }

    state.usage = { tokens, at: state.now }

    return { read: 'figure', tokens }
  }

  /** The guard's threshold in tokens: CACHE_KEEPER_HOLD_COLD_AT, else the setting; 0 is off. */
  function holdColdAt(): number {
    return state.overrides.holdColdAt ?? state.config.holdColdAt
  }

  /** Whether a message or an answer sent now would be held: cold, and a re-read of at least the threshold. */
  function isColdSend(view: ReturnType<typeof core.viewOf>): boolean {
    const limit = holdColdAt()

    return limit > 0 && !state.isWorker && view.cache.state === 'cold' && view.tokensIfCold !== null && view.tokensIfCold >= limit
  }

  /**
   * CACHE_KEEPER_TRACE: one JSON line per hold decision, appended to `live/<session>.trace.jsonl`. Names,
   * figures and ids alone: never the text of a prompt or an answer. Resolves once the line is written.
   */
  function trace(host: Host, ev: string, fields: Record<string, unknown> = {}): Promise<void> {
    const path = state.overrides.isTraced ? liveFile('.trace.jsonl') : null

    if (path === null) {
      return Promise.resolve()
    }

    const line = `${JSON.stringify({ at: new Date(state.now).toISOString(), v: core.VERSION, ev, ...fields })}\n`

    state.traceChain = state.traceChain
      .then(async () => {
        const before = await host.read(path).catch(() => '')
        const kept = before.length > TRACE_MAX_CHARS ? before.slice(before.indexOf('\n', before.length - TRACE_MAX_CHARS / 2) + 1) : before

        await host.write(path, kept + line)
      })
      .catch(() => undefined)

    return state.traceChain
  }

  /** The trace of one cold-send check: what it went on (the cache, the figure and where it came from, the threshold) and its answer. */
  function traceColdSend(host: Host, what: 'prompt' | 'answer' | 'notice', view: ReturnType<typeof core.viewOf>, read: UsageRead | null, isCold: boolean): Promise<void> {
    const base = current()

    return trace(host, 'cold-send', {
      for: what,
      state: view.cache.state,
      isAssumedCold: view.cache.isAssumedCold === true,
      // What the cache's state counts from: the snapshot's last request, or the start of the turn whose question is open.
      clock: view.clock.name,
      turnAt: isoOf(view.clock.turnAt),
      expiresAt: isoOf(view.cache.expiresAt),
      ttl: view.cache.ttlLabel,
      tokens: view.tokensIfCold,
      source: view.tokensFrom.source,
      sourceAt: view.tokensFrom.at === null ? null : new Date(view.tokensFrom.at).toISOString(),
      snapshot: { source: base.source, at: new Date(base.at).toISOString(), tokens: core.newestTokens(base).tokens },
      usage: read,
      limit: holdColdAt(),
      isWorker: state.isWorker,
      isColdSend: isCold,
    })
  }

  /** acct-sync, which Pack & Clear runs: `<config dir>/tools/account-sync/acct-sync.mjs`. */
  function packTool(): string | null {
    return state.root === null ? null : `${state.root}/tools/account-sync/acct-sync.mjs`
  }

  async function checkPackTool(host: Host): Promise<boolean> {
    const tool = packTool()

    state.hasPackTool = tool !== null && (await host.stat(tool).catch(() => undefined)) !== undefined

    return state.hasPackTool
  }

  /** The cold-cache ways the strip offers now, as `[label, command]`. */
  function waysNow(): [string, string][] {
    const ways: [string, string][] = []

    if (state.latest !== null && state.question === null) {
      ways.push([LABEL.latest, '/use-latest-handoff'])
    }

    if (state.hasPackTool === true) {
      ways.push([LABEL.pack, '/pack-and-clear'])
    }

    return ways
  }

  async function refresh(host: Host, force: boolean): Promise<void> {
    const id = await host.sessionId().catch(() => null)
    const sessionId = typeof id === 'string' && id !== '' ? id : null

    if (sessionId !== state.sessionId) {
      state.sessionId = sessionId
      forgetSession()

      // A new session (after /clear): beat at once, so its status line stands down at its next run.
      const beat = liveFile('.module')

      if (beat !== null) {
        await host.write(beat, beatOf(state.now)).catch(() => undefined)
      }

      // What the guard held in this session before the module was loaded again, or the session resumed.
      await loadHeld(host, sessionId)
    }

    if (state.dir === null) {
      return
    }

    if (force || state.ticks % USAGE_TICKS === 0) {
      await checkPackTool(host)
    }

    const configPath = `${state.dir}/config.json`
    const configStat = await host.stat(configPath).catch(() => undefined)
    const configStamp = configStat?.mtimeMs ?? -1

    if (force || configStamp !== state.configStamp) {
      state.configStamp = configStamp
      state.config = core.configOf(configStat === undefined ? undefined : parseJson(await host.read(configPath).catch(() => '')))
    }

    const accountPath = `${state.dir}/limits.json`
    const accountStat = await host.stat(accountPath).catch(() => undefined)
    const accountStamp = accountStat?.mtimeMs ?? -1

    if (force || accountStamp !== state.accountStamp) {
      state.accountStamp = accountStamp
      // A half-written file (another session mid-write) reads as nothing: keep the last good one.
      state.account = core.accountOf(parseJson(await host.read(accountPath).catch(() => ''))) ?? state.account
    }

    const path = liveFile('.json')

    if (path !== null) {
      const stat = await host.stat(path).catch(() => undefined)
      const stamp = stat?.mtimeMs ?? -1

      if (force || stamp !== state.snapshotStamp) {
        state.snapshotStamp = stamp
        const parsed = stat === undefined ? null : parseJson(await host.read(path).catch(() => ''))
        state.snapshot = isSnapshot(parsed) && parsed.sessionId === sessionId ? parsed : null
      }
    }

    if (state.snapshot === null && (force || state.ticks % USAGE_TICKS === 0)) {
      const [usage, model] = await Promise.all([usageWithin(host).catch(() => null), host.model().catch(() => null)])
      state.fromUsage = core.snapshotOfUsage(usage, { sessionId, model: modelIdOf(model), now: state.now })
    }

    await refreshGuard(host, force)
  }

  /**
   * handoff-guard's record of this session (`handoff-guard/live/<sid>.json`): whether its newest
   * handoff is current, which Use Latest Handoff goes on from. Read again whenever the file changes.
   */
  async function refreshGuard(host: Host, force: boolean): Promise<void> {
    const sessionId = state.sessionId

    if (state.root === null || sessionId === null) {
      return
    }

    const path = `${state.root}/handoff-guard/live/${sessionId}.json`
    const stat = await host.stat(path).catch(() => undefined)
    const stamp = stat?.mtimeMs ?? -1

    if (!force && stamp === state.guardStamp) {
      return
    }

    state.guardStamp = stamp

    const record = stat === undefined ? null : parseJson(await host.read(path).catch(() => ''))
    const track = recordTrack(record, sessionId)
    const found = core.latestHandoff(record, sessionId)

    // The session may have changed while the files were read (a /clear): this record is not its.
    if (sessionId !== state.sessionId) {
      return
    }

    state.guardTrack = track

    if ('why' in found) {
      state.latest = null
      const why = found.why

      state.latestWhy = () => why
      return
    }

    // The file must still be there, and say it is a handoff where its name does not.
    const text = await host.read(found.path).catch(() => null)
    const foundPath = found.path

    if (text === null) {
      state.latest = null
      state.latestWhy = path => `its handoff ${path(foundPath)} is gone`
    } else if (found.check && !core.HANDOFF_HEADING.test(text)) {
      state.latest = null
      state.latestWhy = path => `the newest file it wrote among the handoffs, ${path(foundPath)}, is not a handoff`
    } else {
      state.latest = { path: found.path, at: found.at, hub: found.hub }
      state.latestWhy = () => ''
    }
  }

  function forgetSession(): void {
    state.snapshot = null
    state.snapshotStamp = Number.NaN
    state.fromUsage = null
    state.usage = null
    state.notifiedFor = null
    state.latest = null
    state.latestWhy = () => 'not read yet'
    state.guardTrack = null
    state.guardStamp = Number.NaN
    state.held = null
  }

  // ------------------------------------------------------ the cold-send guard

  async function loadHeld(host: Host, sessionId: string | null): Promise<void> {
    const path = liveFile('.held.json', sessionId)
    const held = path === null ? null : core.heldOf(parseJson(await host.read(path).catch(() => '')), sessionId)

    // The session may have changed while the file was read.
    if (sessionId === state.sessionId) {
      state.held = held
    }
  }

  async function saveHeld(host: Host, held: Held): Promise<void> {
    const path = liveFile('.held.json', held.sid)

    if (path !== null) {
      await host.write(path, JSON.stringify(held)).catch(() => undefined)
    }
  }

  /** The held text is used (sent, or carried): gone from state and from its file, whichever session it was held in. */
  async function releaseHeld(host: Host, held: Held): Promise<void> {
    if (state.held !== null && state.held.sid === held.sid && state.held.at === held.at) {
      state.held = null
    }

    // `$.fs` has no delete: a record with no text is none, and the status line prunes the file in time.
    const path = liveFile('.held.json', held.sid)

    if (path !== null) {
      await host.write(path, JSON.stringify({ v: 1, sid: held.sid, used: state.now })).catch(() => undefined)
    }

    host.invalidate()
  }

  /**
   * Whether the person's prompt is held back from a cold send: their own words, a plain message (no
   * command, no shell line, not typed over a running turn), in an interactive session that is no hub
   * worker, past the conversation's first message, with the cache cold and its re-read at least the
   * threshold. Null lets it go; anything uncertain lets it go too.
   */
  async function holdPrompt(host: Host, e: { text?: unknown; command?: unknown; isMeta?: unknown; turnId?: unknown; origin?: unknown; attachments?: unknown }): Promise<{ drop: string } | null> {
    if (!state.isInteractive || !state.isBound || state.isWorker || !core.isPersonOrigin(e.origin)) {
      return null
    }

    const text = typeof e.text === 'string' ? e.text : ''

    if (e.command !== undefined || e.isMeta === true || e.turnId !== undefined || text.trim() === '' || text.trimStart().startsWith('!')) {
      return null
    }

    const held = state.held

    // Enter again on what was held: it goes this once.
    if (held !== null && sameText(held.text, text)) {
      await releaseHeld(host, held)

      return null
    }

    if (state.isFresh || holdColdAt() <= 0 || state.sessionId === null || state.dir === null) {
      return null
    }

    state.now = await host.now().catch(() => state.now)

    // The newest figure there is: the last request's, though the status line may not have run since. The cache
    // clock is the snapshot's alone: a turn that made no request (a dropped prompt, a command) proves nothing, and
    // the status line runs whenever the prompt box shows.
    const read = await readUsage(host)
    const view = viewNow(null)
    const isCold = isColdSend(view)

    await traceColdSend(host, 'prompt', view, read, isCold)

    if (!isCold) {
      return null
    }

    // The conversation's first message re-reads nothing: one Claude has not answered yet is never held.
    const messages = await host.messages().catch(() => null)

    if (!Array.isArray(messages) || !messages.some(m => (m as { role?: unknown } | null)?.role === 'assistant')) {
      await trace(host, 'prompt', { return: 'first-message' })

      return null
    }

    const attachments = Array.isArray(e.attachments) ? e.attachments.length : 0
    const next: Held = { v: 1, sid: state.sessionId, kind: 'prompt', text, at: state.now, attachments }

    state.held = next
    await saveHeld(host, next)
    refillLater(host, text, 0)
    host.invalidate()
    await trace(host, 'prompt', { return: 'held', attachments })

    return { drop: core.heldReason(view, { kind: 'prompt', ways: waysNow(), attachments }) }
  }

  /**
   * The held text back in the prompt box, so Enter sends it: once the engine is done with the
   * submission it dropped, and not over anything the person has typed since. A dialog still closing
   * holds the keys a moment longer.
   */
  function refillLater(host: Host, text: string, tries: number): void {
    state.timers.add(
      host.after(REFILL_MS * (tries + 1), () => {
        void (async () => {
          const box = draftOf(await host.readPrompt().catch(() => null))

          if (box.trim() !== '' && !sameText(box, text)) {
            return
          }

          const filled = (await host.fill(text).catch(() => null)) as { isFilled?: boolean; refusal?: string } | null

          if (filled?.isFilled === false && filled.refusal === 'dialog' && tries < 5) {
            refillLater(host, text, tries + 1)
          }
        })().catch(() => undefined)
      }),
    )
  }

  on('prompt.submit', async ($, e, next) => {
    const host = state.host
    const hold = host === null ? null : await holdPrompt(host, e).catch(() => null)

    if (hold !== null) {
      return hold
    }

    const result = await next(e)

    try {
      // The person's message went in: what was held is spent, and the conversation is no longer new.
      if (result.drop === undefined && e.command === undefined && e.isMeta !== true && core.isPersonOrigin(e.origin)) {
        state.isFresh = false

        if (state.held !== null && host !== null) {
          await releaseHeld(host, state.held)
        }
      }
    } catch {
      // the prompt has entered: nothing here may undo it
    }

    return result
  })

  /**
   * Claude's question (AskUserQuestion) in the main loop. While it is open the turn waits on the person,
   * so Pack & Clear ends that turn instead of waiting for it. An answer given on a cold cache over the
   * threshold is held like a typed message: the turn is ended before the model reads it, and the
   * answer goes back in the prompt as text.
   */
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const host = state.host
    const id = (e as { tool_use_id?: unknown }).tool_use_id
    const questions = (e as { questions?: unknown }).questions

    // The model's own question in the main loop: not a subagent's, nor a plugin's `$.ui.ask`, which raises this event too.
    if (!state.isInteractive || host === null || e.agentId !== undefined || next.origin.plugin !== 'engine' || typeof id !== 'string') {
      if (host !== null) {
        const why = !state.isInteractive ? 'not-interactive' : e.agentId !== undefined ? 'subagent' : next.origin.plugin !== 'engine' ? 'not-the-model' : 'no-tool-use-id'

        void trace(host, 'question-skipped', { why, origin: next.origin.plugin })
      }

      return next(e)
    }

    // Its cache clock: the start of the turn that asked, whose request read the cache at its start. Not the time the
    // question opens, at that request's end; and none when the module did not see the turn start (loaded mid-turn).
    const turnAt = state.turnId !== null ? state.turnAt : null
    const question: Question = { toolUseId: id, questions: Array.isArray(questions) ? [...questions] : [], at: state.now, turnId: state.turnId, turnAt, isNoticed: false, traced: null }

    state.question = question
    host.invalidate()
    void trace(host, 'question-open', { id: idPrefix(id), turn: state.turnId, turnAt: isoOf(turnAt) })

    let result: Awaited<ReturnType<typeof next>>

    try {
      result = await next(e)
    } finally {
      if (state.question === question) {
        state.question = null
      }

      host.invalidate()
    }

    try {
      return (await holdAnswer(host, question, result)) ?? result
    } catch {
      return result
    }
  })

  async function holdAnswer(host: Host, question: Question, result: unknown): Promise<{ deny: string } | null> {
    const r = (typeof result === 'object' && result !== null ? result : {}) as { deny?: unknown; isError?: unknown; result?: unknown }
    const answer = (typeof r.result === 'object' && r.result !== null ? r.result : null) as { afkTimeoutMs?: unknown } | null
    const turnId = question.turnId ?? state.turnId
    const id = idPrefix(question.toolUseId)
    // Each way out, named in the trace.
    const letGo = async (name: string): Promise<null> => {
      await trace(host, 'hold-answer', { id, return: name })

      return null
    }

    state.now = await host.now().catch(() => state.now)
    await trace(host, 'answer', {
      id,
      turn: turnId,
      isDenied: r.deny !== undefined,
      isError: r.isError === true,
      hasResult: answer !== null,
      isAway: answer !== null && answer.afkTimeoutMs !== undefined,
      isAnswer: answer !== null && core.isAnswer(answer),
    })

    // Not an answer of the person's: refused, failed, resolved while they were away, or nothing given.
    if (r.deny !== undefined || r.isError === true || answer === null || answer.afkTimeoutMs !== undefined || !core.isAnswer(answer)) {
      return letGo('not-an-answer')
    }

    if (turnId === null) {
      return letGo('no-turn')
    }

    if (state.isWorker) {
      return letGo('hub-worker')
    }

    if (state.sessionId === null || state.dir === null) {
      return letGo(state.sessionId === null ? 'no-session' : 'no-data-folder')
    }

    // The turn this module ends itself (Pack & Clear with the question open): what the dialog gives as it
    // closes is no answer, and the session is about to clear.
    if (turnId === state.abortedTurnId) {
      return letGo('turn-ended-by-cache-keeper')
    }

    if (state.handoff.phase !== 'idle' && state.handoff.phase !== 'queued') {
      return letGo('handoff-running')
    }

    // Judged on the request that raised the question: the session usage has its figure, the status line
    // (not run while the dialog is open) may have only the one before, or none on a session's first. Its
    // cache clock counts from that request's turn's start, where that is later than the snapshot's.
    const read = await readUsage(host)
    const view = viewNow(question.turnAt)
    const isCold = isColdSend(view)

    await traceColdSend(host, 'answer', view, read, isCold)

    if (!isCold) {
      return letGo('not-a-cold-send')
    }

    // Ended before the model reads the answer: the deny below is then what the transcript keeps.
    if (!(await endTurn(host, turnId)).ok) {
      return letGo('turn-not-ended')
    }

    const text = core.answerText(question.questions, answer)
    const held: Held = { v: 1, sid: state.sessionId, kind: 'answer', text, at: state.now, attachments: 0 }

    state.held = held
    await saveHeld(host, held)
    refillLater(host, text, 0)
    host.toast(core.heldReason(view, { kind: 'answer', ways: waysNow() }), TOAST_MS)
    host.log(`Cache Keeper held your answer to Claude's question (the cache was cold) and ended the turn: it is in the prompt.`)
    host.invalidate()
    await trace(host, 'hold-answer', { id, return: 'held' })

    return { deny: core.ANSWER_HELD }
  }

  /**
   * Ends the main loop's running turn with no model call. Done when the engine took the abort, or the
   * turn had ended anyway; not when it refused and the turn still runs.
   */
  async function endTurn(host: Host, turnId: string | null): Promise<{ ok: true } | { ok: false; why: string }> {
    if (turnId === null) {
      await trace(host, 'abort', { turn: null, outcome: 'no-turn', ok: !state.isWorking })

      return state.isWorking ? { ok: false, why: 'the turn it waits in is not known (the module was loaded again since it started)' } : { ok: true }
    }

    const outcome = await new Promise<'ended' | 'waiting' | Error>(resolve => {
      const timer = host.after(ABORT_WAIT_MS, () => resolve('waiting'))
      const settle = (value: 'ended' | Error) => {
        timer.cancel()
        state.timers.delete(timer)
        resolve(value)
      }

      state.timers.add(timer)
      host.abort(turnId).then(
        () => settle('ended'),
        (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))),
      )
    })

    if (outcome instanceof Error) {
      // Refused: that turn is not the running one. One that has ended, or that this module ended a
      // moment ago (its end not heard yet), is as good as ended.
      const isRunning = state.isWorking && state.turnId !== null && state.turnId !== state.abortedTurnId

      await trace(host, 'abort', { turn: turnId, outcome: 'refused', why: errorText(outcome), ok: !isRunning })

      return isRunning ? { ok: false, why: `the turn could not be ended (${errorText(outcome)})` } : { ok: true }
    }

    // Taken, or still going after ABORT_WAIT_MS: the turn ends without another request either way.
    state.abortedTurnId = turnId
    await trace(host, 'abort', { turn: turnId, outcome, ok: true })

    return { ok: true }
  }

  /**
   * Under Claude's open question, once the cache is cold: an answer there would be held. Once per
   * question, on the newest figure (the session usage's: the request that raised the question).
   */
  async function checkQuestion(host: Host): Promise<void> {
    const question = state.question

    if (question === null || question.isNoticed) {
      return
    }

    const read = await readUsage(host)
    const view = viewNow(question.turnAt)
    const isCold = isColdSend(view)

    // Traced when its answer changes, not on every tick.
    if (question.traced !== isCold) {
      question.traced = isCold
      await traceColdSend(host, 'notice', view, read, isCold)
    }

    // The question may have been answered meanwhile.
    if (!isCold || state.question !== question || question.isNoticed) {
      return
    }

    question.isNoticed = true
    host.notice(question.toolUseId, core.questionNotice(view))
    await trace(host, 'notice', { id: idPrefix(question.toolUseId) })
  }

  // ------------------------------------------------------------- lifecycle

  async function bind(host: Host): Promise<void> {
    state.platform = await platformOf(host)
    state.root = await configRootOf(host, state.platform)
    state.dir = state.root === null ? null : `${state.root}/cache-keeper`
    state.isWorker = isSet(await host.hubWorker().catch(() => undefined))
    state.overrides = overridesOf(
      await host.holdColdAtOverride().catch(() => undefined),
      await host.assumeColdOverride().catch(() => undefined),
      await host.traceOverride().catch(() => undefined),
      await host.ttlOverride().catch(() => undefined),
    )
    state.now = await host.now().catch(() => Date.now())
    state.boundAt = state.now

    // The heartbeat first: the status line stands down as soon as it sees one.
    const id = await host.sessionId().catch(() => null)

    if (typeof id === 'string' && id !== '' && state.dir !== null) {
      await host.write(`${state.dir}/live/${safeName(id)}.module`, beatOf(state.now)).catch(() => undefined)
    }

    // No `/handoff` of its own: a skill of that name, common in skill collections, takes the bare
    // name, `command.run` then names that skill, and a hook on `{ command: 'handoff' }` never runs. The
    // two cold-cache commands have names no skill is likely to take, and answer without a model turn.
    const commands = [
      {
        name: 'cache-keeper',
        description: 'Cache Keeper: status, settings, Handoff & Clear (handoff), Use Latest Handoff (latest), Pack & Clear (pack)',
        argumentHint: '[status|handoff|latest|pack|ttl|fallback|warn|notify|statusline|brief|limits|hold|test-notify]',
      },
      { name: 'use-latest-handoff', description: "Cache Keeper: clear, and go on from the handoff this session wrote, when it did no work after it (no model call)" },
      { name: 'pack-and-clear', description: 'Cache Keeper: acct-sync builds a handoff pack from this session (no model call), then clear and go on from it' },
    ]

    for (const spec of commands) {
      await host.registerCommand(spec).catch(() => undefined)
    }

    // A bearer is a claude.ai login: the one kind the usage endpoint answers, and the one with account limits.
    state.authKind = (await host.authorize().catch(() => null))?.kind ?? null

    await refresh(host, true)
    state.isBound = true

    // A response that landed while the module bound (a reload mid-turn): written now, not dropped.
    if (state.heldRateLimits !== null) {
      const rateLimits = state.heldRateLimits

      state.heldRateLimits = null
      await recordResponse(rateLimits)
    }

    host.invalidate()
  }

  async function tick(): Promise<void> {
    const host = state.host

    if (host === null || state.isTicking) {
      return
    }

    state.isTicking = true

    try {
      state.ticks += 1
      state.now = await host.now().catch(() => state.now + TICK_MS)

      if (state.ticks % REFRESH_TICKS === 0) {
        await refresh(host, false)
      }

      if (state.ticks % HEARTBEAT_TICKS === 1) {
        // The status line stands down while this is fresh: one strip, not two.
        const beat = liveFile('.module')

        if (beat !== null) {
          await host.write(beat, beatOf(state.now)).catch(() => undefined)
        }
      }

      checkWarning(host)
      await checkQuestion(host)
      checkStale(host)
      checkQueued()

      if (!state.isPolling && isPollDue(state.account)) {
        void pollUsage(host)
      }

      host.invalidate()
    } catch {
      // a tick never throws into the engine
    } finally {
      state.isTicking = false
    }
  }

  on('session.start', async ($, e, next) => {
    try {
      const host = hostOf($)

      for (const timer of state.timers) {
        timer.cancel()
      }

      state.timers.clear()
      state.host = host
      state.isInteractive = e.isInteractive === true && e.surface === 'terminal'

      if (state.isInteractive) {
        state.isBound = false
        state.timers.add(host.every(TICK_MS, () => void tick()))
        void bind(host).catch(() => undefined)
      }
    } catch {
      // never in the way of a session starting
    }

    return next(e)
  })

  // ----------------------------------------------------------------- strip

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!state.isInteractive || state.host === null || e.surface !== 'terminal' || e.props?.hasSurvey === true) {
      return next(e)
    }

    if (typeof e.props?.isWorking === 'boolean') {
      state.isWorking = e.props.isWorking
    }

    const table = $.ui.resolve(e)
    const view = viewNow()
    const columns = wholeOf(e.props?.bodyColumns) || wholeOf(e.viewport?.columns) || 100
    const segments = core.withHeld(core.segmentsOf(view, state.now, { seconds: true }), state.held)

    return stripView({ Box: table.Box, Text: table.Text, Button: table.Button }, segments, buttonsOf(view), columns)
  })

  function buttonsOf(view: ReturnType<typeof core.viewOf>): StripButton[] {
    const handoff = state.handoff

    if (handoff.phase !== 'idle') {
      const key = handoff.kind === 'brief' ? 'handoff' : handoff.kind

      return [{ key, label: `${handoff.kind === 'pack' ? 'Pack' : 'Handoff'}: ${phaseWords(handoff)}…`, isDim: true, onPress: () => undefined }]
    }

    // Cold: a brief would send the whole conversation again at the cache-write price. The ways on
    // that need no model call; /cache-keeper handoff still asks for the brief. Without acct-sync there
    // is no pack, and Handoff & Clear stays.
    if (view.cache.state === 'cold' && !state.isWorker) {
      const buttons: StripButton[] = []

      // Dim while Claude works (the first turn of a cold session): a press then queues behind it. Not
      // while Claude's question is open: the handoff predates the question.
      if (state.latest !== null && state.question === null) {
        buttons.push({ key: 'latest', label: LABEL.latest, isDim: state.isWorking, onPress: () => startCold('latest') })
      }

      if (state.hasPackTool === true) {
        // Not dim while the question is open: the turn waits on the person, so the press ends it.
        buttons.push({ key: 'pack', label: LABEL.pack, isDim: state.isWorking && state.question === null, onPress: () => startCold('pack') })
      } else {
        buttons.push({ key: 'handoff', label: LABEL.brief, isDim: state.isWorking, onPress: () => startHandoff() })
      }

      return buttons
    }

    // Dim while Claude works: a press then queues the handoff behind the turn.
    return [{ key: 'handoff', label: LABEL.brief, isDim: state.isWorking, onPress: () => startHandoff() }]
  }

  // ----------------------------------------------------------- the warning

  function checkWarning(host: Host): void {
    const config = state.config

    if (!config.notify || config.warnMinutes <= 0) {
      return
    }

    const view = viewNow()
    const cache = view.cache

    if (cache.state !== 'warning' || cache.expiresAt === null || state.notifiedFor === cache.expiresAt) {
      return
    }

    state.notifiedFor = cache.expiresAt
    void warn(host, view, cache.expiresAt)
  }

  async function warn(host: Host, view: ReturnType<typeof core.viewOf>, expiresAt: number): Promise<void> {
    const marker = liveFile('.notified')

    // A restarted module, or the status line before it, may have sent this one already.
    if (marker !== null && (await host.read(marker).catch(() => '')).trim() === String(expiresAt)) {
      return
    }

    if (marker !== null) {
      await host.write(marker, String(expiresAt)).catch(() => undefined)
    }

    await notify(host, core.warningNotice(view))
  }

  async function notify(host: Host, notice: { title: string; body: string }): Promise<void> {
    host.toast(`${notice.title}. ${notice.body}`, TOAST_MS)

    const notifier = core.notifyArgv(state.platform, { ...notice, tag: state.sessionId ?? undefined })

    if (notifier !== null) {
      await host.notify(notifier.argv, notifier.env).catch(() => undefined)
    }
  }

  // ------------------------------------------------------ account limits

  /**
   * The 5-hour and weekly limits are the account's, not the session's, but a session learns them only
   * from its own responses: an idle one keeps showing the figures of its last request. So every
   * session puts what its responses report in one shared `limits.json` (session.measure), and one
   * session at a time asks the usage endpoint behind /usage, which also sees what claude.ai and other
   * machines used. The strip shows whichever is newest.
   */
  on('session.measure', async ($, e, next) => {
    if (state.isInteractive && Array.isArray(e.changed) && e.changed.includes('rateLimits')) {
      void recordResponse(e.rateLimits)
    }

    return next(e)
  })

  async function recordResponse(rateLimits: unknown): Promise<void> {
    const host = state.host
    const windows = core.windowsOfRateLimits(rateLimits)

    if (host === null || (windows.fiveHour === null && windows.sevenDay === null)) {
      return
    }

    // Before bind() knows where the files are and what time it is: held, and written once it does.
    if (!state.isBound) {
      state.heldRateLimits = rateLimits

      return
    }

    if (state.dir === null) {
      return
    }

    const path = `${state.dir}/limits.json`
    // A half-written file (another session mid-write) reads as nothing: merge into the last good one.
    const before = core.accountOf(parseJson(await host.read(path).catch(() => ''))) ?? state.account
    const after = core.measured(before, windows, state.now)

    // No newer than what the file holds: this response's headers left the server before that was read.
    if (after === null) {
      return
    }

    await host.write(path, JSON.stringify(after)).catch(() => undefined)
    state.account = after
    host.invalidate()
  }

  function isPollDue(account: Account): boolean {
    const me = state.sessionId

    if (!state.isInteractive || state.authKind !== 'bearer' || state.dir === null || me === null) {
      return false
    }

    // Not in a session's first seconds either: after a reload every session binds at once.
    const jitterMs = jitterOf(me)

    return state.now >= state.boundAt + jitterMs && core.isPollDue(account, state.now, { pollMs: state.config.limitsPollSeconds * 1000, me, jitterMs })
  }

  async function pollUsage(host: Host): Promise<void> {
    state.isPolling = true

    try {
      const path = `${state.dir}/limits.json`
      const me = state.sessionId ?? ''
      // Read again, not from state: another session may have polled or claimed a moment ago. A file
      // that reads as nothing (half-written by another session) falls back to the last good one.
      const before = core.accountOf(parseJson(await host.read(path).catch(() => ''))) ?? state.account

      if (!isPollDue(before)) {
        return
      }

      await host.write(path, JSON.stringify(core.claimed(before, me, state.now))).catch(() => undefined)

      const auth = await host.authorize().catch(() => null)
      let after: Account

      if (auth === null || auth.kind !== 'bearer') {
        state.authKind = auth?.kind ?? null
        after = core.released(before)
      } else {
        try {
          const answer = await host.fetch(core.USAGE_URL, { auth: auth.handle, headers: { ...core.USAGE_HEADERS } })
          const read = answer.ok ? core.limitsOfUsage(parseJson(answer.text)) : null

          after =
            read !== null
              ? core.polled(before, read, me, state.now)
              : core.pollFailed(before, me, state.now, answer.ok ? 'the answer held no usage windows' : `HTTP ${answer.status}`, state.config.limitsPollSeconds * 1000)
        } catch (error) {
          after = core.pollFailed(before, me, state.now, errorText(error), state.config.limitsPollSeconds * 1000)
        }
      }

      await host.write(path, JSON.stringify(after)).catch(() => undefined)
      state.account = after
      host.invalidate()
    } catch {
      // a poll never throws into the tick
    } finally {
      state.isPolling = false
    }
  }

  // ---------------------------------------------------- Handoff & Clear

  /**
   * The button, or /cache-keeper handoff. Claude is asked for the brief in a fork of the session:
   * one tool-less question over the transcript as the main thread last sent it, served from the
   * warm cache, that leaves no turn in the transcript. While a turn runs, the handoff waits for it.
   */
  function startHandoff(): void {
    const host = state.host

    if (host === null) {
      return
    }

    if (state.handoff.phase !== 'idle') {
      host.toast(`${LABEL[state.handoff.kind]} is already ${phaseWords(state.handoff)}.`, 6000)

      return
    }

    const from = fromNow()

    if (state.isWorking) {
      state.handoff = { phase: 'queued', kind: 'brief', since: state.now, from }
      host.toast('Handoff & Clear is queued: it runs as soon as Claude finishes this turn.', 8000)
      host.invalidate()

      return
    }

    void writeBrief(host, from)
  }

  function fromNow(): From {
    return { sessionId: state.sessionId, sessionName: current().sessionName, at: state.now }
  }

  async function writeBrief(host: Host, from: From): Promise<void> {
    state.handoff = { phase: 'writing', kind: 'brief', since: state.now, from }
    host.invalidate()

    let result: Awaited<ReturnType<Host['fork']>>

    try {
      result = await host.fork(core.handoffPrompt())
    } catch (error) {
      stopHandoff(host, 'brief', `the brief could not be asked for (${errorText(error)})`)

      return
    }

    if (state.handoff.phase !== 'writing') {
      return
    }

    if (result?.isAnswered !== true) {
      stopHandoff(host, 'brief', forkFailure(result))

      return
    }

    const brief = core.briefOf(result.text)

    if (brief === null) {
      stopHandoff(host, 'brief', 'the reply held no brief')

      return
    }

    await briefWritten(host, from, brief)
  }

  function stopHandoff(host: Host, kind: Kind, why: string): void {
    state.handoff = { phase: 'idle' }
    host.toast(`${LABEL[kind]} stopped: ${why}. Nothing was cleared.`, TOAST_MS)
    host.invalidate()
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      state.isWorking = true
      // What `$.turn.abort` names: the turn Claude's question waits in.
      state.turnId = typeof e.turnId === 'string' ? e.turnId : null

      // The clock of a question this turn raises: its requests start after this. The module's clock, read now,
      // never runs ahead of real time; null until the module is bound.
      const host = state.host

      if (host !== null && state.isBound) {
        state.now = await host.now().catch(() => state.now)
        state.turnAt = state.now
      } else {
        state.turnAt = null
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      state.isWorking = false
      state.turnId = null

      if (state.abortedTurnId === e.turnId) {
        state.abortedTurnId = null
      }

      const host = state.host

      if (state.handoff.phase === 'queued' && host !== null) {
        // After the turn's hooks have settled, so the fork reads the turn's last reply too.
        state.timers.add(host.after(50, () => runQueued()))
      }

      // A held text that waited for the command pointer of a fresh session: in the prompt now.
      const after = state.afterPointer

      if (after !== null && host !== null) {
        state.afterPointer = null
        refillLater(host, after.text, 0)
        void releaseHeld(host, after)
      }
    }

    return result
  })

  async function briefWritten(host: Host, from: From, brief: string): Promise<void> {
    let file: string | null = null

    if (state.dir !== null) {
      const path = `${state.dir}/handoffs/${core.briefFileName(from.at, from.sessionId)}`

      file = await host.write(path, `${brief}\n`).then(
        () => path,
        () => null,
      )
    }

    toClear(host, { kind: 'brief', since: state.now, from, text: core.pastedBrief(brief, from), file })
  }

  /**
   * What there is to go on from is ready: clear, then paste it. What the guard holds now goes with it,
   * taken here as well as at the clear: a tick that sees the new session first forgets it.
   */
  function toClear(host: Host, ready: Ready): void {
    state.handoff = { ...ready, phase: 'clearing', carry: state.held }
    host.invalidate()
    // Off any dispatch first: /clear is a queued command, run once the session is idle.
    state.timers.add(host.after(100, () => void clearNow()))
  }

  async function clearNow(): Promise<void> {
    const host = state.host

    if (host === null || state.handoff.phase !== 'clearing') {
      return
    }

    try {
      await host.runCommand('clear')
      cleared()
    } catch (error) {
      const handoff = state.handoff

      state.handoff = { phase: 'idle' }
      host.toast(`${LABEL[handoff.kind]}: /clear failed (${errorText(error)}).${savedText(handoff)}`, TOAST_MS)
      host.invalidate()
    }
  }

  /** Where what was to be pasted is kept, for a toast that says it was not. */
  function savedText(handoff: Handoff): string {
    if (!('file' in handoff) || handoff.file === null) {
      return ''
    }

    const what = handoff.kind === 'brief' ? 'The brief is saved at' : handoff.kind === 'pack' ? 'The pack is at' : 'The handoff is at'

    return ` ${what} ${shown(handoff.file)}`
  }

  /**
   * Whichever sees the clear finish first, the clear's own hook or the call that queued it, moves on.
   * The fresh conversation's first message is never held, and what the guard held goes with the
   * handoff, after the pointer.
   */
  function cleared(): void {
    const handoff = state.handoff
    // What the cleared session holds: the newest held text, else what it held when the clear was asked for.
    const from = handoff.phase === 'clearing' ? handoff.from.sessionId : null
    const own = state.held !== null && (from === null || state.held.sid === from) ? state.held : null

    forgetSession()
    state.isFresh = true
    state.afterPointer = null

    if (handoff.phase === 'clearing' && state.host !== null) {
      state.handoff = { ...handoff, phase: 'filling', since: state.now, carry: own ?? handoff.carry ?? null }
      state.timers.add(state.host.after(200, () => void paste()))
    }
  }

  async function paste(): Promise<void> {
    const host = state.host
    const handoff = state.handoff

    if (host === null || handoff.phase !== 'filling') {
      return
    }

    const label = LABEL[handoff.kind]
    const text = handoff.text
    const carry = handoff.carry ?? null
    // A command takes the whole line: text after it would become its arguments. What was held then
    // follows once the command has run.
    const isCommand = text.startsWith('/')
    const what = handoff.kind === 'brief' ? 'the brief' : isCommand ? `\`${text.trim()}\`` : `the pointer to the ${handoff.kind === 'pack' ? 'pack' : 'handoff'}`
    const heldWhat = carry === null ? '' : carry.kind === 'answer' ? 'your held answer' : 'your held message'
    const media = carry !== null && carry.attachments > 0 ? ` ${core.attachmentsNote(carry.attachments)}` : ''
    const saved = handoff.file === null ? '' : handoff.kind === 'brief' ? ` Saved: ${shown(handoff.file)}` : ` ${handoff.kind === 'pack' ? 'Pack' : 'Handoff'}: ${shown(handoff.file)}`

    try {
      const box = draftOf(await host.readPrompt().catch(() => null))
      // The box may still hold what the guard held, as it was put back there: it goes after the
      // pointer, so it is no draft of its own.
      const isHeldInBox = carry !== null && box.trim() !== '' && sameText(box, carry.text)
      const draft = isHeldInBox ? '' : box

      if (state.config.brief === 'send') {
        await host.submit(isCommand ? text : core.carriedText(text, carry?.text ?? null, null))

        if (carry !== null && isCommand) {
          state.afterPointer = carry
        }

        // Sent with the pointer: not left in the box as well, to be sent a second time.
        if (isHeldInBox && !isCommand) {
          await host.fill('').catch(() => undefined)
        }

        const sent = carry === null ? '' : isCommand ? `; ${heldWhat} goes in the prompt once it has run` : ` with ${heldWhat}`

        host.toast(`${label}: fresh session, ${handoff.kind === 'brief' ? 'brief' : what} sent${sent}.${media}${saved}`, TOAST_MS)
      } else {
        if (isCommand && draft.trim() !== '') {
          if (carry !== null) {
            state.afterPointer = carry
          }

          host.toast(`${label}: fresh session. Your draft stays in the prompt; send ${what} after it.${carry === null ? '' : ` Then ${heldWhat} goes in the prompt.`}${saved}`, TOAST_MS)

          return
        }

        const filled = await host.fill(isCommand ? text : core.carriedText(text, carry?.text ?? null, draft))

        if (filled?.isFilled === false) {
          throw new Error('the prompt box did not take it')
        }

        if (carry !== null && isCommand) {
          state.afterPointer = carry
        }

        const inPrompt =
          carry === null
            ? `${what} is in the prompt, press Enter to send it`
            : isCommand
              ? `${what} is in the prompt, press Enter to send it; ${heldWhat} goes in the prompt once it has run`
              : `${what} and ${heldWhat} are in the prompt, press Enter to send them`

        host.toast(`${label}: fresh session; ${inPrompt}.${media}${saved}`, TOAST_MS)
      }

      // Carried: the session it was held in no longer holds it. One that follows a command is
      // kept there until it is in the prompt, so a reload in between loses nothing.
      if (carry !== null && !isCommand) {
        await releaseHeld(host, carry)
      }
    } catch (error) {
      host.toast(`${label}: the session is clear, but ${what} could not be pasted (${errorText(error)}).${saved}`, TOAST_MS)
    } finally {
      state.handoff = { phase: 'idle' }
      host.invalidate()
    }
  }

  /**
   * A cold-cache way queued behind a turn that never reported its end (a command answered by a hook
   * may start none): it runs once Claude has been idle a second. A brief waits for the turn's end, so
   * that the fork reads its last reply.
   */
  function checkQueued(): void {
    const handoff = state.handoff

    if (handoff.phase !== 'queued' || handoff.kind === 'brief') {
      return
    }

    // Claude's question holds the turn open until the person answers: Pack & Clear does not wait for it.
    if ((!state.isWorking && state.now - handoff.since >= QUEUE_IDLE_MS) || (handoff.kind === 'pack' && state.question !== null)) {
      runQueued()
    }
  }

  function checkStale(host: Host): void {
    const handoff = state.handoff

    if (handoff.phase === 'idle' || state.now - handoff.since <= STALE_MS[handoff.phase]) {
      return
    }

    state.handoff = { phase: 'idle' }
    host.toast(`${LABEL[handoff.kind]} gave up while ${phaseWords(handoff)}.${savedText(handoff)}`, TOAST_MS)
  }

  // ------------------------------------------- once the cache is cold

  /** Why a cold-cache way cannot start now, or null when it can. `path` shows a path: plainly in a toast, in a code span in a reply. */
  function refusal(kind: Kind, path: (p: string) => string = shown): string | null {
    const label = LABEL[kind]

    if (!state.isInteractive || state.host === null) {
      return `${label} runs in an interactive session.`
    }

    if (state.handoff.phase !== 'idle') {
      const running = state.handoff.kind === kind ? '' : `${LABEL[state.handoff.kind]} `

      return running === '' ? `${label} is already ${phaseWords(state.handoff)}.` : `${label} did not start: ${running}is already ${phaseWords(state.handoff)}.`
    }

    if (state.isWorker) {
      return `${label} stays out of a hub worker: its hub hands it over (handoff-g<N>.md) and reaches it by its session id, which a /clear changes.`
    }

    if (state.sessionId === null || state.dir === null) {
      return `${label}: this session's id or Claude Code's config directory is not known.`
    }

    if (kind === 'pack' && state.hasPackTool !== true) {
      const tool = packTool()

      return `${label} needs acct-sync, which is not installed here (looked for ${tool === null ? 'it' : path(tool)}). Use Latest Handoff (/use-latest-handoff) goes on from a current handoff with no model call, and Handoff & Clear (/cache-keeper handoff) asks Claude for a brief.`
    }

    if (kind === 'latest' && state.question !== null) {
      const pack = state.hasPackTool === true ? ' Pack & Clear (/pack-and-clear) ends the turn and carries the question to a fresh session.' : ' Answer it: on a cold cache the answer is held, and the strip then carries it to a fresh session.'

      return `${label} waits while Claude's question is open: the handoff predates the question.${pack}`
    }

    return null
  }

  /**
   * A cold-cache way from its button: now, or queued behind Claude's turn, as Handoff & Clear is.
   * The commands queue it always (startFromCommand): a typed command is a turn of its own for a moment.
   */
  function startCold(kind: ColdKind): void {
    const host = state.host
    const refused = refusal(kind)

    if (host === null || refused !== null) {
      host?.toast(refused ?? '', TOAST_MS)
      return
    }

    // Claude's question holds the turn open until the person answers: Pack & Clear ends it instead of waiting.
    if (state.isWorking && !(kind === 'pack' && state.question !== null)) {
      state.handoff = { phase: 'queued', kind, since: state.now, from: fromNow() }
      host.toast(`${LABEL[kind]} is queued: it runs as soon as Claude finishes this turn.`, 8000)
      host.invalidate()
      return
    }

    runCold(host, kind, fromNow())
  }

  function runCold(host: Host, kind: ColdKind, from: From): void {
    void (kind === 'latest' ? useLatest(host, from) : packAndClear(host, from))
  }

  /** What was queued, once Claude's turn has ended; whichever of the turn's end and the tick sees it first. */
  function runQueued(): void {
    const host = state.host
    const handoff = state.handoff

    if (host === null || handoff.phase !== 'queued') {
      return
    }

    if (handoff.kind === 'brief') {
      void writeBrief(host, handoff.from)
    } else {
      runCold(host, handoff.kind, handoff.from)
    }
  }

  /**
   * Use Latest Handoff: the session wrote a handoff and did no work after it (handoff-guard's record
   * says so), so the fresh session can start from that file as it is.
   */
  async function useLatest(host: Host, from: From): Promise<void> {
    state.handoff = { phase: 'preparing', kind: 'latest', since: state.now, from }
    host.invalidate()

    // Read again: the record may have moved since the strip last looked.
    await refreshGuard(host, true).catch(() => undefined)

    if (!isPreparing('latest')) {
      return
    }

    const latest = state.latest

    if (latest === null) {
      stopHandoff(host, 'latest', `there is no current handoff to go on from: ${state.latestWhy(shown)}`)
      return
    }

    toClear(host, { kind: 'latest', since: state.now, from, text: core.pastedLatest(latest, from), file: latest.path })
  }

  /**
   * Pack & Clear: acct-sync builds a pack from the session's transcript without a model call
   * (`handoff <sid> --kind clear`). Where Claude Code saved no transcript, it builds one from what
   * the engine holds, exported to `exports/<sid>.json`. With Claude's question open, the turn that
   * waits on it is ended once the pack is built, the question in it still unanswered.
   */
  async function packAndClear(host: Host, from: From): Promise<void> {
    const sessionId = state.sessionId as string
    const tool = packTool() ?? 'acct-sync.mjs'

    state.handoff = { phase: 'preparing', kind: 'pack', since: state.now, from }
    host.invalidate()

    try {
      if ((await host.stat(tool).catch(() => undefined)) === undefined) {
        throw new Error(`it needs acct-sync, which is not at ${shown(tool)}`)
      }

      // The status line names the transcript: where it is missing, go straight to the export.
      const transcript = own().transcriptPath
      const isMissing = typeof transcript === 'string' && transcript !== '' && (await host.stat(transcript).catch(() => undefined)) === undefined
      let made = isMissing ? ({ missing: true } as const) : core.packOf(await host.run(core.packArgv(tool, sessionId), PACK_TIMEOUT_MS))

      if ('missing' in made) {
        const file = await exportConversation(host, sessionId)

        made = core.packOf(await host.run(core.packArgv(tool, file), PACK_TIMEOUT_MS))

        if ('missing' in made) {
          throw new Error('acct-sync found no session in the exported conversation')
        }
      }

      if ('error' in made) {
        throw new Error(made.error)
      }

      // The turn Claude's question holds open would never end on its own: ended now, with no model call.
      const question = state.question

      if (isPreparing('pack') && question !== null) {
        const ended = await endTurn(host, question.turnId ?? state.turnId)

        if (!ended.ok) {
          throw new Error(ended.why)
        }
      }

      if (isPreparing('pack')) {
        toClear(host, { kind: 'pack', since: state.now, from, text: core.pastedPack(made.pack, from), file: made.pack })
      }
    } catch (error) {
      if (isPreparing('pack')) {
        stopHandoff(host, 'pack', errorText(error))
      }
    }
  }

  function isPreparing(kind: Kind): boolean {
    return state.handoff.phase === 'preparing' && state.handoff.kind === kind
  }

  /** The conversation as the engine holds it, written where acct-sync takes it: the session saved no transcript. */
  async function exportConversation(host: Host, sessionId: string): Promise<string> {
    const [messages, cwd, model, usage, child] = await Promise.all([
      host.messages(),
      host.cwd().catch(() => null),
      host.model().catch(() => null),
      usageWithin(host).catch(() => null),
      host.childSession().catch(() => undefined),
    ])

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('this session saved no transcript, and the engine holds no conversation to export')
    }

    const snapshot = own()
    const startedAt = (usage as { startedAt?: unknown } | null)?.startedAt
    // Within the 4 MiB a write may carry: what the pack does not read is cut first.
    const text = core.engineExport({
      messages,
      sessionId,
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : snapshot.cwd,
      configDir: state.root,
      at: state.now,
      startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null,
      lastTurnAt: snapshot.cache?.lastAt ?? null,
      model: modelIdOf(model) ?? snapshot.model,
      title: snapshot.sessionName,
      why: isSet(child) ? 'Claude Code saves none for a process started from inside another Claude session, which sets CLAUDE_CODE_CHILD_SESSION' : null,
      contextTokens: snapshot.context.tokens,
      handoff: state.guardTrack,
      // Asked and not answered: the pack shows it so.
      openQuestion: state.question?.toolUseId ?? null,
    })
    const file = `${state.dir}/exports/${safeName(sessionId)}.json`

    await host.write(file, text).catch(error => {
      throw new Error(`the conversation could not be exported (${errorText(error)})`)
    })

    return file
  }

  /**
   * The cold-cache ways as commands: answered at once, run once the command's own turn has ended (the
   * engine counts a typed command as Claude working for a moment, and a /clear inside it would queue).
   */
  async function startFromCommand(kind: ColdKind): Promise<{ text: string }> {
    const host = state.host

    // Looked for again: it may have been installed, or removed, since the strip last looked.
    if (host !== null && kind === 'pack' && state.dir !== null) {
      await checkPackTool(host)
    }

    const refused = refusal(kind, shownInReply)

    if (host === null || refused !== null) {
      return { text: refused ?? `${LABEL[kind]} runs in an interactive session.` }
    }

    // Claude's question holds the turn open until the person answers: Pack & Clear does not wait for it.
    if (kind === 'pack' && state.question !== null) {
      runCold(host, 'pack', fromNow())

      return { text: "Pack & Clear: Claude's question holds the turn open, so acct-sync builds the pack now (no model call), then the turn is ended and the session clears." }
    }

    state.handoff = { phase: 'queued', kind, since: state.now, from: fromNow() }
    host.invalidate()

    // Measured: Claude Code shows Claude working while it runs a typed command, so this is the usual case,
    // and with no turn running it waits a moment, not a turn.
    if (state.isWorking) {
      return {
        text:
          kind === 'latest'
            ? 'Use Latest Handoff: it runs once Claude is idle (after the turn, if one is running), then checks the handoff and clears the session.'
            : 'Pack & Clear: it runs once Claude is idle (after the turn, if one is running); acct-sync then builds the pack (no model call) and the session clears.',
      }
    }

    return {
      text:
        kind === 'latest'
          ? 'Use Latest Handoff: checking that the handoff is current; the session clears once it is.'
          : 'Pack & Clear: acct-sync is building the pack (no model call); the session clears when it is written.',
    }
  }

  // -------------------------------------------------------------- commands

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const result = await next(e)

    cleared()

    return result
  })

  on('command.run', { command: 'resume' }, async ($, e, next) => {
    const result = await next(e)

    forgetSession()
    // A resumed conversation is read again in full by its next message: the guard stands for it.
    state.isFresh = false
    state.afterPointer = null

    return result
  })

  // The typed ways in: commands the module answers itself, so they cost no model turn.
  on('command.run', { command: 'use-latest-handoff' }, async () => startFromCommand('latest'))
  on('command.run', { command: 'pack-and-clear' }, async () => startFromCommand('pack'))

  on('command.run', { command: 'cache-keeper' }, async ($, e, next) => {
    const host = state.host

    if (host === null) {
      return { text: 'Cache Keeper is not running in this session.' }
    }

    const edit = core.configEdit(state.config, typeof e.args === 'string' ? e.args : '')

    if ('error' in edit) {
      return { text: `Cache Keeper: ${edit.error}` }
    }

    if ('action' in edit) {
      if (edit.action === 'test-notify') {
        await notify(host, { title: 'Cache Keeper test', body: 'This is how the warning before the cache goes cold arrives.' })

        return { text: 'Cache Keeper: test notification sent.' }
      }

      if (edit.action === 'handoff') {
        if (!state.isInteractive) {
          return { text: 'Handoff & Clear runs in an interactive session.' }
        }

        // Off the command's own hook, so the clear it ends with is not queued inside this command.
        state.timers.add(host.after(10, () => startHandoff()))

        return { text: 'Handoff & Clear: asking Claude for the brief. The session clears when it arrives.' }
      }

      if (edit.action === 'latest' || edit.action === 'pack') {
        return startFromCommand(edit.action)
      }

      return { text: await statusText(host) }
    }

    state.config = edit.config
    state.notifiedFor = null

    if (state.dir !== null) {
      const written = await host.write(`${state.dir}/config.json`, `${JSON.stringify(edit.config, null, 2)}\n`).then(
        () => true,
        () => false,
      )

      if (!written) {
        return { text: `Cache Keeper: ${edit.text} (for this session only: config.json could not be written)` }
      }
    }

    host.invalidate()

    return { text: `Cache Keeper: ${edit.text}` }
  })

  async function statusText(host: Host): Promise<string> {
    const snapshot = current()
    const tool = packTool()
    const hasTool = await checkPackTool(host)
    const transcript = own().transcriptPath
    const hasTranscript = typeof transcript === 'string' && transcript !== '' ? (await host.stat(transcript).catch(() => undefined)) !== undefined : null
    const child = isSet(await host.childSession().catch(() => undefined))

    // The figure a hold decision would go by now: the session usage is read for it, as there.
    state.now = await host.now().catch(() => state.now)
    await readUsage(host)

    const view = viewNow()
    const cache = view.cache
    const figure =
      view.tokensIfCold === null
        ? 'no token figure yet'
        : `${core.tokenLabel(view.tokensIfCold)} tokens from ${view.tokensFrom.source === 'usage' ? 'the session usage' : 'the status line'}${view.tokensFrom.at !== null ? `, read ${new Date(view.tokensFrom.at).toLocaleTimeString()}` : ''}`
    const source = {
      claude: "measured by Claude Code's cache tracker",
      transcript: "measured from the transcript's last request",
      override: typeof state.overrides.ttl === 'number' ? 'forced by CACHE_KEEPER_TTL' : 'forced by /cache-keeper ttl',
      fallback: 'assumed: nothing measured yet',
    }
    const lines = [
      `Cache Keeper ${core.VERSION}`,
      `cache: ${cache.state}${cache.isAssumedCold === true ? ' (assumed)' : cache.expiresAt !== null ? `, cold at ${new Date(cache.expiresAt).toLocaleTimeString()}` : ''}; TTL ${cache.ttlLabel} (${cache.source === null ? 'no request yet' : source[cache.source]})`,
      view.next !== null
        ? `next message: ${core.usd(view.next.warm)} warm, ${core.usd(view.next.cold)} cold (${core.tokenLabel(view.tokensIfCold ?? 0)} tokens)`
        : view.tokensIfCold === null
          ? 'next message: nothing measured yet'
          : `next message: no price known for ${snapshot.model ?? 'this model'}`,
      `data: ${state.snapshot !== null ? 'status line snapshot' : 'session usage only (no status line snapshot for this session)'}; ${figure}`,
      `limits: ${limitsText(snapshot)}`,
      `settings: ttl ${state.config.ttl}, fallback ${state.config.fallbackTtlMinutes} min, warn ${state.config.warnMinutes} min, notify ${state.config.notify ? 'on' : 'off'}, statusline ${state.config.statusLine}, brief ${state.config.brief}, limits ${state.config.limitsPollSeconds > 0 ? `${state.config.limitsPollSeconds} s` : 'off'}, hold ${tokensSetting(state.config.holdColdAt)}`,
      `files: ${state.dir !== null ? shownInReply(state.dir) : '(no home directory found)'}`,
      `once cold: ${state.isWorker ? 'no buttons in a hub worker' : hasTool ? 'Use Latest Handoff and Pack & Clear in place of Handoff & Clear' : 'Use Latest Handoff, and Handoff & Clear (no Pack & Clear: acct-sync is not installed)'}`,
      `  latest handoff: ${state.latest !== null ? `${shownInReply(state.latest.path)}, written ${new Date(state.latest.at).toLocaleTimeString()}, no work after it` : `none to go on from (${state.latestWhy(shownInReply)})`}`,
      `  pack: ${hasTool ? `acct-sync at ${shownInReply(tool as string)}` : `acct-sync is not at ${tool === null ? '?' : shownInReply(tool)}`}; transcript ${hasTranscript === null ? 'not named yet' : hasTranscript ? 'saved' : `NOT saved${child ? ' (CLAUDE_CODE_CHILD_SESSION is set)' : ''}: a pack is built from what the engine holds`}`,
      ...guardLines(view),
      '',
      core.CONFIG_USAGE,
    ]

    return lines.join('\n')
  }

  /** The cold-send guard's part of the status: its threshold, its overrides, what it holds, an open question. */
  function guardLines(view: ReturnType<typeof core.viewOf>): string[] {
    const limit = holdColdAt()
    const override = state.overrides.holdColdAt !== null ? ` (CACHE_KEEPER_HOLD_COLD_AT; the setting says ${tokensSetting(state.config.holdColdAt)})` : ''
    const held = state.held
    const lines = [
      limit > 0
        ? `cold-send guard: holds a message typed into a cold session that would re-read ${core.tokenLabel(limit)} tokens or more${override}${state.isWorker ? '; never in a hub worker' : ''}`
        : `cold-send guard: off${override}`,
    ]

    if (state.overrides.isAssumedCold) {
      lines.push('  CACHE_KEEPER_ASSUME_COLD is set: the cache counts as cold')
    }

    const ttl = state.overrides.ttl

    if (ttl !== null) {
      const setting = state.config.ttl === 'auto' ? 'auto' : `${state.config.ttl} min`

      lines.push(
        ttl === 'auto'
          ? `  CACHE_KEEPER_TTL is set: the TTL is what Claude Code measured, whatever the setting says (${setting})`
          : `  CACHE_KEEPER_TTL is set: the TTL is ${ttl} min, whatever Claude Code measured (the setting says ${setting})`,
      )
    }

    const tracePath = state.overrides.isTraced ? liveFile('.trace.jsonl') : null

    if (tracePath !== null) {
      lines.push(`  CACHE_KEEPER_TRACE is set: each hold decision is written to ${shownInReply(tracePath)}`)
    }

    lines.push(
      held === null
        ? '  held: nothing'
        : `  held: ${held.kind === 'answer' ? "your answer to Claude's question" : 'a message'}, since ${new Date(held.at).toLocaleTimeString()}: "${preview(held.text)}" (Enter on it sends it; a cold-cache way carries it)`,
    )

    if (state.question !== null) {
      const clock = view.clock.name === 'turn-start' && view.clock.turnAt !== null ? `; the cache counts from its turn's start, ${new Date(view.clock.turnAt).toLocaleTimeString()}` : ''

      lines.push(`  Claude's question is open, since ${new Date(state.question.at).toLocaleTimeString()}${clock}: an answer now ${isColdSend(view) ? 'is held, and its turn ended' : 'goes to Claude'}`)
    }

    return lines
  }

  /** What the strip shows for the limits, and where it came from. */
  function limitsText(snapshot: Snapshot): string {
    const { fiveHour, sevenDay, scoped } = snapshot.limits as Snapshot['limits'] & { scoped?: { name: string; pct: number }[] | null }
    const figures = [
      fiveHour !== null ? `5h ${Math.round(fiveHour.pct)}%` : null,
      sevenDay !== null ? `wk ${Math.round(sevenDay.pct)}%` : null,
      ...(scoped ?? []).map(s => `${s.name} ${Math.round(s.pct)}%`),
    ].filter(x => x !== null)
    const shown = figures.length > 0 ? figures.join(', ') : 'none yet'
    const account = state.account
    const polling = state.config.limitsPollSeconds > 0 ? `the usage endpoint is read every ${state.config.limitsPollSeconds} s by one session at a time` : 'polling is off'
    const failed = account?.error ? `; the last read failed (${account.error}), retrying after ${new Date(account.backoffUntil).toLocaleTimeString()}` : ''

    const fit = core.accountFit(own(), account, state.now, { isSubscription: state.authKind === 'bearer' })

    if (fit === 'another-login' && account?.sevenDay?.resetsAt != null) {
      return `${shown}, from this session's own last response: the file holds another login's reading, whose week ends ${new Date(account.sevenDay.resetsAt).toLocaleString()} (${polling}${failed})`
    }

    if (account === null || fit !== 'applies') {
      return `${shown}, from this session's own last response (${polling}${failed})`
    }

    const age = Math.max(0, Math.round((state.now - account.at) / 1000))

    return `${shown}, from ${account.source === 'usage' ? 'the usage endpoint' : "a session's response"} ${age} s ago (${polling}${failed})`
  }
}

// ----------------------------------------------------------------- helpers

/**
 * Claude Code's config directory: CLAUDE_CONFIG_DIR, else `<home>/.claude`, the home as Node's
 * `os.homedir()` reads it, which the status line uses: USERPROFILE on Windows alone (WSL and Git
 * tools can carry a Windows USERPROFILE into Linux), HOME everywhere else. Cache Keeper's files are
 * in `cache-keeper/` there.
 */
async function configRootOf(host: Host, platform: string): Promise<string | null> {
  const configDir = await host.configDir().catch(() => undefined)

  if (typeof configDir === 'string' && configDir !== '') {
    return configDir
  }

  const profile = platform === 'win32' ? await host.userProfile().catch(() => undefined) : undefined
  const home = typeof profile === 'string' && profile !== '' ? profile : await host.home().catch(() => undefined)

  return typeof home === 'string' && home !== '' ? `${home}/.claude` : null
}

/**
 * The overrides for a test in the real engine, where config.json is every session's: CACHE_KEEPER_HOLD_COLD_AT
 * (tokens, `150k`, `off`), CACHE_KEEPER_ASSUME_COLD, CACHE_KEEPER_TRACE (each hold decision written to a file),
 * and CACHE_KEEPER_TTL (minutes, or `auto`: the TTL, as the `ttl` setting forces it).
 */
function overridesOf(holdColdAt: unknown, assumeCold: unknown, traced: unknown, ttl: unknown): { holdColdAt: number | null; isAssumedCold: boolean; isTraced: boolean; ttl: number | 'auto' | null } {
  return {
    holdColdAt: typeof holdColdAt === 'string' && holdColdAt.trim() !== '' ? core.tokensOf(holdColdAt) : null,
    isAssumedCold: isSet(assumeCold),
    isTraced: isSet(traced),
    ttl: typeof ttl === 'string' ? core.ttlOverrideOf(ttl) : null,
  }
}

/** A time for the trace: ISO, or null. */
const isoOf = (time: number | null) => (time === null ? null : new Date(time).toISOString())

/** The start of a tool_use id, enough to tell calls apart in the trace. */
const idPrefix = (id: string) => id.slice(0, 16)

/** Two prompts the same as the box hands them back: ends trimmed, the code points a terminal draws as nothing gone. */
function sameText(a: string, b: string): boolean {
  const plain = (s: string) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').normalize('NFC').trim()

  return plain(a) === plain(b)
}

/** The start of a held text, on one line, for the status. */
function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

const tokensSetting = (n: number) => (n > 0 ? `${core.tokenLabel(n)} tokens` : 'off')

/** What handoff-guard's record says of the newest handoff, current or not: acct-sync is told of it. */
function recordTrack(record: unknown, sessionId: string): GuardTrack | null {
  const o = (typeof record === 'object' && record !== null ? record : {}) as { sid?: unknown; track?: { handoffPath?: unknown; handoffAt?: unknown; turnsAfter?: unknown } }
  const track = o.track ?? {}

  if (o.sid !== sessionId || typeof track.handoffPath !== 'string' || track.handoffPath === '') {
    return null
  }

  const at = typeof track.handoffAt === 'number' && Number.isFinite(track.handoffAt) ? track.handoffAt : 0
  const turnsAfter = typeof track.turnsAfter === 'number' && Number.isInteger(track.turnsAfter) && track.turnsAfter >= 0 ? track.turnsAfter : 0

  return { path: track.handoffPath, at, turnsAfter }
}

/** An environment variable that is set to something. */
const isSet = (value: unknown) => typeof value === 'string' && value !== '' && value !== '0'

/**
 * The platform, as `process.platform` names it. The engine has no API for it, so the environment
 * says: Windows sets OS=Windows_NT for every process (a WSL or Linux one never has it), and a macOS
 * home is under /Users.
 */
async function platformOf(host: Host): Promise<string> {
  const os = await host.osName().catch(() => undefined)

  if (os === 'Windows_NT') {
    return 'win32'
  }

  const home = await host.home().catch(() => undefined)

  return typeof home === 'string' && home.startsWith('/Users/') ? 'darwin' : 'linux'
}

/** Why a fork gave no brief, in words a toast can carry. */
function forkFailure(result: { reason?: unknown; status?: unknown } | undefined): string {
  switch (result?.reason) {
    case 'nothing-to-fork':
      return 'there is nothing to hand off yet (no reply in this session)'
    case 'api-error':
      return `the API refused the request${typeof result.status === 'number' ? ` (HTTP ${result.status})` : ''}`
    case 'empty-reply':
      return 'the reply was empty'
    case 'aborted':
      return 'the request was interrupted'
    default:
      return 'no reply came back'
  }
}

function phaseWords(handoff: Handoff): string {
  switch (handoff.phase) {
    case 'queued':
      return 'queued'
    case 'writing':
      return 'writing the brief'
    case 'preparing':
      return handoff.kind === 'pack' ? 'building the pack' : 'checking the handoff'
    case 'clearing':
      return 'clearing'
    case 'filling':
      return handoff.kind === 'brief' ? 'pasting the brief' : 'pasting'
    default:
      return 'idle'
  }
}

function draftOf(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text
  }

  return ''
}

function modelIdOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown; model?: unknown }).id ?? (value as { model?: unknown }).model

    return typeof id === 'string' ? id : null
  }

  return null
}

function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1 && typeof (value as { context?: unknown }).context === 'object'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A path as the platform spells it, for a person to read. */
const shown = (path: string) => (/^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\//g, '\\') : path)

/**
 * A path in a command's reply, which Claude Code renders as Markdown: in a code span, where a `\`
 * stays as it is (outside one, `\.claude` reads as an escaped `.`).
 */
const shownInReply = (path: string) => {
  const text = shown(path)
  const fence = text.includes('`') ? '``' : '`'
  const pad = fence.length > 1 ? ' ' : ''

  return `${fence}${pad}${text}${pad}${fence}`
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_')

/** A heartbeat: when, and which build beats. The status line reads only the file's mtime. */
const beatOf = (now: number) => `${now} ${core.VERSION}`

/** A fixed offset per session, 0-15 s: spreads the sessions' polls, so the same one tends to make them. */
const jitterOf = (id: string) => [...id].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 7) % 15_000

const wholeOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 160)
