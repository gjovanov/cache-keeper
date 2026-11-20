import { describe, expect, mock, test } from 'claude-code/testing'

import * as core from '../hooks/core.mjs'
import { USAGE_BODY } from './usage-fixture.ts'

const PLUGIN = 'cache-keeper'
const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const H = 3_600_000
const M = 60_000
const DIR = 'C:/Users/t/.claude/cache-keeper'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const BAND = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  plugin: PLUGIN,
}

const command = (name: string, args = '') => ({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })

/** The week the usage fixture's login is in: a session of that login reads the same reset. */
const WEEK_ENDS = Date.parse('2026-11-01T09:00:00Z')

/** What the status line wrote for a session whose last request was at `lastAt`. */
function snapshotFor(sessionId: string, lastAt: number, rateLimits?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return core.snapshotOfStatusLine(
    {
      ...extra,
      session_id: sessionId,
      session_name: 'my-project',
      model: { id: 'claude-opus-5-5[1m]' },
      prompt_cache: { ttl: '1h', expires_at: (lastAt + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 },
      context_window: { total_input_tokens: 400000, context_window_size: 1_000_000 },
      rate_limits: rateLimits ?? { five_hour: { used_percentage: 25, resets_at: (T0 + 2 * H) / 1000 }, seven_day: { used_percentage: 50, resets_at: WEEK_ENDS / 1000 } },
      cost: { total_cost_usd: 12.5 },
    },
    null,
    T0,
  )
}

/** The engine hands a handler Windows-native paths; a test writes them with forward slashes. */
const norm = (path: string) => path.replace(/\\/g, '/')

type Run = { exitCode: number; stdout: string; stderr: string }

/** The engine beneath the module, in memory, recording everything the module asks of it. */
function worldOf(on: any, opts: { sessionId?: string; draft?: string; isWorking?: boolean; env?: Record<string, string | undefined> } = {}) {
  const world = {
    sessionId: opts.sessionId ?? 'sess-1',
    draft: opts.draft ?? '',
    // Windows, as Windows sets OS for every process.
    env: { USERPROFILE: 'C:/Users/t', OS: 'Windows_NT', ...opts.env } as Record<string, string | undefined>,
    cwd: '/work',
    // The conversation as `$.session.messages({ as: 'api' })` hands it over.
    messages: [] as unknown[],
    // What a process answers, by its argv: acct-sync where a test says so, a notification otherwise.
    runs: (argv: string[]): Run | Promise<Run> => ({ exitCode: 0, stdout: '', stderr: '' }),
    files: new Map<string, string>(),
    mtimes: new Map<string, number>(),
    tick: 1000,
    commands: [] as string[],
    submits: [] as string[],
    fills: [] as string[],
    ran: [] as string[],
    toasts: [] as string[],
    processes: [] as string[][],
    forks: [] as string[],
    forkAnswer: { isAnswered: true, text: '', usage: {} } as Record<string, unknown>,
    // No credential unless a test gives one: then nothing polls the usage endpoint.
    auth: null as { handle: string; kind: string } | null,
    fetches: [] as { url: string; init: any }[],
    fetchAnswer: { status: 200, ok: true, headers: {}, text: JSON.stringify(USAGE_BODY) } as Record<string, unknown>,
    // While set, every environment read waits for it: the module is still binding.
    envGate: null as Promise<void> | null,
    // What a process was handed in its environment, beside its argv.
    processEnvs: [] as (Record<string, string> | undefined)[],
    // `$.turn.abort` calls: the turn, and what had run and been asked for by then.
    aborts: [] as { turnId: string; runs: number; ran: string[] }[],
    // Set: the engine refuses an abort (the turn named is not the running one).
    abortRefusal: null as string | null,
    notices: [] as [string, string | undefined][],
    logs: [] as string[],
    // Claude's question as the person answers it: the dialog's result, or a promise the test settles.
    dialog: (e: any): unknown => ({ result: { questions: e.questions, answers: {} }, text: 'answered' }),
    dialogIds: [] as string[],
    // While set, a /clear has switched the session but not finished.
    clearGate: null as Promise<void> | null,
    // The session usage's figure: the input tokens of the live window's last response, null before the first.
    usageTokens: 120_000 as number | null,
    // Set: the engine refuses a read of the session usage.
    usageRefusal: null as string | null,
    // While set, every read of the session usage waits for it: a read that hangs.
    usageGate: null as Promise<void> | null,
    put(path: string, text: string) {
      world.tick += 1
      world.files.set(norm(path), text)
      world.mtimes.set(norm(path), world.tick)
    },
    get(path: string) {
      return world.files.get(norm(path))
    },
  }

  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', ($: any, e: any) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('command.run', async ($: any, e: any) => {
    world.ran.push(e.command)

    if (e.command === 'clear') {
      world.sessionId = 'sess-2'

      // A clear that takes its time: the new session id is out before the command has finished.
      if (world.clearGate !== null) {
        await world.clearGate
      }
    }

    return {}
  })
  on('prompt.submit', ($: any, e: any) => {
    world.submits.push(e.text)

    return { text: e.text }
  })
  on('prompt.fill', ($: any, e: any) => {
    world.fills.push(e.text)

    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: world.draft, cursor: world.draft.length } }))
  on('session.id', () => ({ value: world.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => {
    if (world.usageGate !== null) {
      await world.usageGate
    }

    return world.usageRefusal !== null
      ? { deny: world.usageRefusal }
      : {
          value: {
            startedAt: T0,
            context: world.usageTokens === null ? { window: 1_000_000 } : { tokens: world.usageTokens, window: 1_000_000, percent: Math.round(world.usageTokens / 10_000) },
            rateLimits: [
              { kind: 'five_hour', percentUsed: 60, resetsAt: new Date(T0 + H).toISOString() },
              { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(WEEK_ENDS).toISOString() },
            ],
            cost: { usd: 3.2 },
          },
        }
  })
  on('env.get', async ($: any, e: any) => {
    if (world.envGate !== null) {
      await world.envGate
    }

    return { value: world.env[e.name] }
  })
  on('session.cwd', () => ({ value: world.cwd }))
  on('session.messages', () => ({ value: world.messages }))
  on('fs.read', ($: any, e: any) => {
    const text = world.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', ($: any, e: any) => {
    const text = world.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file', size: text.length, mtimeMs: world.mtimes.get(norm(e.path)) ?? 0 } }
  })
  on('fs.write', ($: any, e: any) => {
    world.put(e.path, e.text)

    return { value: undefined }
  })
  on('model.fork', ($: any, e: any) => {
    world.forks.push(e.prompt)

    return { value: world.forkAnswer }
  })
  on('process.run', async ($: any, e: any) => {
    world.processes.push(e.argv)
    world.processEnvs.push(e.init?.env)

    return { value: { ...(await world.runs(e.argv)), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.abort', ($: any, e: any) => {
    world.aborts.push({ turnId: e.turnId, runs: world.processes.length, ran: [...world.ran] })

    return world.abortRefusal === null ? { value: undefined } : { deny: world.abortRefusal }
  })
  on('ui.notice', ($: any, e: any) => {
    world.notices.push([e.tool_use_id, e.text])

    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    world.logs.push(e.text)

    return { value: undefined }
  })
  on('tool.call', async ($: any, e: any) => {
    world.dialogIds.push(e.tool_use_id)

    return await world.dialog(e)
  })
  on('session.authorize', () => ({ value: world.auth }))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  on('http.fetch', ($: any, e: any) => {
    world.fetches.push({ url: e.url, init: e.init })

    return { value: world.fetchAnswer }
  })

  return world
}

function stringsOf(node: any): string[] {
  if (node === null || node === undefined) return []
  if (typeof node === 'string') return [node]
  const own = node.type === 'Button' && typeof node.props?.label === 'string' ? [`[${node.props.label}]`] : []

  return [...own, ...(node.children ?? []).flatMap((child: unknown) => stringsOf(child))]
}

const textOf = (tree: unknown) => stringsOf(tree).join('')

async function accepted($: any, input: unknown): Promise<string> {
  const mounted = await $.ui.mount(input)

  await mounted.unmount()

  return mounted.surface
}

describe('starting', () => {
  test('an interactive session gets /cache-keeper and no bare /handoff, and beats with its version', async ($, on) => {
    const world = worldOf(on)

    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION as never)
    await clock.settle()

    // A `handoff` skill elsewhere takes the bare name; the keyboard way in is /cache-keeper handoff.
    expect(world.commands).toEqual(['cache-keeper', 'use-latest-handoff', 'pack-and-clear'])
    expect(world.get(`${DIR}/live/sess-1.module`)?.endsWith(` ${core.VERSION}`)).toBe(true)
  })

  test('headless: no commands, and the band is left to whatever else draws it', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: T0 })
    await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' } as never)

    expect(world.commands).toEqual([])
    expect(textOf(await $.ui.render(BAND as never))).toBe('')
  })
})

describe('the strip above the prompt', () => {
  test('the countdown, the next message, the context, both limits and the cost, with the button', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 12 * M + 48_000 })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()

    const text = textOf(await $.ui.render(BAND as never))

    expect(text).toContain('● cache 47:12 →')
    expect(text).toContain('next msg $0.08, cold $3.20')
    expect(text).toContain('ctx 400k/1M')
    expect(text).toContain('5h 25%')
    expect(text).toContain('wk 50%')
    expect(text).toContain('session $12.50 API')
    expect(text).toContain('[Handoff & Clear]')
  })

  test('it ticks: a second later the countdown has moved', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 12 * M + 48_000 })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()
    await clock.advance(1000)

    expect(textOf(await $.ui.render(BAND as never))).toContain('● cache 47:11')
  })

  test('the terminal accepts what it draws, at every width', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 50 * M })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()

    for (const bodyColumns of [24, 48, 80, 120, 200]) {
      expect(await accepted($, { ...BAND, props: { ...BAND.props, bodyColumns } })).toBe('terminal')
    }
  })

  test('with no status line snapshot it says the cache is unknown, and shows what the session usage knows', async ($, on) => {
    worldOf(on)

    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION as never)
    await clock.settle()

    const text = textOf(await $.ui.render(BAND as never))

    expect(text).toContain('○ cache ?')
    expect(text).toContain('ctx 120k')
    expect(text).toContain('5h 60%')
    expect(text).not.toContain('no cache yet')
  })

  test("a snapshot written for another session is not this one's", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('someone-else', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()

    expect(textOf(await $.ui.render(BAND as never))).toContain('○ cache ?')
  })
})

describe('the warning before the cache goes cold', () => {
  test('once, when the window opens: in Claude Code and on the desktop', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 54 * M + 58_000 })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()

    expect(world.toasts, 'not yet: more than 5 minutes left').toEqual([])

    await clock.advance(3000)
    await clock.settle()

    expect(world.toasts.length).toBe(1)
    expect(world.toasts[0]).toContain('Cache goes cold in 5 min · my-project')
    expect(world.processes.length).toBe(1)
    expect(world.processes[0]).toEqual(core.notifyArgv('win32', { title: 't', body: 'b' })!.argv)
    expect(world.processEnvs[0]?.CACHE_KEEPER_TOAST_TITLE, 'the texts travel in its environment').toBe('Cache goes cold in 5 min · my-project')
    expect(world.processEnvs[0]?.CACHE_KEEPER_TOAST_TAG).toBe('sess-1')
    expect(world.get(`${DIR}/live/sess-1.notified`)).toBe(String(T0 + H))

    await clock.advance(10_000)
    await clock.settle()

    expect(world.toasts.length, 'not again for the same expiry').toBe(1)
  })

  test('not when notifications are off', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 56 * M })

    world.put(`${DIR}/config.json`, JSON.stringify({ notify: false }))
    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.advance(3000)
    await clock.settle()

    expect([world.toasts, world.processes]).toEqual([[], []])
  })

  test('not twice when the status line already sent it', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 56 * M })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    world.put(`${DIR}/live/sess-1.notified`, String(T0 + H))
    await $.session.start(SESSION as never)
    await clock.advance(3000)
    await clock.settle()

    expect(world.processes).toEqual([])
  })
})

describe('the platform', () => {
  /**
   * A session bound under the home it took, then in its warning window, its snapshot where the status
   * line puts it. The engine hands a handler native paths: on a Windows host a POSIX one gains a drive.
   */
  async function warned($: any, on: any, env: Record<string, string | undefined>) {
    const world = worldOf(on, { env })
    const clock = mock.clock(on, { now: T0 + 54 * M + 58_000 })

    await $.session.start(SESSION as never)
    await clock.settle()

    const beat = [...world.files.keys()].find(path => path.endsWith('/live/sess-1.module')) ?? ''
    const dir = beat.slice(0, -'/live/sess-1.module'.length)

    world.put(`${dir}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await clock.advance(3000)
    await clock.settle()

    return { world, dir }
  }

  const posix = (path: string) => path.replace(/^[A-Za-z]:/, '')

  test('Linux, or WSL with a Windows USERPROFILE carried in: the files are under HOME, as the status line has them, and notify-send', async ($, on) => {
    const { world, dir } = await warned($, on, { OS: undefined, HOME: '/home/t' })

    expect(posix(dir), 'not under the Windows profile').toBe('/home/t/.claude/cache-keeper')
    expect(world.processes).toEqual([['notify-send', '--app-name=Claude Code', 'Cache goes cold in 5 min · my-project', world.processes[0]?.[3] ?? '?']])
  })

  test('macOS: HOME under /Users, and osascript', async ($, on) => {
    const { world, dir } = await warned($, on, { OS: undefined, USERPROFILE: undefined, HOME: '/Users/mac' })

    expect(posix(dir)).toBe('/Users/mac/.claude/cache-keeper')
    expect(world.processes[0]?.[0]).toBe('osascript')
  })

  test('Windows: USERPROFILE over HOME, and the toast', async ($, on) => {
    const { world, dir } = await warned($, on, { HOME: '/c/Users/other' })

    expect(dir).toBe(DIR)
    expect(world.processes[0]?.[0]).toBe('powershell.exe')
  })
})

describe('Handoff & Clear', () => {
  const BRIEF = '## Goal\nShip Cache Keeper.\n## Next steps\n1. Field-test the strip.'
  const ANSWER = { isAnswered: true, text: `Here it is.\n<handoff>\n${BRIEF}\n</handoff>`, usage: {} }

  async function press($: any) {
    await $.ui.render(BAND as never)
    await $.ui.press({ plugin: PLUGIN, key: 'handoff' } as never)
  }

  test('one press: the brief comes from a fork, the session is cleared, and the brief lands in the fresh prompt', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 30 * M })

    world.forkAnswer = ANSWER
    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()
    await press($)

    expect(world.forks.length).toBe(1)
    expect(world.forks[0]!.startsWith(core.HANDOFF_MARK)).toBe(true)
    expect(world.submits, 'a fork, not a turn: nothing is added to the transcript').toEqual([])

    await clock.advance(100)

    expect(world.ran).toEqual(['clear'])

    await clock.advance(200)

    expect(world.fills.length).toBe(1)
    expect(world.fills[0]).toContain('Continue from this handoff brief, written by my previous session (my-project')
    expect(world.fills[0]).toContain(BRIEF)

    const saved = [...world.files.keys()].filter(path => path.startsWith(`${DIR}/handoffs/`))

    expect(saved.length).toBe(1)
    expect(world.get(saved[0]!)).toBe(`${BRIEF}\n`)
    expect(textOf(await $.ui.render(BAND as never)), 'back to the button').toContain('[Handoff & Clear]')
  })

  test('while it waits for /clear the button says so', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = ANSWER
    await $.session.start(SESSION as never)
    await clock.settle()
    await press($)

    expect(textOf(await $.ui.render(BAND as never))).toContain('[Handoff: clearing…]')
  })

  test('a draft in the prompt box survives, after the brief', async ($, on) => {
    const world = worldOf(on, { draft: 'and then fix the bug' })
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = ANSWER
    await $.session.start(SESSION as never)
    await clock.settle()
    await press($)
    await clock.advance(400)

    expect(world.fills[0]!.endsWith('\nand then fix the bug')).toBe(true)
  })

  test('"brief send" submits the brief instead of pasting it', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = ANSWER
    world.put(`${DIR}/config.json`, JSON.stringify({ brief: 'send' }))
    await $.session.start(SESSION as never)
    await clock.settle()
    await press($)
    await clock.advance(400)

    expect(world.fills).toEqual([])
    expect(world.submits.length).toBe(1)
    expect(world.submits[0]).toContain(BRIEF)
  })

  test('pressed while Claude works, it queues and runs when the turn ends', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = ANSWER
    await $.session.start(SESSION as never)
    await clock.settle()
    await $.turn.start({ text: 'refactor it', turnId: 't1' } as never)
    await $.ui.render({ ...BAND, props: { ...BAND.props, isWorking: true } } as never)
    await $.ui.press({ plugin: PLUGIN, key: 'handoff' } as never)

    expect(world.forks, 'nothing while the turn runs').toEqual([])
    expect(world.toasts.join(' ')).toContain('queued')
    expect(textOf(await $.ui.render(BAND as never))).toContain('[Handoff: queued…]')

    await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', answer: 'sub' } as never)
    await clock.advance(100)

    expect(world.forks, "a subagent's turn ending is not Claude's").toEqual([])

    await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
    await clock.advance(50)

    expect(world.forks.length).toBe(1)

    await clock.advance(400)

    expect(world.ran).toEqual(['clear'])
    expect(world.fills[0]).toContain(BRIEF)
  })

  test('a reply without a brief clears nothing', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = { isAnswered: true, text: 'Sorry, no.', usage: {} }
    await $.session.start(SESSION as never)
    await clock.settle()
    await press($)
    await clock.advance(1000)

    expect(world.ran).toEqual([])
    expect(world.toasts.join(' ')).toContain('the reply held no brief. Nothing was cleared.')
  })

  test('a fork with nothing to fork, or refused, clears nothing and says why', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION as never)
    await clock.settle()

    world.forkAnswer = { isAnswered: false, reason: 'nothing-to-fork', usage: {} }
    await press($)
    world.forkAnswer = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: {} }
    await press($)
    await clock.advance(1000)

    expect(world.ran).toEqual([])
    expect(world.toasts.join(' | ')).toContain('nothing to hand off yet')
    expect(world.toasts.join(' | ')).toContain('the API refused the request (HTTP 529)')
  })

  test('/cache-keeper handoff does the same from the keyboard', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = ANSWER
    await $.session.start(SESSION as never)
    await clock.settle()

    const reply = await $.command.run(command('cache-keeper', 'handoff') as never)

    expect((reply as { text?: string }).text).toContain('asking Claude for the brief')

    await clock.advance(20)

    expect(world.forks.length).toBe(1)

    await clock.advance(400)

    expect(world.ran).toEqual(['clear'])
  })

  test('a second press while one runs does not start another', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.forkAnswer = ANSWER
    await $.session.start(SESSION as never)
    await clock.settle()
    await press($)
    await press($)
    await clock.advance(400)

    expect([world.forks.length, world.ran.length, world.fills.length]).toEqual([1, 1, 1])
  })
})

describe('once the cache is cold', () => {
  const ROOT = 'C:/Users/t/.claude'
  const GUARD = `${ROOT}/handoff-guard/live/sess-1.json`
  const TOOL = `${ROOT}/tools/account-sync/acct-sync.mjs`
  const HANDOFF = `${ROOT}/handoffs/my-project/2026-10-28-1130-ship-the-strip.md`
  const PACK = `${ROOT}/handoffs/my-project/acct/2026-10-28-1302-clear-sess-1.md`
  const TRANSCRIPT = `${ROOT}/projects/C--work/sess-1.jsonl`
  const EXPORT = `${DIR}/exports/sess-1.json`
  /** Two minutes past the cache's expiry: the last request was at T0, the TTL an hour. */
  const COLD = T0 + H + 2 * M
  const shown = (path: string) => path.replace(/\//g, '\\')
  /** A path in a command's reply: in a code span, which Claude Code's Markdown leaves as it is. */
  const inReply = (path: string) => `\`${shown(path)}\``

  /** handoff-guard's record of sess-1: its newest handoff is current unless a test says otherwise. */
  const guard = (track: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      sid: 'sess-1',
      cwd: '/work',
      role: null,
      startedAt: T0 - 2 * H,
      updatedAt: T0 - 30 * M,
      upToDate: true,
      track: { workAt: T0 - 40 * M, handoffAt: T0 - 30 * M, handoffPath: HANDOFF, turnsAfter: 0, ...track },
      busy: false,
      pending: null,
      request: null,
      lastTurnAt: T0 - 30 * M,
      endedAt: null,
      endReason: null,
      ...extra,
    })

  /** acct-sync as it answers `handoff <ref> --kind clear --json`: a pack for `known`, no session for anything else. */
  const acctSync = (known: string[]) => (argv: string[]): Run => {
    if (argv[1] !== TOOL) return { exitCode: 0, stdout: '', stderr: '' }

    return known.includes(argv[3]!) ? { exitCode: 0, stdout: JSON.stringify({ pack: PACK, tokens: 9000 }), stderr: '' } : { exitCode: 1, stdout: '', stderr: `acct-sync: no session matches ${argv[3]}` }
  }

  /** A cold session; `transcript` is what the status line names, saved or not. `now`: when the module binds (COLD unless said). */
  async function coldSession(
    $: any,
    on: any,
    opts: { env?: Record<string, string>; draft?: string; transcript?: 'saved' | 'missing' | 'unnamed'; record?: string | null; files?: Record<string, string>; hasTool?: boolean; now?: number } = {},
  ) {
    const world = worldOf(on, { env: opts.env, draft: opts.draft })
    const clock = mock.clock(on, { now: opts.now ?? COLD })

    // The session usage counts what the status line counts, of the same last request.
    world.usageTokens = 400_000
    const named = opts.transcript === undefined || opts.transcript === 'unnamed' ? {} : { transcript_path: TRANSCRIPT }

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0, undefined, named)))

    if (opts.transcript === 'saved') world.put(TRANSCRIPT, '{"type":"user"}\n')
    if (opts.record !== null) world.put(GUARD, opts.record ?? guard())

    world.put(HANDOFF, '# Handoff: ship Cache Keeper\n\n## Next steps\n1. Field-test the strip.\n')

    if (opts.hasTool !== false) world.put(TOOL, '// acct-sync')

    for (const [path, text] of Object.entries(opts.files ?? {})) world.put(path, text)

    await $.session.start(SESSION as never)
    await clock.settle()

    return { world, clock }
  }

  async function press($: any, clock: any, key: string) {
    await $.ui.render(BAND as never)
    await $.ui.press({ plugin: PLUGIN, key } as never)
    await clock.settle()
  }

  test('the strip offers Use Latest Handoff and Pack & Clear in place of Handoff & Clear', async ($, on) => {
    await coldSession($, on)

    const text = textOf(await $.ui.render(BAND as never))

    expect(text).toContain('[Use Latest Handoff]')
    expect(text).toContain('[Pack & Clear]')
    expect(text).not.toContain('[Handoff & Clear]')

    for (const bodyColumns of [24, 48, 80, 120]) {
      expect(await accepted($, { ...BAND, props: { ...BAND.props, bodyColumns } })).toBe('terminal')
    }
  })

  test('work after the handoff leaves Pack & Clear alone, until the record says the handoff is current again', async ($, on) => {
    const { world, clock } = await coldSession($, on, { record: guard({ turnsAfter: 3 }, { upToDate: false }) })

    expect(textOf(await $.ui.render(BAND as never))).not.toContain('[Use Latest Handoff]')
    expect(textOf(await $.ui.render(BAND as never))).toContain('[Pack & Clear]')

    world.put(GUARD, guard())
    await clock.advance(2000)
    await clock.settle()

    expect(textOf(await $.ui.render(BAND as never)), 'the record is read again when it changes').toContain('[Use Latest Handoff]')
  })

  test('no record of the session: Pack & Clear alone', async ($, on) => {
    await coldSession($, on, { record: null })

    const text = textOf(await $.ui.render(BAND as never))

    expect([text.includes('[Use Latest Handoff]'), text.includes('[Pack & Clear]')]).toEqual([false, true])
  })

  test('warm, Handoff & Clear alone, whatever the record says', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 30 * M })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    world.put(GUARD, guard())
    world.put(HANDOFF, '# Handoff\n')
    await $.session.start(SESSION as never)
    await clock.settle()

    const text = textOf(await $.ui.render(BAND as never))

    expect(text).toContain('[Handoff & Clear]')
    expect(text).not.toContain('[Pack & Clear]')
  })

  test('a hub worker keeps Handoff & Clear, and the commands say why they stay out', async ($, on) => {
    const { world } = await coldSession($, on, { env: { HUB_WORKER: '1' } })

    expect(textOf(await $.ui.render(BAND as never))).toContain('[Handoff & Clear]')

    const reply = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }

    expect(reply.text).toContain('Pack & Clear stays out of a hub worker')
    expect(world.processes).toEqual([])
  })

  test('Use Latest Handoff: cleared, and the fresh prompt points at the handoff, with no model call and no acct-sync', async ($, on) => {
    const { world, clock } = await coldSession($, on)

    await press($, clock, 'latest')

    expect(textOf(await $.ui.render(BAND as never))).toContain('[Handoff: clearing…]')

    await clock.advance(100)

    expect(world.ran).toEqual(['clear'])

    await clock.advance(200)

    expect(world.fills.length).toBe(1)
    expect(world.fills[0]!.startsWith('Continue from this handoff brief, written by my previous session (my-project) at 2026-10-28 11:30 UTC')).toBe(true)
    expect(world.fills[0]).toContain(`Read ${HANDOFF} in full first`)
    expect(world.toasts.join(' | ')).toContain(`Use Latest Handoff: fresh session; the pointer to the handoff is in the prompt, press Enter to send it. Handoff: ${shown(HANDOFF)}`)
    expect([world.forks, world.processes, world.submits]).toEqual([[], [], []])
    expect(textOf(await $.ui.render(BAND as never)), 'the fresh session is not cold').toContain('[Handoff & Clear]')
  })

  test("a hub's own handoff: the fresh prompt gets /hub resume <id>", async ($, on) => {
    const hub = `${ROOT}/hub/h1/hub-handoff.md`
    const { world, clock } = await coldSession($, on, { record: guard({ handoffPath: hub }), files: { [hub]: '# Hub h1\n' } })

    await press($, clock, 'latest')
    await clock.advance(300)

    expect(world.fills).toEqual(['/hub resume h1\n'])
    expect(world.toasts.join(' | ')).toContain('`/hub resume h1` is in the prompt')
  })

  test('a command is not pasted over a draft: the draft stays, and the toast says what to send', async ($, on) => {
    const hub = `${ROOT}/hub/h1/hub-handoff.md`
    const { world, clock } = await coldSession($, on, { draft: 'and then fix the bug', record: guard({ handoffPath: hub }), files: { [hub]: '# Hub h1\n' } })

    await press($, clock, 'latest')
    await clock.advance(300)

    expect([world.ran, world.fills]).toEqual([['clear'], []])
    expect(world.toasts.join(' | ')).toContain('Your draft stays in the prompt; send `/hub resume h1` after it.')
  })

  test('a side note in the handoffs folder is not a handoff: only its first line could say it is', async ($, on) => {
    const note = `${ROOT}/handoffs/my-project/draft-12.md`

    await coldSession($, on, { record: guard({ handoffPath: note }), files: { [note]: '## Summary\nThe handoff of the PR is below.\n' } })

    const text = textOf(await $.ui.render(BAND as never))
    const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

    expect([text.includes('[Use Latest Handoff]'), text.includes('[Pack & Clear]')]).toEqual([false, true])
    expect(status.text).toContain(`latest handoff: none to go on from (the newest file it wrote among the handoffs, ${inReply(note)}, is not a handoff)`)
  })

  test('a file named neither for its time nor "handoff" counts when its first line says so', async ($, on) => {
    const named = `${ROOT}/handoffs/my-project/strip-notes.md`

    await coldSession($, on, { record: guard({ handoffPath: named }), files: { [named]: '# Session handoff: Cache Keeper\n' } })

    expect(textOf(await $.ui.render(BAND as never))).toContain('[Use Latest Handoff]')
  })

  test('the handoff gone by the time of the press: nothing is cleared, and the toast says why', async ($, on) => {
    const { world, clock } = await coldSession($, on)

    await $.ui.render(BAND as never)
    world.files.delete(HANDOFF)
    await press($, clock, 'latest')
    await clock.advance(1000)

    expect(world.ran).toEqual([])
    expect(world.toasts.join(' | ')).toContain(`Use Latest Handoff stopped: there is no current handoff to go on from: its handoff ${shown(HANDOFF)} is gone. Nothing was cleared.`)
  })

  test('/use-latest-handoff with work after the handoff stops, and says why', async ($, on) => {
    const { world, clock } = await coldSession($, on, { record: guard({ turnsAfter: 3 }, { upToDate: false }) })
    const reply = (await $.command.run(command('use-latest-handoff') as never)) as { text?: string }

    expect(reply.text).toBe('Use Latest Handoff: checking that the handoff is current; the session clears once it is.')

    await clock.advance(1000)

    expect(world.ran).toEqual([])
    expect(world.toasts.join(' | ')).toContain('the session did more work after its last handoff (3 turns since 2026-10-28-1130-ship-the-strip.md). Nothing was cleared.')
  })

  test('Pack & Clear: acct-sync builds the pack from the transcript, then the session clears and the prompt points at it', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'saved' })

    world.runs = acctSync(['sess-1'])
    await press($, clock, 'pack')

    expect(world.processes).toEqual([core.packArgv(TOOL, 'sess-1')])

    await clock.advance(100)

    expect(world.ran).toEqual(['clear'])

    await clock.advance(200)

    expect(world.fills.length).toBe(1)
    expect(world.fills[0]!.startsWith('Continue from this handoff brief: a pack acct-sync built, without a model call, from my previous session (my-project, cleared at 2026-10-28 13:02 UTC')).toBe(true)
    expect(world.fills[0]).toContain(`Read ${PACK} in full first`)
    expect(world.toasts.join(' | ')).toContain(`Pack & Clear: fresh session; the pointer to the pack is in the prompt, press Enter to send it. Pack: ${shown(PACK)}`)
    expect([world.forks, world.get(EXPORT)]).toEqual([[], undefined])
  })

  test('while acct-sync builds the pack the button says so', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'saved' })
    let finish = (run: Run) => {}

    world.runs = () => new Promise<Run>(resolve => (finish = resolve))
    await press($, clock, 'pack')

    expect(textOf(await $.ui.render(BAND as never))).toContain('[Pack: building the pack…]')

    const again = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }
    const other = (await $.command.run(command('use-latest-handoff') as never)) as { text?: string }

    expect(again.text).toBe('Pack & Clear is already building the pack.')
    expect(other.text).toBe('Use Latest Handoff did not start: Pack & Clear is already building the pack.')

    finish({ exitCode: 0, stdout: JSON.stringify({ pack: PACK, tokens: 1 }), stderr: '' })
    await clock.settle()
    await clock.advance(300)

    expect([world.processes.length, world.ran, world.fills.length]).toEqual([1, ['clear'], 1])
  })

  test('no transcript saved: the conversation the engine holds is exported, and acct-sync builds the pack from that', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'missing', env: { CLAUDE_CODE_CHILD_SESSION: '1' } })

    world.messages = [
      { role: 'user', content: 'Ship the strip.' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'Shipped.' }] },
    ]
    world.runs = acctSync([EXPORT])
    await press($, clock, 'pack')

    expect(world.processes, 'not by id first: the transcript the status line names is not there').toEqual([core.packArgv(TOOL, EXPORT)])

    const exported = JSON.parse(world.get(EXPORT)!)

    expect([exported.kind, exported.sessionId, exported.cwd, exported.configDir, exported.startedAt, exported.model, exported.title]).toEqual([
      'cache-keeper engine export',
      'sess-1',
      '/work',
      ROOT,
      T0,
      'claude-opus-5-5',
      'my-project',
    ])
    expect(exported.why).toContain('CLAUDE_CODE_CHILD_SESSION')
    expect(exported.handoffs).toEqual([{ path: HANDOFF, at: T0 - 30 * M, turnsAfter: 0 }])
    expect(exported.messages).toEqual([
      { role: 'user', content: 'Ship the strip.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }] },
    ])

    await clock.advance(300)

    expect(world.ran).toEqual(['clear'])
    expect(world.fills[0]).toContain(`Read ${PACK} in full first`)
  })

  test('acct-sync knows no such session: the export is the way', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'unnamed' })

    world.messages = [{ role: 'user', content: 'Ship the strip.' }]
    world.runs = acctSync([EXPORT])
    await press($, clock, 'pack')
    await clock.advance(300)

    expect(world.processes).toEqual([core.packArgv(TOOL, 'sess-1'), core.packArgv(TOOL, EXPORT)])
    expect(JSON.parse(world.get(EXPORT)!).why, 'nothing says why no transcript was saved').toBe(null)
    expect(world.ran).toEqual(['clear'])
  })

  test('no transcript and no conversation in the engine either: nothing is cleared', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'missing' })

    world.runs = acctSync([EXPORT])
    await press($, clock, 'pack')
    await clock.advance(1000)

    expect([world.ran, world.processes]).toEqual([[], []])
    expect(world.toasts.join(' | ')).toContain('Pack & Clear stopped: this session saved no transcript, and the engine holds no conversation to export. Nothing was cleared.')
  })

  test('acct-sync not installed: nothing is cleared, and the toast says where it looked', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'saved' })

    world.files.delete(TOOL)
    await press($, clock, 'pack')
    await clock.advance(1000)

    expect([world.ran, world.processes]).toEqual([[], []])
    expect(world.toasts.join(' | ')).toContain(`Pack & Clear stopped: it needs acct-sync, which is not at ${shown(TOOL)}. Nothing was cleared.`)
  })

  test('acct-sync fails: nothing is cleared, and the toast carries what it said', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'saved' })

    world.runs = () => ({ exitCode: 1, stdout: '', stderr: 'acct-sync: the transcript could not be read' })
    await press($, clock, 'pack')
    await clock.advance(1000)

    expect(world.ran).toEqual([])
    expect(world.toasts.join(' | ')).toContain('Pack & Clear stopped: the transcript could not be read. Nothing was cleared.')
  })

  test('/pack-and-clear from the keyboard runs once the turn the engine starts for the command has ended', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'saved' })

    world.runs = acctSync(['sess-1'])

    const reply = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }

    expect(reply.text).toBe('Pack & Clear: acct-sync is building the pack (no model call); the session clears when it is written.')

    // As the engine does: Claude shows as working for a moment after a typed command has answered.
    await $.turn.start({ text: '/pack-and-clear', turnId: 'c1' } as never)
    await clock.advance(5000)

    expect(world.processes, 'not while that turn runs, however long').toEqual([])
    expect(world.toasts.join(' | '), 'and no refusal either').not.toContain('working')
    expect(textOf(await $.ui.render({ ...BAND, props: { ...BAND.props, isWorking: true } } as never))).toContain('[Pack: queued…]')

    await $.turn.complete({ turnId: 'c1', answer: '' } as never)
    await clock.advance(50)

    expect(world.processes.length).toBe(1)

    await clock.advance(300)

    expect([world.processes.length, world.ran, world.fills.length]).toEqual([1, ['clear'], 1])
  })

  test('/use-latest-handoff with no turn after it runs once the prompt has shown Claude idle for a second', async ($, on) => {
    const { world, clock } = await coldSession($, on)
    const reply = (await $.command.run(command('use-latest-handoff') as never)) as { text?: string }

    expect(reply.text).toBe('Use Latest Handoff: checking that the handoff is current; the session clears once it is.')

    // The prompt shows Claude working while the engine finishes the command, with no turn reported.
    await $.ui.render({ ...BAND, props: { ...BAND.props, isWorking: true } } as never)
    await clock.advance(2010)

    expect(world.ran, 'not while the prompt says Claude works').toEqual([])

    await $.ui.render(BAND as never)
    await clock.advance(1500)

    expect(world.ran).toEqual(['clear'])
    expect(world.fills[0]).toContain(`Read ${HANDOFF} in full first`)
  })

  test('/cache-keeper latest does what the button does', async ($, on) => {
    const { world, clock } = await coldSession($, on)
    const reply = (await $.command.run(command('cache-keeper', 'latest') as never)) as { text?: string }

    expect(reply.text).toContain('Use Latest Handoff: checking')

    await clock.advance(1000)
    await clock.advance(400)

    expect(world.ran).toEqual(['clear'])
    expect(world.fills[0]).toContain(`Read ${HANDOFF} in full first`)
  })

  test('typed while Claude works, a command queues behind the turn, and a second one says what is queued', async ($, on) => {
    const { world, clock } = await coldSession($, on, { transcript: 'saved' })

    world.runs = acctSync(['sess-1'])
    await $.turn.start({ text: 'go on', turnId: 't1' } as never)

    const pack = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }
    const latest = (await $.command.run(command('use-latest-handoff') as never)) as { text?: string }

    await clock.advance(5000)

    expect(pack.text).toBe('Pack & Clear: it runs once Claude is idle (after the turn, if one is running); acct-sync then builds the pack (no model call) and the session clears.')
    expect(latest.text).toBe('Use Latest Handoff did not start: Pack & Clear is already queued.')
    expect([world.processes, world.ran], 'nothing while the turn runs').toEqual([[], []])

    await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
    await clock.advance(400)

    expect([world.processes.length, world.ran, world.fills.length]).toEqual([1, ['clear'], 1])
  })

  test('pressed while Claude works, a cold-cache button queues, and runs once when the turn ends', async ($, on) => {
    const { world, clock } = await coldSession($, on)

    await $.turn.start({ text: 'go on', turnId: 't1' } as never)
    await $.ui.render({ ...BAND, props: { ...BAND.props, isWorking: true } } as never)
    await $.ui.press({ plugin: PLUGIN, key: 'latest' } as never)
    await clock.advance(3000)

    expect(world.ran).toEqual([])
    expect(world.toasts.join(' | ')).toContain('Use Latest Handoff is queued: it runs as soon as Claude finishes this turn.')
    expect(textOf(await $.ui.render({ ...BAND, props: { ...BAND.props, isWorking: true } } as never))).toContain('[Handoff: queued…]')

    await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', answer: 'sub' } as never)
    await clock.advance(1500)

    expect(world.ran, "a subagent's turn ending is not Claude's").toEqual([])

    await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
    await clock.advance(1500)

    expect(world.ran, 'once: the turn ending and the tick do not both run it').toEqual(['clear'])
    expect(world.fills.length).toBe(1)
  })

  test('the status says what the cold-cache ways have to go on', async ($, on) => {
    await coldSession($, on, { transcript: 'missing', env: { CLAUDE_CODE_CHILD_SESSION: '1' } })

    const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

    expect(status.text).toContain('once cold: Use Latest Handoff and Pack & Clear in place of Handoff & Clear')
    expect(status.text).toContain(`latest handoff: ${inReply(HANDOFF)}, written`)
    expect(status.text).toContain(`pack: acct-sync at ${inReply(TOOL)}; transcript NOT saved (CLAUDE_CODE_CHILD_SESSION is set): a pack is built from what the engine holds`)
  })

  test('acct-sync not installed: the cold strip offers Handoff & Clear in its place, and /pack-and-clear says why', async ($, on) => {
    const { world } = await coldSession($, on, { hasTool: false })
    const text = textOf(await $.ui.render(BAND as never))
    const why = `Pack & Clear needs acct-sync, which is not installed here (looked for ${inReply(TOOL)}). Use Latest Handoff (/use-latest-handoff) goes on from a current handoff with no model call, and Handoff & Clear (/cache-keeper handoff) asks Claude for a brief.`

    expect([text.includes('[Use Latest Handoff]'), text.includes('[Handoff & Clear]'), text.includes('[Pack & Clear]')]).toEqual([true, true, false])
    expect(((await $.command.run(command('pack-and-clear') as never)) as { text?: string }).text).toBe(why)
    expect(((await $.command.run(command('cache-keeper', 'pack') as never)) as { text?: string }).text).toBe(why)
    expect(world.processes).toEqual([])

    const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

    expect(status.text).toContain('once cold: Use Latest Handoff, and Handoff & Clear (no Pack & Clear: acct-sync is not installed)')
  })

  test('acct-sync installed later: /pack-and-clear looks again, and runs', async ($, on) => {
    const { world, clock } = await coldSession($, on, { hasTool: false, transcript: 'saved' })

    world.put(TOOL, '// acct-sync')
    world.runs = acctSync(['sess-1'])

    const reply = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }

    expect(reply.text).toBe('Pack & Clear: acct-sync is building the pack (no model call); the session clears when it is written.')

    await clock.advance(1000)
    await clock.advance(400)

    expect([world.processes.length, world.ran]).toEqual([1, ['clear']])
  })

  // ------------------------------------------------- the cold-send guard

  const HELD = `${DIR}/live/sess-1.held.json`
  /** The conversation so far, as the engine holds it: Claude has answered, so a message re-reads all of it. */
  const TALK = [
    { role: 'user', content: 'Ship the strip.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Shipped. Shall I tag the release?' }] },
  ]
  /** What the person typed, as the engine raises it: their own Enter, the session idle. */
  const typed = (text: string, extra: Record<string, unknown> = {}) => ({ text, wait: false, origin: { kind: 'composer' }, ...extra })
  const heldFile = (world: { get: (path: string) => string | undefined }) => JSON.parse(world.get(HELD) ?? 'null')
  const WAYS = 'Use Latest Handoff (/use-latest-handoff) or Pack & Clear (/pack-and-clear) carries it to a fresh session instead.'
  const COST = 'the prompt cache is cold, so sending it would read 400k tokens again uncached (next msg $3.20). It is back in the prompt: Enter sends it anyway.'
  const PACKED = 'Continue from this handoff brief: a pack acct-sync built, without a model call, from my previous session (my-project, cleared at 2026-10-28 13:02 UTC'
  const LATEST = 'Continue from this handoff brief, written by my previous session (my-project) at 2026-10-28 11:30 UTC'

  /** A cold session of 400k tokens that Claude has answered, its transcript saved and acct-sync at hand. */
  async function answered($: any, on: any, opts: Parameters<typeof coldSession>[2] = {}) {
    const session = await coldSession($, on, { transcript: 'saved', ...opts })

    session.world.messages = TALK
    session.world.runs = acctSync(['sess-1'])

    return session
  }

  describe('the cold-send guard', () => {
    test('a message typed into a big cold session is held: what sending would cost, the ways on, and back in the prompt', async ($, on) => {
      const { world, clock } = await answered($, on)
      const sent = await $.prompt.submit(typed('Yes, tag it.') as never)

      expect(sent).toEqual({ drop: `Cache Keeper held this message: ${COST} ${WAYS}` })
      expect([world.submits, world.forks, world.processes], 'no request, and nothing run').toEqual([[], [], []])

      const held = heldFile(world)

      expect([held.v, held.sid, held.kind, held.text, held.attachments]).toEqual([1, 'sess-1', 'prompt', 'Yes, tag it.', 0])
      expect(world.fills, 'not while the engine is still done with the submission').toEqual([])

      await clock.advance(100)

      expect(world.fills).toEqual(['Yes, tag it.'])
      expect(textOf(await $.ui.render(BAND as never))).toContain('message held')

      const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

      expect(status.text).toContain('cold-send guard: holds a message typed into a cold session that would re-read 150k tokens or more')
      expect(status.text).toContain('  held: a message, since')
      expect(status.text).toContain(': "Yes, tag it." (Enter on it sends it; a cold-cache way carries it)')
      expect(status.text).toContain('hold 150k tokens')
    })

    test('Enter again on the held text sends it, once; a different text is held in its place', async ($, on) => {
      const { world, clock } = await answered($, on)

      await $.prompt.submit(typed('Yes, tag it.') as never)
      await clock.advance(100)

      expect(await $.prompt.submit(typed('Yes, tag it. ') as never), 'the box hands it back as it was put there').toEqual({ text: 'Yes, tag it. ' })
      expect(world.submits).toEqual(['Yes, tag it. '])
      expect(heldFile(world)?.text, 'spent: no text in the file').toBe(undefined)
      expect(heldFile(world)?.used, 'a used record').toBeDefined()
      expect(textOf(await $.ui.render(BAND as never))).not.toContain('message held')

      // The world's status line never moves: still cold, so the next message is held as the first was.
      const other = (await $.prompt.submit(typed('And bump the version.') as never)) as { drop?: string }
      const replaced = (await $.prompt.submit(typed('No, bump it to 2.0.') as never)) as { drop?: string }

      expect([other.drop !== undefined, replaced.drop !== undefined]).toEqual([true, true])
      expect(heldFile(world)?.text, 'the newest text is the one held').toBe('No, bump it to 2.0.')
      expect(world.submits.length).toBe(1)
    })

    test('Enter again knows the held text as the box hands it back: marks drawn as nothing, a letter composed another way', async ($, on) => {
      const { world, clock } = await answered($, on)
      // Typed with the e-acute as one code point.
      const held = 'Caf\u00E9, tag it.'
      // Handed back with each mark the comparison drops (zero-width space, non-joiner, joiner, word joiner, BOM) and
      // the e-acute as an e and a combining accent.
      const back = '\u200BCa\uFEFFfe\u0301,\u200C tag\u200D it\u2060. '

      await $.prompt.submit(typed(held) as never)
      await clock.advance(100)

      expect(await $.prompt.submit(typed(back) as never), 'the same text: sent as it came').toEqual({ text: back })
      expect(world.submits).toEqual([back])
      expect(heldFile(world)?.text, 'spent').toBe(undefined)
    })

    test("not held: a command, a meta prompt, one typed over a running turn, a shell line, nor one that is not the person's", async ($, on) => {
      const { world } = await answered($, on)

      await $.turn.start({ text: 'Tag it.', turnId: 't1' } as never)

      const passed = [
        typed('/compact', { command: { name: 'compact', args: '' } }),
        typed('Read the plan first.', { isMeta: true }),
        typed('also run the tests', { turnId: 't1' }),
        typed('!git status'),
        typed('The build finished.', { origin: { kind: 'task-notification' } }),
        typed('From the other session.', { origin: { kind: 'peer' } }),
      ]

      for (const input of passed) {
        expect(await $.prompt.submit(input as never), JSON.stringify(input)).toEqual({ text: input.text })
      }

      expect(world.submits.length).toBe(passed.length)
      expect(world.get(HELD)).toBe(undefined)
    })

    test('not held: a warm cache', async ($, on) => {
      const world = worldOf(on)
      const clock = mock.clock(on, { now: T0 + 30 * M })

      world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
      world.messages = TALK
      await $.session.start(SESSION as never)
      await clock.settle()

      expect(await $.prompt.submit(typed('Yes, tag it.') as never)).toEqual({ text: 'Yes, tag it.' })
      expect(world.get(HELD)).toBe(undefined)
    })

    test('/cache-keeper hold sets the threshold: a smaller re-read goes as typed, and off holds nothing', async ($, on) => {
      const { world } = await answered($, on)
      const set = (await $.command.run(command('cache-keeper', 'hold 500k') as never)) as { text?: string }

      expect(set.text).toBe('Cache Keeper: Cold-send guard: a message typed into a cold session is held when it would re-read 500k tokens or more')
      expect(JSON.parse(world.get(`${DIR}/config.json`)!).holdColdAt).toBe(500_000)
      expect(await $.prompt.submit(typed('Yes, tag it.') as never), '400k is under 500k').toEqual({ text: 'Yes, tag it.' })

      await $.command.run(command('cache-keeper', 'hold 300000') as never)

      expect(((await $.prompt.submit(typed('Now tag it.') as never)) as { drop?: string }).drop).toBeDefined()

      const off = (await $.command.run(command('cache-keeper', 'hold off') as never)) as { text?: string }

      expect(off.text).toBe('Cache Keeper: Cold-send guard: off; a message to a cold cache is sent as typed')
      expect(await $.prompt.submit(typed('And bump the version.') as never)).toEqual({ text: 'And bump the version.' })
      expect(world.submits).toEqual(['Yes, tag it.', 'And bump the version.'])
      expect(heldFile(world)?.text, 'a message of the person went in: what was held is spent').toBe(undefined)
      expect(((await $.command.run(command('cache-keeper') as never)) as { text?: string }).text).toContain('cold-send guard: off')
    })

    test('not held in a hub worker', async ($, on) => {
      const { world } = await answered($, on, { env: { HUB_WORKER: '1' } })

      expect(await $.prompt.submit(typed('Yes, tag it.') as never)).toEqual({ text: 'Yes, tag it.' })
      expect(world.get(HELD)).toBe(undefined)
    })

    test("the conversation's first message is never held: one Claude has not answered, and the first after a /clear", async ($, on) => {
      const { world, clock } = await answered($, on, { files: { [`${DIR}/live/sess-2.json`]: JSON.stringify(snapshotFor('sess-2', T0)) } })

      world.messages = [{ role: 'user', content: 'Ship the strip.' }]

      expect(await $.prompt.submit(typed('Are you there?') as never), 'nothing to re-read yet').toEqual({ text: 'Are you there?' })

      // A /clear: the new conversation is as cold and as big by its status line, and its first message goes.
      world.messages = TALK
      await $.command.run(command('clear') as never)
      await clock.advance(2000)

      expect(textOf(await $.ui.render(BAND as never))).toContain('cache cold')
      expect(await $.prompt.submit(typed('Continue from the pack.') as never)).toEqual({ text: 'Continue from the pack.' })
      expect(((await $.prompt.submit(typed('And then?') as never)) as { drop?: string }).drop, 'the second one is held').toBeDefined()
      expect(JSON.parse(world.get(`${DIR}/live/sess-2.held.json`)!).text).toBe('And then?')
    })

    test('a message with an image is held all the same, and the reason says the image is not kept', async ($, on) => {
      const { world } = await answered($, on)
      const sent = (await $.prompt.submit(typed('What is wrong in [Image #1]?', { attachments: [{ type: 'image', mediaType: 'image/png' }] }) as never)) as { drop?: string }

      expect(sent.drop).toBe(`Cache Keeper held this message: ${COST} ${WAYS} The image or file attached to it is not kept: attach it again.`)
      expect(heldFile(world)?.attachments).toBe(1)
    })

    test('CACHE_KEEPER_HOLD_COLD_AT and CACHE_KEEPER_ASSUME_COLD: a warm session counts as cold at the override, and config.json is left alone', async ($, on) => {
      const world = worldOf(on, { env: { CACHE_KEEPER_HOLD_COLD_AT: '1000', CACHE_KEEPER_ASSUME_COLD: '1' } })
      const clock = mock.clock(on, { now: T0 + 30 * M })
      const config = JSON.stringify({ holdColdAt: 900_000 })

      world.put(`${DIR}/config.json`, config)
      world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
      world.messages = TALK
      await $.session.start(SESSION as never)
      await clock.settle()

      expect(textOf(await $.ui.render(BAND as never))).toContain('○ cache cold (assumed)')
      expect(((await $.prompt.submit(typed('Yes, tag it.') as never)) as { drop?: string }).drop).toBeDefined()

      const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

      expect(status.text).toContain('cold-send guard: holds a message typed into a cold session that would re-read 1k tokens or more (CACHE_KEEPER_HOLD_COLD_AT; the setting says 900k tokens)')
      expect(status.text).toContain('  CACHE_KEEPER_ASSUME_COLD is set: the cache counts as cold')
      expect(world.get(`${DIR}/config.json`), 'the overrides never write the shared settings').toBe(config)
    })

    test('a module loaded again keeps what was held: the strip shows it, and Enter on it sends it', async ($, on) => {
      const before = { v: 1, sid: 'sess-1', kind: 'prompt', text: 'Yes, tag it.', at: COLD - M, attachments: 0 }
      const { world } = await answered($, on, { files: { [HELD]: JSON.stringify(before) } })

      expect(textOf(await $.ui.render(BAND as never))).toContain('message held')
      expect(await $.prompt.submit(typed('Yes, tag it.') as never)).toEqual({ text: 'Yes, tag it.' })
      expect(world.submits).toEqual(['Yes, tag it.'])
    })

    test("another session's held text, or a used one, is not this session's", async ($, on) => {
      const { world } = await answered($, on, { files: { [HELD]: JSON.stringify({ v: 1, sid: 'sess-9', kind: 'prompt', text: 'Yes, tag it.', at: COLD - M, attachments: 0 }) } })

      expect(textOf(await $.ui.render(BAND as never))).not.toContain('message held')
      expect(((await $.prompt.submit(typed('Yes, tag it.') as never)) as { drop?: string }).drop, 'held here, as any message').toBeDefined()
      expect(world.submits).toEqual([])
    })

    test('Pack & Clear after a hold: the fresh prompt has the pointer, then the held message, once', async ($, on) => {
      const { world, clock } = await answered($, on)

      await $.prompt.submit(typed('Yes, tag it.') as never)
      await clock.advance(100)
      // The box holds it again, as the guard put it back.
      world.draft = 'Yes, tag it.'
      await press($, clock, 'pack')
      await clock.advance(300)

      const fresh = world.fills.at(-1)!

      expect(world.ran).toEqual(['clear'])
      expect(fresh.startsWith(PACKED)).toBe(true)
      expect(fresh.endsWith('\n\nYes, tag it.')).toBe(true)
      expect(fresh.split('Yes, tag it.').length, 'once, though the box held it too').toBe(2)
      expect(world.toasts.join(' | ')).toContain(`Pack & Clear: fresh session; the pointer to the pack and your held message are in the prompt, press Enter to send them. Pack: ${shown(PACK)}`)
      expect(heldFile(world)?.used, 'carried: the old session holds it no more').toBeDefined()
      expect(world.submits, 'nothing sent').toEqual([])
    })

    test('a clear that takes its time: the held message goes along though a tick sees the new session first', async ($, on) => {
      const { world, clock } = await answered($, on)
      let finish = () => {}

      await $.prompt.submit(typed('Yes, tag it.') as never)
      await clock.advance(100)
      world.clearGate = new Promise<void>(resolve => (finish = resolve))
      await press($, clock, 'pack')
      await clock.advance(100)
      // The new session id is out; the module's ticks read it while the clear runs on.
      await clock.advance(3000)

      expect(textOf(await $.ui.render(BAND as never)), 'the new session holds nothing of its own').not.toContain('message held')

      finish()
      await clock.settle()
      await clock.advance(300)

      expect(world.fills.at(-1)!.endsWith('\n\nYes, tag it.')).toBe(true)
    })

    test('/pack-and-clear typed after a hold: the held message comes from the hold, not from the box', async ($, on) => {
      const { world, clock } = await answered($, on)

      await $.prompt.submit(typed('Yes, tag it.') as never)
      await clock.advance(100)

      // The command took the box: it is empty once the command has run.
      const reply = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }

      expect(reply.text).toBe('Pack & Clear: acct-sync is building the pack (no model call); the session clears when it is written.')

      await clock.advance(1000)
      await clock.advance(400)

      const fresh = world.fills.at(-1)!

      expect(world.ran).toEqual(['clear'])
      expect([fresh.startsWith(PACKED), fresh.endsWith('\n\nYes, tag it.')]).toEqual([true, true])
    })

    test('Use Latest Handoff after a hold, pressed or typed: the pointer to the handoff, then the held message', async ($, on) => {
      const { world, clock } = await answered($, on)

      await $.prompt.submit(typed('Yes, tag it.') as never)
      await clock.advance(100)
      await press($, clock, 'latest')
      await clock.advance(300)

      const fresh = world.fills.at(-1)!

      expect(world.ran).toEqual(['clear'])
      expect([fresh.startsWith(LATEST), fresh.includes(`Read ${HANDOFF} in full first`), fresh.endsWith('\n\nYes, tag it.')]).toEqual([true, true, true])
      expect(world.toasts.join(' | ')).toContain('Use Latest Handoff: fresh session; the pointer to the handoff and your held message are in the prompt, press Enter to send them.')
    })

    for (const typedAs of [['use-latest-handoff', ''], ['cache-keeper', 'latest'], ['cache-keeper', 'pack']] as const) {
      test(`/${typedAs.join(' ').trim()} typed after a hold carries the held message`, async ($, on) => {
        const { world, clock } = await answered($, on)

        await $.prompt.submit(typed('Yes, tag it.') as never)
        await clock.advance(100)
        await $.command.run(command(typedAs[0], typedAs[1]) as never)
        await clock.advance(1000)
        await clock.advance(400)

        const fresh = world.fills.at(-1)!

        expect(world.ran).toEqual(['clear'])
        expect([fresh.startsWith(typedAs[1] === 'pack' ? PACKED : LATEST), fresh.endsWith('\n\nYes, tag it.')]).toEqual([true, true])
      })
    }

    test("a hub's own handoff after a hold: its command alone, then the held message once the command has run", async ($, on) => {
      const hub = `${ROOT}/hub/h1/hub-handoff.md`
      const { world, clock } = await answered($, on, { record: guard({ handoffPath: hub }), files: { [hub]: '# Hub h1\n' } })

      await $.prompt.submit(typed('Yes, tag it.') as never)
      await clock.advance(100)
      // The box holds the held text: it is not a draft that keeps the command out.
      world.draft = 'Yes, tag it.'
      await press($, clock, 'latest')
      await clock.advance(300)

      expect(world.fills.slice(1)).toEqual(['/hub resume h1\n'])
      expect(world.toasts.join(' | ')).toContain('`/hub resume h1` is in the prompt, press Enter to send it; your held message goes in the prompt once it has run.')
      expect(heldFile(world)?.text, 'kept until it is in the prompt').toBe('Yes, tag it.')

      // The fresh session runs the command; once its turn is over, the held message is in the prompt.
      world.draft = ''
      await $.turn.start({ text: '/hub resume h1', turnId: 'h1' } as never)
      await $.turn.complete({ turnId: 'h1', answer: 'Resumed.' } as never)
      await clock.advance(100)

      expect(world.fills.slice(1)).toEqual(['/hub resume h1\n', 'Yes, tag it.'])
      expect(heldFile(world)?.used).toBeDefined()
    })

    test('Handoff & Clear after a hold, where neither other way can run: the brief, then the held message', async ($, on) => {
      const { world, clock } = await answered($, on, { record: null, hasTool: false })

      world.forkAnswer = { isAnswered: true, text: '<handoff>\n## Goal\nShip the strip.\n## Next steps\n1. Tag the release.\n</handoff>', usage: {} }

      const sent = (await $.prompt.submit(typed('Yes, tag it.') as never)) as { drop?: string }

      expect(sent.drop).toBe(`Cache Keeper held this message: ${COST} Handoff & Clear (/cache-keeper handoff) asks Claude for a brief at about that price, then goes on in a fresh session.`)
      expect(textOf(await $.ui.render(BAND as never))).toContain('[Handoff & Clear]')

      await clock.advance(100)
      await press($, clock, 'handoff')
      await clock.advance(400)

      const fresh = world.fills.at(-1)!

      expect([world.forks.length, world.ran]).toEqual([1, ['clear']])
      expect([fresh.includes('## Goal\nShip the strip.'), fresh.endsWith('\n\nYes, tag it.')]).toEqual([true, true])
    })
  })

  // ------------------------------------------ Claude's question, on a cold cache

  describe("Claude's question on a cold cache", () => {
    const QUESTIONS = [
      {
        question: 'Tag the release now?',
        header: 'Release',
        multiSelect: false,
        options: [
          { label: 'Tag it', description: 'Tag and push now.' },
          { label: 'Wait', description: 'Hold the tag for a review.' },
        ],
      },
    ]
    const ANSWER_TEXT = 'My answer to its question:\n- Tag the release now?\n  Tag it'
    const WORKING = { ...BAND, props: { ...BAND.props, isWorking: true } }
    const ask = ($: any) => $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS }) as Promise<Record<string, unknown>>
    /** The person's answer, as the dialog gives it. */
    const tagIt = (e: any) => ({ result: { questions: e.questions, answers: { 'Tag the release now?': 'Tag it' } }, text: 'User has answered your questions: "Tag the release now?"="Tag it".' })
    /** What the dialog gives once the turn it waits in has been ended. */
    const ENDED = { result: { questions: QUESTIONS, answers: {} }, text: 'The turn was ended.', isError: true }

    /**
     * A cold session of 400k tokens whose turn t1 is running: the question comes from it. The turn began at
     * T0, the request the status line last measured, and the cache went cold while it ran: the clock is at
     * COLD. The warning before cold went out at its time (its marker is in place).
     */
    async function asking($: any, on: any, opts: Parameters<typeof coldSession>[2] = {}) {
      const session = await answered($, on, { now: T0, ...opts })

      session.world.put(`${DIR}/live/sess-1.notified`, String(T0 + H))
      await $.turn.start({ text: 'Ship it.', turnId: 't1' } as never)
      await session.clock.set(COLD)

      return session
    }

    /** Claude's question, open until the test closes it. */
    function opened($: any, world: any) {
      let close = (result: unknown) => {}

      world.dialog = () => new Promise(resolve => (close = resolve))

      const call = ask($)

      return { call, close: (result: unknown = ENDED) => (close(result), call) }
    }

    test('an answer given on a cold cache is held: the turn is ended before the model reads it, and the answer is in the prompt', async ($, on) => {
      const { world, clock } = await asking($, on)

      world.dialog = tagIt

      const result = await ask($)

      expect(result.deny).toBe(core.ANSWER_HELD)
      expect(world.aborts).toEqual([{ turnId: 't1', runs: 0, ran: [] }])
      expect([heldFile(world)?.kind, heldFile(world)?.text]).toEqual(['answer', ANSWER_TEXT])
      expect(world.toasts.join(' | ')).toContain(`Cache Keeper held your answer: ${COST} ${WAYS}`)
      expect(world.logs).toEqual(["Cache Keeper held your answer to Claude's question (the cache was cold) and ended the turn: it is in the prompt."])

      await clock.advance(100)

      expect(world.fills).toEqual([ANSWER_TEXT])
      expect(textOf(await $.ui.render(BAND as never))).toContain('answer held')

      // The ended turn reports its end; then Enter sends the answer here, as a message.
      await $.turn.complete({ turnId: 't1', answer: '' } as never)

      expect(await $.prompt.submit(typed(ANSWER_TEXT) as never)).toEqual({ text: ANSWER_TEXT })
      expect(world.submits).toEqual([ANSWER_TEXT])
    })

    test('the held answer goes with Pack & Clear: the pointer to the pack, then the answer', async ($, on) => {
      const { world, clock } = await asking($, on)

      world.dialog = tagIt
      await ask($)
      await $.turn.complete({ turnId: 't1', answer: '' } as never)
      await clock.advance(100)
      world.draft = ANSWER_TEXT

      const strip = textOf(await $.ui.render(BAND as never))

      expect([strip.includes('[Use Latest Handoff]'), strip.includes('[Pack & Clear]')], 'the answer names its question: both ways carry it').toEqual([true, true])

      await press($, clock, 'pack')
      await clock.advance(300)

      const fresh = world.fills.at(-1)!

      expect(world.ran).toEqual(['clear'])
      expect([fresh.startsWith(PACKED), fresh.endsWith(`\n\n${ANSWER_TEXT}`), fresh.split(ANSWER_TEXT).length]).toEqual([true, true, 2])
      expect(world.toasts.join(' | ')).toContain('Pack & Clear: fresh session; the pointer to the pack and your held answer are in the prompt, press Enter to send them.')
      expect(world.submits).toEqual([])
    })

    test('not held: an answer under the threshold, nor one the dialog gave while the person was away', async ($, on) => {
      const { world } = await asking($, on)

      world.dialog = e => ({ result: { questions: e.questions, answers: { 'Tag the release now?': 'Wait' }, afkTimeoutMs: 600_000 }, text: 'auto-answered' })

      expect((await ask($)).text, "resolved while away: not the person's answer").toBe('auto-answered')

      await $.command.run(command('cache-keeper', 'hold 500k') as never)
      world.dialog = tagIt

      const small = await ask($)

      expect([small.deny, small.text]).toEqual([undefined, 'User has answered your questions: "Tag the release now?"="Tag it".'])
      expect([world.aborts, world.get(HELD)]).toEqual([[], undefined])
    })

    test('not held: a dialog closed with nothing chosen and nothing typed', async ($, on) => {
      const { world } = await asking($, on)

      world.dialog = e => ({ result: { questions: e.questions, answers: {} }, text: 'User has answered your questions: .' })

      expect((await ask($)).deny).toBe(undefined)
      expect([world.aborts, world.get(HELD)]).toEqual([[], undefined])
    })

    test('the dialog Pack & Clear closed gives no answer, even as a plain result: only the pointer goes to the fresh prompt', async ($, on) => {
      const { world, clock } = await asking($, on)
      const question = opened($, world)

      await clock.settle()
      await $.ui.render(WORKING as never)
      await $.ui.press({ plugin: PLUGIN, key: 'pack' } as never)

      // Closed by the end of its turn, with the answer the person had picked so far.
      expect((await question.close(tagIt({ questions: QUESTIONS }))).deny).toBe(undefined)

      await $.turn.complete({ turnId: 't1', answer: '' } as never)
      await clock.advance(300)

      expect([world.aborts.length, world.get(HELD), world.ran]).toEqual([1, undefined, ['clear']])
      expect(world.fills.at(-1)!.includes('My answer')).toBe(false)
    })

    test('not held: an answer on a warm cache goes to Claude', async ($, on) => {
      const world = worldOf(on)
      const clock = mock.clock(on, { now: T0 + 30 * M })

      world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
      await $.session.start(SESSION as never)
      await clock.settle()
      await $.turn.start({ text: 'Ship it.', turnId: 't1' } as never)
      world.dialog = tagIt

      const result = await ask($)

      expect([result.deny, world.aborts, world.notices]).toEqual([undefined, [], []])
    })

    test("Pack & Clear while Claude's question is open: the pack is built, then the turn is ended, then the session clears", async ($, on) => {
      const { world, clock } = await asking($, on)
      const question = opened($, world)

      await clock.settle()

      const strip = textOf(await $.ui.render(WORKING as never))

      expect(strip, 'the question holds the turn open: the press ends it').toContain('[Pack & Clear]')
      expect(strip, 'the handoff predates the question').not.toContain('[Use Latest Handoff]')

      await $.ui.press({ plugin: PLUGIN, key: 'pack' } as never)

      expect(world.processes).toEqual([core.packArgv(TOOL, 'sess-1')])
      expect(world.aborts, 'once the pack is built, before the clear').toEqual([{ turnId: 't1', runs: 1, ran: [] }])

      // The engine closes the dialog with the turn.
      expect((await question.close()).isError).toBe(true)

      await $.turn.complete({ turnId: 't1', answer: '' } as never)
      await clock.advance(300)

      expect(world.ran).toEqual(['clear'])
      expect(world.fills.at(-1)).toContain(`Read ${PACK} in full first`)
      expect(world.get(HELD), 'nothing was answered, so nothing is held').toBe(undefined)
    })

    test("typed while Claude's question is open: /use-latest-handoff says why it waits, /pack-and-clear runs at once", async ($, on) => {
      const { world, clock } = await asking($, on)
      const question = opened($, world)

      await clock.settle()

      const latest = (await $.command.run(command('use-latest-handoff') as never)) as { text?: string }

      expect(latest.text).toBe("Use Latest Handoff waits while Claude's question is open: the handoff predates the question. Pack & Clear (/pack-and-clear) ends the turn and carries the question to a fresh session.")

      const pack = (await $.command.run(command('pack-and-clear') as never)) as { text?: string }

      expect(pack.text).toBe("Pack & Clear: Claude's question holds the turn open, so acct-sync builds the pack now (no model call), then the turn is ended and the session clears.")

      await clock.settle()

      expect([world.processes.length, world.aborts.length]).toEqual([1, 1])

      await question.close()
      await clock.advance(300)

      expect(world.ran).toEqual(['clear'])
    })

    test('the engine will not end the turn while it runs: nothing is cleared, and the toast says why', async ($, on) => {
      const { world, clock } = await asking($, on)
      const question = opened($, world)

      world.abortRefusal = 'turn t1 is not the running turn t2'
      await clock.settle()
      await $.ui.render(WORKING as never)
      await $.ui.press({ plugin: PLUGIN, key: 'pack' } as never)
      await clock.advance(1000)

      expect(world.ran).toEqual([])
      expect(world.toasts.join(' | ')).toContain('Pack & Clear stopped: the turn could not be ended (')
      expect(world.toasts.join(' | ')).toContain('Nothing was cleared.')

      await question.close(tagIt({ questions: QUESTIONS }))
    })

    test("no transcript saved: the export keeps Claude's open question whole, and no result for it", async ($, on) => {
      const { world, clock } = await asking($, on, { transcript: 'missing' })
      const question = opened($, world)

      await clock.settle()

      const id = world.dialogIds[0]!
      const call = { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: QUESTIONS } }

      world.runs = acctSync([EXPORT])
      // As the engine may hold it: the call, and a result for it before the dialog is answered.
      world.messages = [...TALK, { role: 'assistant', content: [{ type: 'text', text: 'One question first.' }, call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] }]
      await $.ui.render(WORKING as never)
      await $.ui.press({ plugin: PLUGIN, key: 'pack' } as never)

      const exported = JSON.parse(world.get(EXPORT)!)

      expect(exported.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'One question first.' }, call] })
      expect(JSON.stringify(exported.messages)).not.toContain('tool_result')
      expect([world.processes, world.aborts.length]).toEqual([[core.packArgv(TOOL, EXPORT)], 1])

      await question.close()
    })

    test('under the open question, once the cache is cold: a line that says the answer will be held, once', async ($, on) => {
      const { world, clock } = await asking($, on)
      const question = opened($, world)

      await clock.advance(1000)

      expect(world.notices).toEqual([
        [world.dialogIds[0], 'Cache Keeper: the cache went cold, so your answer will be held, not read (that would read 400k tokens again, $3.20). Then Enter sends it here, or a button on the strip carries it to a fresh session.'],
      ])

      const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

      expect(status.text).toContain("  Claude's question is open, since")
      expect(status.text).toContain(': an answer now is held, and its turn ended')

      await clock.advance(3000)

      expect(world.notices.length).toBe(1)

      await question.close()
    })

    // ------------- the newest token figure: the request that raised the question, not the one before

    /** What the status line writes for sess-1 at `at`: its figures, or none before the session's first request. */
    const statusLineAt = (at: number, tokens: number | null) =>
      JSON.stringify(
        core.snapshotOfStatusLine(
          {
            session_id: 'sess-1',
            session_name: 'my-project',
            model: { id: 'claude-opus-5-5[1m]' },
            ...(tokens === null ? {} : { prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: tokens } }),
            context_window: { total_input_tokens: tokens ?? 0, context_window_size: 1_000_000 },
          },
          null,
          at,
        ),
      )
    /** A test in the real engine, as the overrides set it up: the cache counts as cold, and 1k tokens are enough. */
    const OVERRIDES = { CACHE_KEEPER_HOLD_COLD_AT: '1000', CACHE_KEEPER_ASSUME_COLD: '1' }
    const TRACE = `${DIR}/live/sess-1.trace.jsonl`

    /**
     * A new session's first request, which raises Claude's question: the session usage has no figure until
     * it comes back; `snapshot` is what the status line wrote before it, if it ran.
     */
    async function firstRequest($: any, on: any, snapshot: string | null, env: Record<string, string> = {}) {
      const world = worldOf(on, { env: { ...OVERRIDES, ...env } })
      const clock = mock.clock(on, { now: T0 })

      world.usageTokens = null

      if (snapshot !== null) world.put(`${DIR}/live/sess-1.json`, snapshot)

      await $.session.start(SESSION as never)
      await clock.settle()
      await $.turn.start({ text: 'Ask me which color.', turnId: 't1' } as never)
      // Its response asks the question; the status line is not run again while the dialog is open.
      world.usageTokens = 22_048

      return { world, clock }
    }

    test('the newest figure, no status line snapshot: a question raised by the first request is held under the overrides', async ($, on) => {
      const { world } = await firstRequest($, on, null)

      world.dialog = tagIt

      const result = await ask($)

      expect(result.deny).toBe(core.ANSWER_HELD)
      expect([world.aborts.map(a => a.turnId), heldFile(world)?.kind]).toEqual([['t1'], 'answer'])
      expect(world.toasts.join(' | ')).toContain('sending it would read 22k tokens again uncached')
      expect(world.get(TRACE), 'no trace unless CACHE_KEEPER_TRACE is set').toBe(undefined)
    })

    test('the newest figure, a snapshot with no figures (written before the first request): the line under the question, then the answer held', async ($, on) => {
      const { world, clock } = await firstRequest($, on, statusLineAt(T0, null))
      const question = opened($, world)

      await clock.advance(1000)

      expect(world.notices.map(([, text]) => text)).toEqual([expect.stringContaining('that would read 22k tokens again')])

      const result = await question.close(tagIt({ questions: QUESTIONS }))

      expect(result.deny).toBe(core.ANSWER_HELD)
      expect([heldFile(world)?.kind, heldFile(world)?.text]).toEqual(['answer', ANSWER_TEXT])
    })

    test('the newest figure, a snapshot older than the session usage: a typed message and a later question are judged on the request that raised them', async ($, on) => {
      const world = worldOf(on)
      const clock = mock.clock(on, { now: COLD })

      // The status line last ran after a request of 100k tokens, under the threshold; the session read 400k since.
      world.put(`${DIR}/live/sess-1.json`, statusLineAt(T0 + M, 100_000))
      world.usageTokens = 400_000
      world.messages = TALK
      await $.session.start(SESSION as never)
      await clock.settle()

      const sent = (await $.prompt.submit(typed('Yes, tag it.') as never)) as { drop?: string }

      expect(sent.drop).toBe(`Cache Keeper held this message: ${COST} Handoff & Clear (/cache-keeper handoff) asks Claude for a brief at about that price, then goes on in a fresh session.`)
      expect(await $.prompt.submit(typed('Yes, tag it.') as never), 'Enter again: it goes').toEqual({ text: 'Yes, tag it.' })

      // Its request raised Claude's question, 450k tokens read; the status line has not run since the 100k one.
      // The answer comes once the cache has gone cold by that turn's clock: more than an hour after it began.
      await $.turn.start({ text: 'Yes, tag it.', turnId: 't2' } as never)
      world.usageTokens = 450_000
      await clock.set(COLD + H + M)
      world.dialog = tagIt

      const result = await ask($)

      expect(result.deny).toBe(core.ANSWER_HELD)
      expect(world.toasts.join(' | ')).toContain('sending it would read 450k tokens again uncached (next msg $3.60)')
    })

    test('the newest figure, a snapshot newer than the last usage read: where the engine will not say, the snapshot stands', async ($, on) => {
      const world = worldOf(on)
      const clock = mock.clock(on, { now: T0 + 2 * M })

      world.put(`${DIR}/live/sess-1.json`, statusLineAt(T0 + M, 100_000))
      world.usageTokens = 100_000
      await $.session.start(SESSION as never)
      await clock.settle()
      await $.turn.start({ text: 'Ship it.', turnId: 't1' } as never)

      const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

      expect(status.text, 'the status reads the session usage, as a decision does').toContain('100k tokens from the session usage')

      // The status line then runs for a request of 400k, and the engine refuses the next read of the usage. The
      // answer comes once the cache has gone cold by the turn's clock.
      world.put(`${DIR}/live/sess-1.json`, statusLineAt(T0 + 2 * M + 1000, 400_000))
      world.usageRefusal = 'no session bound'
      await clock.set(COLD + M)
      world.dialog = tagIt

      const result = await ask($)

      expect(result.deny).toBe(core.ANSWER_HELD)
      expect(world.toasts.join(' | ')).toContain('sending it would read 400k tokens again uncached')
    })

    test('the newest figure, after a compaction: the session usage has none, and the reading from before it goes', async ($, on) => {
      const world = worldOf(on, { env: OVERRIDES })
      const clock = mock.clock(on, { now: T0 })

      world.put(`${DIR}/live/sess-1.json`, statusLineAt(T0, null))
      world.usageTokens = 22_048
      world.messages = TALK
      await $.session.start(SESSION as never)
      await clock.settle()

      const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

      expect(status.text).toContain('22k tokens from the session usage')

      // A compaction: the window that figure measured is gone, and no request has been measured since.
      world.usageTokens = null
      await clock.advance(1000)

      expect(await $.prompt.submit(typed('Go on.') as never), 'nothing measured: it goes').toEqual({ text: 'Go on.' })
    })

    test('CACHE_KEEPER_TRACE: one line per decision in live/<session>.trace.jsonl, its figures and their source, and no text of the answer', async ($, on) => {
      const { world, clock } = await firstRequest($, on, statusLineAt(T0, null), { CACHE_KEEPER_TRACE: '1' })

      world.dialog = tagIt
      await ask($)
      await clock.settle()

      const lines = (world.get(TRACE) ?? '').trim().split('\n').map(line => JSON.parse(line))

      expect(lines.map(line => line.ev)).toEqual(['question-open', 'answer', 'cold-send', 'abort', 'hold-answer'])
      expect(lines[0]).toMatchObject({ v: core.VERSION, id: world.dialogIds[0]!.slice(0, 16), turn: 't1' })
      expect(lines[1]).toMatchObject({ isDenied: false, isError: false, hasResult: true, isAway: false, isAnswer: true })
      expect(lines[2]).toMatchObject({
        for: 'answer',
        state: 'cold',
        isAssumedCold: true,
        tokens: 22_048,
        source: 'usage',
        snapshot: { source: 'statusline', tokens: null },
        usage: { read: 'figure', tokens: 22_048 },
        limit: 1000,
        isColdSend: true,
        // The clock it went by: no request measured yet, so the start of the turn that asked, on the fallback TTL.
        clock: 'turn-start',
        turnAt: new Date(T0).toISOString(),
        expiresAt: new Date(T0 + H).toISOString(),
        ttl: '1h?',
      })
      expect([lines[3], lines[4]]).toMatchObject([{ turn: 't1', outcome: 'ended', ok: true }, { return: 'held' }])
      expect(world.get(TRACE), 'no text of the question or the answer').not.toMatch(/Tag it|Tag the release|Release/)

      const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

      expect(status.text).toContain(`  CACHE_KEEPER_TRACE is set: each hold decision is written to ${inReply(TRACE)}`)
    })

    // ------------- the cache clock while the question is open: the start of the turn that asked (0.4.3)

    // The kit gives the dialog's stand-in (this file's own tool.call hook) 10 s of real time per dispatch, and each 1-s
    // tick costs it several ms while a dispatch is pending: so a question here stays open some minutes, never an hour.
    // The rule never reads the time a question opened (C5 shows it), so each cell keeps its turn start, snapshot and
    // answer time, and opens its question a few minutes before the moment it looks at.
    describe("the cache clock under Claude's question: the later of the snapshot's last request and the start of the turn that asked", () => {
      /** T0 and `minutes` after it. */
      const at = (minutes: number) => T0 + Math.round(minutes * M)
      const iso = (time: number) => new Date(time).toISOString()
      const traceOf = (world: { get: (path: string) => string | undefined }) => (world.get(TRACE) ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const answerOf = (world: { get: (path: string) => string | undefined }) => traceOf(world).find(line => line.ev === 'cold-send' && line.for === 'answer')

      /**
       * A session the module binds at `bindAt`: Claude has answered before, the session usage reads 400k, and the
       * status line last wrote `snapshot` (by default a request at `lastAt`, 1h TTL, 400k tokens; null: it never
       * ran). `turnAt`: when turn t1 starts, by the module's clock; left out, the module never saw the turn start
       * (it was loaded again mid-turn).
       */
      async function clockedSession($: any, on: any, o: { bindAt: number; lastAt?: number; snapshot?: string | null; turnAt?: number; env?: Record<string, string> }) {
        const world = worldOf(on, { env: o.env })
        const clock = mock.clock(on, { now: o.bindAt })
        const snapshot = o.snapshot !== undefined ? o.snapshot : JSON.stringify(snapshotFor('sess-1', o.lastAt ?? T0))

        world.usageTokens = 400_000
        world.messages = TALK

        if (snapshot !== null) world.put(`${DIR}/live/sess-1.json`, snapshot)

        await $.session.start(SESSION as never)
        await clock.settle()

        if (o.turnAt !== undefined) {
          await clock.set(o.turnAt)
          await $.turn.start({ text: 'Ship it.', turnId: 't1' } as never)
        }

        return { world, clock }
      }

      /** Claude's question, opened at `openAt`, left open until the test closes it. */
      async function openAt($: any, world: any, clock: any, time: number) {
        await clock.set(time)

        const question = opened($, world)

        await clock.settle()

        return question
      }

      /** The person's answer (Tag it) at `time`, to a question opened earlier. */
      async function answerAt(clock: any, question: ReturnType<typeof opened>, time: number) {
        await clock.set(time)

        return question.close(tagIt({ questions: QUESTIONS }))
      }

      test('C1, C13: a turn 40 min after the last request asks, answered at T0+70: not held, and no line under it at T0+60 or since; the strip and the status count from the turn start', { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: at(40), lastAt: T0, turnAt: at(40) })
        const question = await openAt($, world, clock, at(59))

        await clock.set(at(70))

        const strip = textOf(await $.ui.render(WORKING as never))

        expect(strip, 'warm until the turn start + 1h').toContain(`● cache ${core.countdown(30 * M)}`)
        expect(strip).toContain(`→${core.clockLabel(at(100), at(70))} 1h`)
        expect(strip, 'not cold since T0+60').not.toContain('cache cold')

        const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

        expect(status.text).toContain(`cache: warm, cold at ${new Date(at(100)).toLocaleTimeString()}; TTL 1h`)
        expect(status.text).toContain(`; the cache counts from its turn's start, ${new Date(at(40)).toLocaleTimeString()}: an answer now goes to Claude`)
        expect(world.notices).toEqual([])

        const result = await answerAt(clock, question, at(70))

        expect([result.deny, world.aborts, world.get(HELD), world.notices]).toEqual([undefined, [], undefined, []])
      })

      test('C2: as C1, answered at T0+101: held; the line under the question came once, at the first tick at or after T0+100, and the warning before it at T0+95', { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: at(40), lastAt: T0, turnAt: at(40) })
        const question = await openAt($, world, clock, at(94))
        const warnings = () => world.toasts.filter(toast => toast.includes('Cache goes cold in 5 min')).length
        const before = warnings()

        await clock.set(at(95) - 1000)

        expect([world.notices, warnings()], 'nothing at once: the cache counts from the turn start').toEqual([[], before])

        await clock.advance(1000)

        expect(warnings(), 'the warning, 5 minutes before the expiry the strip shows').toBe(before + 1)

        await clock.set(at(100) - 1000)

        expect(world.notices).toEqual([])

        await clock.advance(1000)

        expect(world.notices.map(([id]) => id)).toEqual([world.dialogIds[0]])
        expect(world.notices[0]![1]).toContain('that would read 400k tokens again')

        const result = await answerAt(clock, question, at(101))

        expect(result.deny).toBe(core.ANSWER_HELD)
        expect([world.aborts.map(a => a.turnId), heldFile(world)?.kind, world.notices.length]).toEqual([['t1'], 'answer', 1])
      })

      test('C3: a turn sent on a cold cache asks at once: its request re-cached, so the answer is not held and nothing shows under the question', async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: at(180), lastAt: T0, turnAt: at(180) })
        const question = await openAt($, world, clock, at(180.2))

        expect(textOf(await $.ui.render(WORKING as never))).toContain(`→${core.clockLabel(at(240), at(180.2))} 1h`)

        const result = await answerAt(clock, question, at(181))

        expect([result.deny, world.aborts, world.get(HELD), world.notices]).toEqual([undefined, [], undefined, []])
      })

      test("C4: a session's first reply asks (no cache facts yet): an answer at T0+30 goes to Claude, the strip counting from the turn start on the fallback TTL, 1h?", { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, snapshot: statusLineAt(T0, null), turnAt: T0 })
        const question = await openAt($, world, clock, at(25))

        await clock.set(at(30))

        const strip = textOf(await $.ui.render(WORKING as never))

        expect(strip).toContain(`● cache ${core.countdown(30 * M)}`)
        expect(strip).toContain(`→${core.clockLabel(at(60), at(30))} 1h?`)

        const result = await answerAt(clock, question, at(30))

        expect([result.deny, world.aborts, world.notices]).toEqual([undefined, [], []])
      })

      test("C4: a session's first reply asks (no cache facts yet), answered at T0+61: held, on the turn start and the fallback TTL, 1h?", { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, snapshot: statusLineAt(T0, null), turnAt: T0, env: { CACHE_KEEPER_TRACE: '1' } })
        const question = await openAt($, world, clock, at(55))
        const result = await answerAt(clock, question, at(61))

        expect(result.deny).toBe(core.ANSWER_HELD)
        expect(world.notices.length, 'the line under the question, from T0+60').toBe(1)
        expect(answerOf(world)).toMatchObject({ state: 'cold', clock: 'turn-start', turnAt: iso(T0), expiresAt: iso(at(60)), ttl: '1h?', tokens: 400_000, isColdSend: true })
      })

      test("C5: a long asking request (T0 to T0+55): the clock is the turn's start, not the time the question opened", { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, lastAt: at(-10), turnAt: T0 })
        const question = await openAt($, world, clock, at(55))
        const result = await answerAt(clock, question, at(61))

        expect(result.deny).toBe(core.ANSWER_HELD)
      })

      /** C6: turn t1 starts at T0; the status line's last request is one of that turn's, at T0+30; the question opens at `openMinute`. */
      async function midTurn($: any, on: any, openMinute: number) {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, lastAt: at(-5), turnAt: T0 })

        await clock.set(at(30))
        world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', at(30))))

        return { world, clock, question: await openAt($, world, clock, at(openMinute)) }
      }

      test("C6: a question mid-turn, the snapshot's request later than the turn start: that one stands (the later, not the earlier): not held at T0+80", { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock, question } = await midTurn($, on, 75)
        const result = await answerAt(clock, question, at(80))

        expect([result.deny, world.aborts, world.notices]).toEqual([undefined, [], []])
      })

      test("C6: a question mid-turn, the snapshot's request later than the turn start: held at T0+91", { timeoutMs: 30_000 }, async ($, on) => {
        const { clock, question } = await midTurn($, on, 86)
        const result = await answerAt(clock, question, at(91))

        expect(result.deny).toBe(core.ANSWER_HELD)
      })

      test('C7: no status line (unknown): no hold and no line under the question, as everywhere without it (a 2-minute CACHE_KEEPER_TTL keeps it short)', async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, snapshot: null, turnAt: T0, env: { CACHE_KEEPER_TTL: '2' } })
        const question = await openAt($, world, clock, at(0.1))
        const result = await answerAt(clock, question, at(3))

        expect([result.deny, world.aborts, world.notices]).toEqual([undefined, [], []])
        expect(textOf(await $.ui.render(BAND as never))).toContain('○ cache ?')
      })

      test('C8: caching off (requests sent, nothing cached): no hold (a 2-minute CACHE_KEEPER_TTL keeps it short)', async ($, on) => {
        const off = JSON.stringify(
          core.snapshotOfStatusLine(
            { session_id: 'sess-1', model: { id: 'claude-opus-5-5[1m]' }, prompt_cache: { ttl: '1h', caching_observed: true, recache_tokens_if_cold: 400000 }, context_window: { total_input_tokens: 400000, context_window_size: 1_000_000 } },
            null,
            T0,
          ),
        )
        const { world, clock } = await clockedSession($, on, { bindAt: T0, snapshot: off, turnAt: T0, env: { CACHE_KEEPER_TTL: '2' } })
        const question = await openAt($, world, clock, at(0.1))
        const result = await answerAt(clock, question, at(3))

        expect([result.deny, world.aborts, world.notices]).toEqual([undefined, [], []])
      })

      test('C9: loaded again mid-turn (its start not seen): the line under the question goes by the snapshot, as in 0.4.2, and the answer, its turn unknown, is not held', { timeoutMs: 30_000 }, async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: at(40), lastAt: T0, env: { CACHE_KEEPER_TRACE: '1' } })
        const question = await openAt($, world, clock, at(55))

        await clock.set(at(60) - 1000)

        expect(world.notices).toEqual([])

        await clock.advance(1000)

        expect(world.notices.length, 'at T0+60: the snapshot expiry').toBe(1)
        expect(traceOf(world).find(line => line.ev === 'cold-send' && line.for === 'notice' && line.isColdSend === true)).toMatchObject({ clock: 'snapshot', turnAt: null, expiresAt: iso(at(60)) })

        const result = await answerAt(clock, question, at(61))

        expect([result.deny, world.aborts]).toEqual([undefined, []])
        expect(traceOf(world).at(-1)).toMatchObject({ ev: 'hold-answer', return: 'no-turn' })
      })

      test('C10: the typed guard goes by the snapshot alone: a turn that made no request (a dropped prompt), then a message typed on a cold cache, is held', async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: at(100), lastAt: T0, turnAt: at(100) })

        await $.turn.complete({ turnId: 't1', answer: '' } as never)
        await clock.set(at(101))

        expect(textOf(await $.ui.render(BAND as never)), 'no question open: the strip goes by the snapshot too').toContain(`○ cache cold since ${core.clockLabel(at(60), at(101))}`)

        const sent = (await $.prompt.submit(typed('Yes, tag it.') as never)) as { drop?: string }

        expect(sent.drop).toContain('Cache Keeper held this message')
        expect(world.submits).toEqual([])
      })

      test("C11: a read of the session usage that hangs: the line under the question still comes, and the answer's decision is made within 1 s on the snapshot's figure", async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, lastAt: T0, turnAt: T0, env: { CACHE_KEEPER_TTL: '2', CACHE_KEEPER_TRACE: '1' } })
        let release = () => {}

        world.usageGate = new Promise<void>(resolve => (release = resolve))

        try {
          const question = await openAt($, world, clock, at(0.1))

          await clock.set(at(2.5))

          expect(world.notices.length, 'the tick goes on: the line under the question at T0+2').toBe(1)
          expect(textOf(await $.ui.render(WORKING as never)), 'and the strip moves with it').toContain(`○ cache cold since ${core.clockLabel(at(2), at(2.5))}`)

          const answered: { result: Record<string, unknown> | null } = { result: null }

          void question.close(tagIt({ questions: QUESTIONS })).then(result => (answered.result = result))
          await clock.settle()
          await clock.advance(1000)
          await clock.settle()

          expect(answered.result?.deny, 'decided once the read gave up').toBe(core.ANSWER_HELD)
          expect(world.toasts.join(' | ')).toContain('sending it would read 400k tokens again uncached')
          expect(answerOf(world)).toMatchObject({ usage: { read: 'refused', tokens: null }, source: 'statusline', tokens: 400_000, ttl: '2m', isColdSend: true })
        } finally {
          release()
        }
      })

      test('C11: with no status line, a read of the session usage that hangs does not stop the tick (it counts as refused, as in refresh before)', async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: T0, snapshot: null })
        let release = () => {}

        expect(textOf(await $.ui.render(BAND as never))).toContain('ctx 400k')

        world.usageGate = new Promise<void>(resolve => (release = resolve))

        try {
          await clock.set(T0 + 40_000)

          expect(Number((world.get(`${DIR}/live/sess-1.module`) ?? '0').split(' ')[0]), 'the heartbeat goes on past the read at the 30th tick').toBeGreaterThan(T0 + 35_000)
        } finally {
          release()
        }
      })

      test('C12: CACHE_KEEPER_ASSUME_COLD still makes it cold: C3 is then held', async ($, on) => {
        const { world, clock } = await clockedSession($, on, { bindAt: at(180), lastAt: T0, turnAt: at(180), env: { CACHE_KEEPER_ASSUME_COLD: '1' } })
        const question = await openAt($, world, clock, at(180.2))
        const result = await answerAt(clock, question, at(181))

        expect(result.deny).toBe(core.ANSWER_HELD)
        expect(world.notices.length).toBe(1)
      })

      test('CACHE_KEEPER_TTL: the TTL a test in the real engine forces, as the ttl setting would, and /cache-keeper says so; config.json is left alone', async ($, on) => {
        const { world } = await clockedSession($, on, { bindAt: at(1), lastAt: T0, env: { CACHE_KEEPER_TTL: '2' } })
        const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

        expect(status.text).toContain(`cache: warning, cold at ${new Date(at(2)).toLocaleTimeString()}; TTL 2m (forced by CACHE_KEEPER_TTL)`)
        expect(status.text).toContain('  CACHE_KEEPER_TTL is set: the TTL is 2 min, whatever Claude Code measured (the setting says auto)')
        expect(world.get(`${DIR}/config.json`)).toBe(undefined)
      })
    })
  })
})

describe('account limits', () => {
  const BEARER = { handle: 'h1', kind: 'bearer' }
  const limitsFile = (world: any) => JSON.parse(world.get(`${DIR}/limits.json`) ?? 'null')

  test('an idle session shows what the usage endpoint says now, not its own last response', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.auth = BEARER
    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0 - 50 * M)))
    await $.session.start(SESSION as never)
    await clock.settle()

    expect(textOf(await $.ui.render(BAND as never)), "its own response's figures, before any poll").toContain('wk 50%')

    // Past any session's jitter (at most 15 s), one poll.
    await clock.advance(16_000)
    await clock.settle()

    const fetched = world.fetches[0]!

    expect(world.fetches.length).toBe(1)
    expect(fetched.url).toBe(core.USAGE_URL)
    expect(fetched.init.auth, 'the credential travels as the opaque handle only').toBe('h1')
    expect(fetched.init.headers['anthropic-beta']).toBe('oauth-2025-04-20')

    const saved = limitsFile(world)

    expect([saved.source, saved.by, saved.fiveHour.pct, saved.sevenDay.pct, saved.scoped[0].name]).toEqual(['usage', 'sess-1', 40, 70, 'Fable'])

    const text = textOf(await $.ui.render(BAND as never))

    expect(text).toContain('5h 40%')
    expect(text).toContain('wk 70%')
    expect(text).toContain('Fable 95%')
  })

  test("one poll a minute between all sessions: another session's fresh reading, or its claim, holds this one off", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.auth = BEARER
    world.put(`${DIR}/limits.json`, JSON.stringify(core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-9', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()
    await clock.advance(40_000)
    await clock.settle()

    expect(world.fetches.length, 'read 40 s ago by another session').toBe(0)
    expect(textOf(await $.ui.render(BAND as never)), 'and shown here all the same').toContain('wk 70%')

    world.put(`${DIR}/limits.json`, JSON.stringify(core.claimed(core.accountOf(JSON.parse(world.get(`${DIR}/limits.json`)!)), 'sess-9', T0 + 120_000)))
    await clock.advance(90_000)
    await clock.settle()

    expect(world.fetches.length, 'due, but another session claimed it').toBe(0)

    await clock.advance(30_000)
    await clock.settle()

    expect(world.fetches.length, 'the claim lapsed').toBe(1)
  })

  test('a failed poll keeps what was read, and backs every session off', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.auth = BEARER
    world.fetchAnswer = { status: 429, ok: false, headers: {}, text: '' }
    await $.session.start(SESSION as never)
    await clock.settle()
    await clock.advance(16_000)
    await clock.settle()

    const saved = limitsFile(world)

    expect([world.fetches.length, saved.failures, saved.error]).toEqual([1, 1, 'HTTP 429'])

    // sess-1 polled at T0+8 s (its jitter is 7.1 s): a minute of backoff, then a minute and its jitter.
    await clock.advance(50_000)
    await clock.settle()

    expect(world.fetches.length, 'still backing off').toBe(1)

    await clock.advance(20_000)
    await clock.settle()

    expect(world.fetches.length).toBe(2)
    expect(limitsFile(world).failures, 'twice now: two minutes next').toBe(2)
  })

  test('a session with an API key never polls', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.auth = { handle: 'k1', kind: 'api-key' }
    await $.session.start(SESSION as never)
    await clock.settle()
    await clock.advance(120_000)
    await clock.settle()

    expect(world.fetches.length).toBe(0)
  })

  test('/cache-keeper limits off: nothing polls', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.auth = BEARER
    world.put(`${DIR}/config.json`, JSON.stringify({ limitsPollSeconds: 0 }))
    await $.session.start(SESSION as never)
    await clock.settle()
    await clock.advance(120_000)
    await clock.settle()

    expect(world.fetches.length).toBe(0)
  })

  test("a response that moves a window reaches every session at once, and keeps the scoped limit", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.put(`${DIR}/limits.json`, JSON.stringify(core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-9', T0 - 30_000)))
    await $.session.start(SESSION as never)
    await clock.settle()
    await ($.session as any).measure({
      context: { tokens: 1000, window: 200_000, percent: 1 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 90, resetsAt: '2026-10-28T15:00:00Z' },
        { kind: 'seven_day', percentUsed: 80, resetsAt: '2026-11-01T09:00:00Z' },
      ],
      changed: ['rateLimits'],
    })
    await clock.settle()

    const saved = limitsFile(world)

    expect([saved.source, saved.fiveHour.pct, saved.sevenDay.pct, saved.scoped[0].pct]).toEqual(['response', 90, 80, 95])
    expect(textOf(await $.ui.render(BAND as never))).toContain('wk 80%')

    const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

    expect(status.text).toContain("limits: 5h 90%, wk 80%, Fable 95%, from a session's response 0 s ago")
  })

  test("a response that trails the file's reading leaves it, and every strip, as they are", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    world.put(`${DIR}/limits.json`, JSON.stringify(core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-9', T0 - 30_000)))
    await $.session.start(SESSION as never)
    await clock.settle()

    const before = world.get(`${DIR}/limits.json`)

    await ($.session as any).measure({
      context: { tokens: 1000, window: 200_000, percent: 1 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 39, resetsAt: '2026-10-28T15:00:00Z' },
        { kind: 'seven_day', percentUsed: 69, resetsAt: '2026-11-01T09:00:00Z' },
      ],
      changed: ['rateLimits'],
    })
    await clock.settle()

    expect(world.get(`${DIR}/limits.json`), 'not written').toBe(before)
    expect(textOf(await $.ui.render(BAND as never))).toContain('5h 40%')
  })

  test('a half-written file: a response merges into the last good reading, and keeps what only the endpoint knows', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    const good = JSON.stringify(core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-9', T0 - 30_000))

    world.put(`${DIR}/limits.json`, good)
    await $.session.start(SESSION as never)
    await clock.settle()
    // Another session, mid-write.
    world.put(`${DIR}/limits.json`, good.slice(0, 40))
    await ($.session as any).measure({
      context: { tokens: 1000, window: 200_000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: '2026-10-28T15:00:00Z' }],
      changed: ['rateLimits'],
    })
    await clock.settle()

    const saved = limitsFile(world)

    expect([saved?.fiveHour?.pct, saved?.sevenDay?.pct, saved?.scoped?.[0]?.name, saved?.polledAt]).toEqual([90, 70, 'Fable', T0 - 30_000])
  })

  test("another login's poll in the file: this session keeps its own figures, and the status says why", async ($, on) => {
    // An idle session can hold the token a /login replaced: its poll writes the old login's week into
    // the file. This session is the new login's, whose week ends hours later.
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    const newLogin = { five_hour: { used_percentage: 15, resets_at: (T0 + 3 * H) / 1000 }, seven_day: { used_percentage: 5, resets_at: (WEEK_ENDS + 4 * H) / 1000 } }

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0, newLogin)))
    world.put(`${DIR}/limits.json`, JSON.stringify(core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-9', T0 - 30_000)))
    await $.session.start(SESSION as never)
    await clock.settle()

    const text = textOf(await $.ui.render(BAND as never))

    expect(text).toContain('wk 5%')
    expect(text, "not the old login's").not.toContain('Fable')

    const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

    expect(status.text).toContain("from this session's own last response: the file holds another login's reading")

    // Then a response of this login's brings its own week into the file: shown, without the old Fable.
    await ($.session as any).measure({
      context: { tokens: 1000, window: 200_000, percent: 1 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 16, resetsAt: new Date(T0 + 3 * H).toISOString() },
        { kind: 'seven_day', percentUsed: 6, resetsAt: new Date(WEEK_ENDS + 4 * H).toISOString() },
      ],
      changed: ['rateLimits'],
    })
    await clock.settle()

    const after = textOf(await $.ui.render(BAND as never))

    expect([limitsFile(world)?.scoped?.[0]?.pct, after.includes('wk 6%'), after.includes('Fable')], 'the file still holds it; the strip does not show it').toEqual([95, true, false])
  })

  test('a response that lands while the module binds is written once it has, not dropped', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    let open = () => {}

    world.envGate = new Promise<void>(resolve => (open = resolve))
    await $.session.start(SESSION as never)
    await ($.session as any).measure({
      context: { tokens: 1000, window: 200_000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: '2026-10-28T15:00:00Z' }],
      changed: ['rateLimits'],
    })

    expect(world.get(`${DIR}/limits.json`), 'still binding: no file known yet').toBe(undefined)

    open()
    await clock.settle()

    expect(limitsFile(world)?.fiveHour?.pct).toBe(90)
  })
})

describe('/cache-keeper', () => {
  test('a setting is saved to config.json, and the status says what the strip knows', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 + 10 * M })

    world.put(`${DIR}/live/sess-1.json`, JSON.stringify(snapshotFor('sess-1', T0)))
    await $.session.start(SESSION as never)
    await clock.settle()

    const set = await $.command.run(command('cache-keeper', 'ttl 45') as never)

    expect((set as { text?: string }).text).toBe('Cache Keeper: TTL: forced to 45 min')
    expect(JSON.parse(world.get(`${DIR}/config.json`)!).ttl).toBe(45)

    const status = (await $.command.run(command('cache-keeper') as never)) as { text?: string }

    expect(status.text).toContain('TTL 45m (forced by /cache-keeper ttl)')
    expect(status.text).toContain('data: status line snapshot')

    const bad = (await $.command.run(command('cache-keeper', 'ttl soon') as never)) as { text?: string }

    expect(bad.text).toContain('ttl takes auto or 1-1440 minutes')
  })
})
