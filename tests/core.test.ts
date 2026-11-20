import { describe, expect, test } from 'claude-code/testing'

import * as core from '../hooks/core.mjs'
import { USAGE_BODY } from './usage-fixture.ts'

const H = 3_600_000
const M = 60_000
const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const config = core.configOf(undefined)

/** A transcript in Claude Code's own shape: one line per content block, a reply's lines sharing its id. */
function transcript(lines: Record<string, unknown>[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n'
}

const user = (at: number, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: 'x' }, ...extra })

const reply = (at: number, id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  timestamp: new Date(at).toISOString(),
  message: { id, model: 'claude-opus-5-5', role: 'assistant', usage },
  ...extra,
})

const usage1h = (read: number, written: number) => ({
  input_tokens: 2,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: written },
  output_tokens: 800,
})

describe('prices', () => {
  test('model ids normalise to the catalog, and nothing else is guessed', () => {
    expect(core.modelKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(core.modelKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5')
    expect(core.modelKey('claude-opus-4-5@20251101')).toBe('claude-opus-4-5')
    expect(core.modelKey('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-0')
    expect(core.modelKey('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(core.modelKey('claude-opus-4-9'), 'an unknown Opus is not priced as some other Opus').toBe(null)
    expect(core.modelKey('gpt-5')).toBe(null)
    expect(core.modelKey(undefined)).toBe(null)
  })

  test("each model's rates are the catalog's, cache reads included", () => {
    expect(core.pricesFor('claude-opus-5-5')).toEqual({ input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 })
    expect(core.pricesFor('claude-fable-5-1')?.read).toBe(0.25)
    expect(core.pricesFor('claude-fable-5')?.read).toBe(1)
    expect(core.pricesFor('claude-sonnet-5')?.write1h).toBe(4)
    expect(core.pricesFor('claude-haiku-4-5')?.write5m).toBe(1.25)
    expect(core.pricesFor('claude-opus-5-5', true)?.input, 'fast mode').toBe(8)
    expect(core.pricesFor('claude-sonnet-5', true)?.input, 'no fast price: the standard one').toBe(2)
  })

  test('the current models: Claude Haiku 5.5 on two cards by the prompt, Claude Sonnet 5.5, Claude Fable 5.2', () => {
    const short = { input: 0.1, output: 0.5, write5m: 0.125, write1h: 0.2, read: 0.01 }

    expect(core.modelKey('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(core.pricesFor('claude-haiku-5-5'), 'no prompt known: the short card').toEqual(short)
    expect(core.pricesFor('claude-haiku-5-5', false, 100_000), '100k tokens or fewer').toEqual(short)
    expect(core.pricesFor('claude-haiku-5-5', false, 100_001), 'over 100k').toEqual({ input: 0.5, output: 2.5, write5m: 0.625, write1h: 1, read: 0.05 })
    expect(core.pricesFor('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.1 })
    expect(core.pricesFor('claude-fable-5-2')).toEqual({ input: 8, output: 40, write5m: 10, write1h: 16, read: 0.2 })
  })
})

describe('the cache', () => {
  test("Claude Code's tracker: the last touch is its expiry less the TTL it measured", () => {
    const facts = core.cacheFromPromptCache({ ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000, hit_ratio: 0.9 })

    expect(facts).toEqual({ observed: true, lastAt: T0, ttl: '1h', source: 'claude', recacheTokens: 400000, hitRatio: 0.9, misses: null, lastMissCauses: null })
    expect(core.cacheFromPromptCache({ ttl: '1h', expires_at: null, caching_observed: false })?.lastAt).toBe(null)
    expect(core.cacheFromPromptCache(undefined)).toBe(null)
  })

  test('warm, then the warning window, then cold', () => {
    const facts = core.cacheFromPromptCache({ ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true })

    expect(core.cacheView(facts, T0 + 10 * M, config).state).toBe('warm')
    expect(core.cacheView(facts, T0 + 55 * M, config).state, 'exactly 5 minutes left').toBe('warning')
    expect(core.cacheView(facts, T0 + 59 * M, config).remainingMs).toBe(M)
    expect(core.cacheView(facts, T0 + H, config).state).toBe('cold')
    expect(core.cacheView(facts, T0 + 10 * M, config).ttlLabel).toBe('1h')
  })

  test('a forced TTL replaces the measured one; with nothing measured the fallback is marked as a guess', () => {
    const facts = core.cacheFromPromptCache({ ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true })
    const forced = core.cacheView(facts, T0, core.configOf({ ttl: 30 }))

    expect([forced.expiresAt, forced.ttlLabel, forced.source]).toEqual([T0 + 30 * M, '30m', 'override'])

    const guessed = core.cacheView({ observed: true, lastAt: T0, ttl: null, source: 'transcript', recacheTokens: 1 }, T0, core.configOf({ fallbackTtlMinutes: 45 }))

    expect([guessed.expiresAt, guessed.ttlLabel, guessed.assumed, guessed.source]).toEqual([T0 + 45 * M, '45m?', true, 'fallback'])
  })

  test('no request yet, nothing knowable, and caching off are three different things', () => {
    expect(core.cacheView(null, T0, config).state).toBe('none')
    expect(core.cacheView(null, T0, config, false).state).toBe('unknown')
    expect(core.cacheView({ observed: true, lastAt: null, ttl: '1h', source: 'claude', recacheTokens: 5 }, T0, config).state).toBe('off')
  })

  test('the next message: a cache read warm, a 1-hour write cold, for the tokens Claude Code would re-cache', () => {
    const snapshot = core.snapshotOfStatusLine(
      {
        session_id: 's',
        model: { id: 'claude-opus-5-5[1m]' },
        prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 },
        context_window: { total_input_tokens: 400000, context_window_size: 1_000_000 },
      },
      null,
      T0,
    )
    const view = core.viewOf(snapshot, T0, config)

    const cents = (x: number | undefined) => Math.round((x ?? NaN) * 1e6) / 1e6

    expect(cents(view.next?.warm)).toBe(0.08)
    expect(cents(view.next?.cold)).toBe(3.2)

    const fiveMinute = core.viewOf({ ...snapshot, cache: { ...snapshot.cache!, ttl: '5m' } }, T0, config)

    expect(cents(fiveMinute.next?.cold), 'a 5-minute cache rewrites at the 5-minute rate').toBe(2)
  })
})

describe("the cache clock while Claude's question is open", () => {
  const measured = (lastAt: number) => core.cacheFromPromptCache({ ttl: '1h', expires_at: (lastAt + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 })

  test("the later of the snapshot's last request and the start of the turn that asked: never the earlier", () => {
    const later = core.questionClock(measured(T0), T0 + 40 * M, true)

    expect([later.clock, later.facts?.lastAt, later.facts?.ttl, later.facts?.recacheTokens]).toEqual(['turn-start', T0 + 40 * M, '1h', 400000])

    const earlier = core.questionClock(measured(T0 + 30 * M), T0, true)

    expect([earlier.clock, earlier.facts?.lastAt], 'a request later in the same turn: the snapshot stands').toEqual(['snapshot', T0 + 30 * M])
    expect(core.questionClock(measured(T0), T0, true).clock, 'a tie: the snapshot').toBe('snapshot')
  })

  test('no request measured yet (none): the turn start, on the fallback TTL; nothing knowable, caching off, or no turn: as measured', () => {
    const none = core.questionClock(null, T0, true)

    expect([none.clock, none.facts?.lastAt, none.facts?.ttl]).toEqual(['turn-start', T0, null])
    expect(core.cacheView(none.facts, T0 + 30 * M, config)).toMatchObject({ state: 'warm', expiresAt: T0 + H, ttlLabel: '1h?', assumed: true, source: 'fallback' })
    expect(core.questionClock(null, T0, false)).toEqual({ facts: null, clock: 'snapshot' })

    const off = { observed: true, lastAt: null, ttl: '1h' as const, source: 'claude' as const, recacheTokens: 5 }

    expect(core.questionClock(off, T0, true)).toEqual({ facts: off, clock: 'snapshot' })
    expect(core.questionClock(measured(T0), null, true)).toEqual({ facts: measured(T0), clock: 'snapshot' })
  })

  test('the view: the expiry from the turn start, the clock it used, the figure unchanged, and ASSUME_COLD still cold', () => {
    const snapshot = core.snapshotOfStatusLine(
      {
        session_id: 's',
        model: { id: 'claude-opus-5-5[1m]' },
        prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 },
        context_window: { total_input_tokens: 400000, context_window_size: 1_000_000 },
      },
      null,
      T0,
    )
    const asked = core.viewOf(snapshot, T0 + 70 * M, config, { turnAt: T0 + 40 * M })

    expect([asked.cache.state, asked.cache.expiresAt, asked.clock, asked.tokensIfCold]).toEqual(['warm', T0 + 100 * M, { name: 'turn-start', turnAt: T0 + 40 * M }, 400000])
    expect([core.viewOf(snapshot, T0 + 70 * M, config).cache.state, core.viewOf(snapshot, T0 + 70 * M, config).clock]).toEqual(['cold', { name: 'snapshot', turnAt: null }])
    expect(core.viewOf(snapshot, T0 + 70 * M, config, { turnAt: T0 + 40 * M, assumeCold: true }).cache.state).toBe('cold')
  })

  test('CACHE_KEEPER_TTL: minutes (1-1440) or auto, as the ttl setting takes them; anything else leaves the setting', () => {
    expect(['2', ' 30 ', '1.5', 'auto', 'AUTO', '', '0', '1441', 'soon', undefined].map(core.ttlOverrideOf)).toEqual([2, 30, 1.5, 'auto', 'auto', null, null, null, null, null])

    const forced = core.withTtl(config, 2)

    expect([forced.ttl, core.withTtl(core.configOf({ ttl: 30 }), 'auto').ttl, core.withTtl(config, null)]).toEqual([2, 'auto', config])
    expect(core.cacheView(measured(T0), T0 + M, forced)).toMatchObject({ state: 'warning', expiresAt: T0 + 2 * M, ttlLabel: '2m', source: 'override' })
  })
})

describe('the transcript, for a resumed session', () => {
  test('the last request started at the entry it answered, not when its reply was written', () => {
    const text = transcript([
      user(T0 - 10 * M),
      reply(T0 - 9 * M, 'msg_a', usage1h(100_000, 5000)),
      user(T0),
      { type: 'attachment', timestamp: new Date(T0 + 5).toISOString() },
      reply(T0 + 40_000, 'msg_b', usage1h(105_000, 2000)),
      reply(T0 + 40_002, 'msg_b', usage1h(105_000, 2000)),
      reply(T0 + 41_000, 'msg_b', usage1h(105_000, 2000)),
      { type: 'last-prompt' },
    ])

    expect(core.cacheFromTranscript(text, true)).toEqual({
      observed: true,
      lastAt: T0,
      ttl: '1h',
      source: 'transcript',
      recacheTokens: 2 + 105_000 + 2000,
      model: 'claude-opus-5-5',
    })
  })

  test('a reply that wrote nothing keeps the TTL of the one before; a subagent reply is not the main thread', () => {
    const text = transcript([
      user(T0 - 2 * M),
      reply(T0 - M, 'msg_a', { input_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 } }),
      user(T0),
      reply(T0 + 1000, 'msg_b', { input_tokens: 1, cache_read_input_tokens: 9300, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }),
      user(T0 + 2000, { isSidechain: true }),
      reply(T0 + 3000, 'msg_side', usage1h(1, 1), { isSidechain: true }),
    ])
    const facts = core.cacheFromTranscript(text, true)

    expect([facts?.ttl, facts?.lastAt]).toEqual(['5m', T0])
  })

  test('a tail that starts mid-line, and a transcript with no reply yet', () => {
    const earlier = JSON.stringify(user(T0 - 5 * M))
    const whole = transcript([user(T0 - 5 * M), user(T0), reply(T0 + 500, 'msg_a', usage1h(10, 10))])

    // The tail cut the first line in half: it is skipped, and the line after it is read.
    expect(core.cacheFromTranscript(whole.slice(earlier.length / 2), false)?.lastAt).toBe(T0)
    expect(core.cacheFromTranscript(transcript([user(T0)]), true)).toBe(null)
    expect(core.cacheFromTranscript('', true)).toBe(null)
  })

  test('a reply that read and wrote nothing means caching was off', () => {
    const facts = core.cacheFromTranscript(transcript([user(T0), reply(T0 + 1, 'm', { input_tokens: 500, output_tokens: 3 })]), true)

    expect([facts?.observed, facts?.lastAt]).toEqual([false, null])
  })
})

describe('settings', () => {
  test('a bad field falls back to its default, the rest is kept', () => {
    expect(core.configOf({ ttl: 'soon', warnMinutes: 10, notify: 'yes', statusLine: 'always' })).toEqual({ ...core.DEFAULT_CONFIG, warnMinutes: 10, statusLine: 'always' })
  })

  test('/cache-keeper edits one setting, refuses nonsense, and reports status', () => {
    const forced = core.configEdit(config, 'ttl 45')

    expect('config' in forced && forced.config.ttl).toBe(45)
    expect('config' in core.configEdit(config, 'TTL Auto') && (core.configEdit(config, 'ttl auto') as { config: { ttl: unknown } }).config.ttl).toBe('auto')
    expect('error' in core.configEdit(config, 'ttl 0')).toBe(true)
    expect('error' in core.configEdit(config, 'warp 9')).toBe(true)
    expect(core.configEdit(config, '')).toEqual({ action: 'status' })
    expect(core.configEdit(config, 'test-notify')).toEqual({ action: 'test-notify' })
    expect(core.configEdit(config, 'Handoff')).toEqual({ action: 'handoff' })
    expect([core.configEdit(config, 'latest'), core.configEdit(config, 'PACK')]).toEqual([{ action: 'latest' }, { action: 'pack' }])
    expect(core.CONFIG_USAGE).toContain('/cache-keeper handoff')
    expect(core.CONFIG_USAGE).toContain('/cache-keeper pack')
    expect((core.configEdit(config, 'notify off') as { config: { notify: boolean } }).config.notify).toBe(false)
    expect((core.configEdit(config, 'brief send') as { config: { brief: string } }).config.brief).toBe('send')
  })

  test('the cold-send guard holds at 150k by default; /cache-keeper hold takes tokens, 150k, 1.5m or off', () => {
    const hold = (args: string) => (core.configEdit(config, args) as { config?: { holdColdAt: number } }).config?.holdColdAt

    expect(config.holdColdAt).toBe(150_000)
    expect([hold('hold 200000'), hold('hold 80k'), hold('hold 1.5M'), hold('hold 250_000'), hold('hold off')]).toEqual([200_000, 80_000, 1_500_000, 250_000, 0])
    expect(['hold', 'hold 500', 'hold lots', 'hold -5', 'hold 2e9'].map(args => 'error' in core.configEdit(config, args)), 'nonsense, and under 1000').toEqual([true, true, true, true, true])
    expect([core.configOf({ holdColdAt: 0 }).holdColdAt, core.configOf({ holdColdAt: 90_000 }).holdColdAt, core.configOf({ holdColdAt: -1 }).holdColdAt, core.configOf({ holdColdAt: '9' }).holdColdAt]).toEqual([0, 90_000, 150_000, 150_000])
    expect([core.tokensOf('1000'), core.tokensOf(' 150K '), core.tokensOf('off'), core.tokensOf('0'), core.tokensOf('1,000'), core.tokensOf('x'), core.tokensOf(undefined)]).toEqual([1000, 150_000, 0, 0, 1000, null, null])
    expect(core.CONFIG_USAGE).toContain('/cache-keeper hold <tokens>|off')
  })
})

describe('the cold-send guard', () => {
  const SID = '00000000-0000-4000-8000-000000000001'
  /** A session whose cache went cold an hour ago, a re-read of 400k tokens: $3.20 at the 1-hour write rate. */
  const coldView = () => {
    const snapshot = core.snapshotOfStatusLine(
      {
        session_id: SID,
        model: { id: 'claude-opus-5-5' },
        prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 },
        context_window: { total_input_tokens: 400000, context_window_size: 1_000_000 },
      },
      null,
      T0,
    )

    return core.viewOf(snapshot, T0 + 2 * H, config)
  }

  test("CACHE_KEEPER_ASSUME_COLD: a warm cache counts as cold, and the strip says it is assumed", () => {
    const snapshot = core.snapshotOfStatusLine({ session_id: 's', model: { id: 'claude-opus-5-5' }, prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 } }, null, T0)
    const assumed = core.viewOf(snapshot, T0 + 10 * M, config, { assumeCold: true })

    expect([core.viewOf(snapshot, T0 + 10 * M, config).cache.state, assumed.cache.state, assumed.cache.isAssumedCold]).toEqual(['warm', 'cold', true])
    expect(core.segmentsOf(assumed, T0 + 10 * M, { seconds: true }).map(s => s.text)).toContain('○ cache cold (assumed)')
    expect(
      core.segmentsOf(assumed, T0 + 10 * M, { seconds: true }).map(s => s.id),
      'no time: "since" the measured expiry would be one still ahead',
    ).not.toContain('expiry')
  })

  test('the newest token figure: the reading taken later, the snapshot on a tie, and a reading without one gives none', () => {
    const at = T0 + 5 * M
    const snapshot = core.snapshotOfStatusLine(
      { session_id: 's', model: { id: 'claude-opus-5-5' }, prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 100_000 } },
      null,
      at,
    )
    const before = core.snapshotOfStatusLine({ session_id: 's', model: { id: 'claude-opus-5-5' }, context_window: { total_input_tokens: 0 } }, null, at)

    expect(core.usageTokens({ context: { tokens: 22_048, window: 1_000_000 } })).toBe(22_048)
    expect(core.usageTokens({ context: { window: 1_000_000 } }), 'before the first response').toBe(null)
    expect(core.newestTokens(snapshot, null)).toEqual({ tokens: 100_000, source: 'statusline', at })
    expect(core.newestTokens(snapshot, { tokens: 400_000, at: at + 1 }), 'read later').toEqual({ tokens: 400_000, source: 'usage', at: at + 1 })
    expect(core.newestTokens(snapshot, { tokens: 400_000, at: at - 1 }).tokens, 'read before the status line ran').toBe(100_000)
    expect(core.newestTokens(snapshot, { tokens: 400_000, at }).tokens, 'a tie').toBe(100_000)
    expect(core.newestTokens(before, { tokens: 22_048, at: at - 1 }).tokens, 'the snapshot has no figure: the older reading has one').toBe(22_048)
    expect(core.newestTokens(before, null)).toEqual({ tokens: null, source: null, at: null })
    expect(core.usd(core.viewOf(snapshot, T0 + 2 * H, config, { usage: { tokens: 400_000, at: at + 1 } }).next?.cold ?? 0), 'the cost goes by the newest figure').toBe('$3.20')
  })

  test("the person's own words: typed, or sent from Remote Control; nothing a plugin, a peer or a notification sends", () => {
    expect([undefined, { kind: 'composer' }, { kind: 'bridge' }].map(core.isPersonOrigin)).toEqual([true, true, true])
    expect([{ kind: 'plugin', name: 'x' }, { kind: 'task-notification' }, { kind: 'peer' }, { kind: 'channel' }, 'composer'].map(core.isPersonOrigin)).toEqual([false, false, false, false, false])
  })

  test('why it was held: the tokens, the strip\'s price, Enter again, and the ways that carry it', () => {
    const view = coldView()
    const both = core.heldReason(view, { kind: 'prompt', ways: [['Use Latest Handoff', '/use-latest-handoff'], ['Pack & Clear', '/pack-and-clear']] })

    expect(both).toBe(
      'Cache Keeper held this message: the prompt cache is cold, so sending it would read 400k tokens again uncached (next msg $3.20). It is back in the prompt: Enter sends it anyway. Use Latest Handoff (/use-latest-handoff) or Pack & Clear (/pack-and-clear) carries it to a fresh session instead.',
    )
    expect(core.heldReason(view, { kind: 'answer', ways: [] })).toContain('Cache Keeper held your answer:')
    expect(core.heldReason(view, { kind: 'answer', ways: [] }), 'no way without a model call').toContain('Handoff & Clear (/cache-keeper handoff) asks Claude for a brief at about that price')
    expect(core.heldReason(view, { kind: 'prompt', ways: [], attachments: 2 })).toContain('The 2 images or files attached to it are not kept: attach them again.')
    expect(core.heldReason(view, { kind: 'prompt', ways: [['Pack & Clear', '/pack-and-clear']], attachments: 1 })).toContain(
      'Pack & Clear (/pack-and-clear) carries it to a fresh session instead. The image or file attached to it is not kept: attach it again.',
    )
    expect([core.attachmentsNote(0), core.attachmentsNote(1)]).toEqual(['', 'The image or file attached to it is not kept: attach it again.'])
  })

  test('what Enter and the ways read back: this session\'s held text, never another\'s, nor a used one', () => {
    const held = { v: 1, sid: SID, kind: 'answer', text: 'My answer', at: T0, attachments: 0 }

    expect(core.heldOf(held, SID)).toEqual(held)
    expect(core.heldOf({ ...held, kind: 'odd' }, SID)?.kind).toBe('prompt')
    expect([core.heldOf(held, 'another'), core.heldOf(held, null), core.heldOf({ v: 1, sid: SID, used: T0 }, SID), core.heldOf({ ...held, text: '  ' }, SID), core.heldOf(null, SID)]).toEqual([null, null, null, null, null])
  })

  test("an answer to Claude's question as a message: each question with what was chosen, and the person's own words", () => {
    const questions = [
      { question: 'Which date library?', header: 'Library', multiSelect: false, options: [{ label: 'date-fns' }, { label: 'Luxon' }] },
      { question: 'Which checks run?', header: 'Checks', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] },
      { question: 'Ship today?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
    ]
    const text = core.answerText(questions, {
      questions,
      answers: { 'Which date library?': 'date-fns', 'Which checks run?': 'lint, types' },
      annotations: { 'Which date library?': { notes: 'smaller bundle' } },
      response: 'and keep the old API',
    })

    expect(text).toBe(
      [
        'My answer to its questions:',
        '- Which date library?',
        '  date-fns',
        '  Note: smaller bundle',
        '- Which checks run?',
        '  lint, types',
        '- Ship today?',
        '  (no answer chosen)',
        'In my own words: and keep the old API',
      ].join('\n'),
    )
    expect(core.answerText([questions[0]], { answers: { 'Which date library?': 'Luxon' }, followUp: true })).toBe('My answer to its question:\n- Which date library?\n  Luxon\nI also asked for another round of questions.')
    expect(core.answerText(undefined, { answers: { 'Free text?': 'yes' } }), 'an answer to a question the call no longer names').toBe('My answer to its question:\n- Free text?\n  yes')
  })

  test("an answer is something the person gave: a choice, their own words, or another round; a dialog closed empty is none", () => {
    expect([
      core.isAnswer({ answers: { 'Ship today?': 'Yes' } }),
      core.isAnswer({ answers: {}, response: 'later' }),
      core.isAnswer({ answers: {}, followUp: true }),
      core.isAnswer({ answers: { 'How many?': 3 } }),
    ]).toEqual([true, true, true, true])
    expect([core.isAnswer({ answers: {} }), core.isAnswer({ answers: { 'Ship today?': '  ' }, response: ' ' }), core.isAnswer(null), core.isAnswer('Yes')]).toEqual([false, false, false, false])
  })

  test('the fresh prompt: the pointer, then the held text, then a draft that is neither', () => {
    expect(core.carriedText('Continue from X.\n', 'my answer\n\n', '')).toBe('Continue from X.\n\nmy answer')
    expect(core.carriedText('Continue from X.\n', 'my answer', 'my answer')).toBe('Continue from X.\n\nmy answer')
    expect(core.carriedText('Continue from X.\n', 'my answer', 'and a draft')).toBe('Continue from X.\n\nmy answer\n\nand a draft')
    expect(core.carriedText('Continue from X.\n', null, 'a draft')).toBe('Continue from X.\n\na draft')
    expect(core.carriedText('Continue from X.\n', null, '')).toBe('Continue from X.\n')
  })

  test('the strip marks what is held, after the price, before all but the cache on a narrow terminal', () => {
    const segments = core.segmentsOf(coldView(), T0 + 2 * H, { seconds: true })
    const marked = core.withHeld(segments, { v: 1, sid: SID, kind: 'prompt', text: 'x', at: T0, attachments: 0 })
    const ids = marked.map(s => s.id)

    expect(ids.indexOf('held')).toBe(ids.indexOf('next') + 1)
    expect(marked.find(s => s.id === 'held')).toEqual({ id: 'held', text: 'message held', tone: 'warn', priority: 95 })
    expect(core.withHeld(segments, null)).toBe(segments)
    expect(core.withHeld(segments, { v: 1, sid: SID, kind: 'answer', text: 'x', at: T0, attachments: 0 }).find(s => s.id === 'held')?.text).toBe('answer held')
  })

  test("the line under Claude's open question says what answering does once the cache is cold", () => {
    expect(core.questionNotice(coldView())).toBe(
      'Cache Keeper: the cache went cold, so your answer will be held, not read (that would read 400k tokens again, $3.20). Then Enter sends it here, or a button on the strip carries it to a fresh session.',
    )
  })
})

describe('the strip', () => {
  const seg = (id: string, text: string, priority: number, glue = false) => ({ id, text, tone: 'plain' as const, priority, ...(glue && { glue }) })

  test('a narrow strip drops the lowest priority first, and a detail goes with what it details', () => {
    const segments = [seg('a', 'aaaa', 100), seg('a+', 'x', 10, true), seg('b', 'bbbb', 50), seg('c', 'cccc', 90)]

    expect(core.fit(segments, 100, 3).map(s => s.id)).toEqual(['a', 'a+', 'b', 'c'])
    expect(core.fit(segments, 15, 3).map(s => s.id)).toEqual(['a', 'c'])
    expect(core.fit([seg('b', 'bbbb', 50), seg('b+', 'y', 99, true)], 3, 3).map(s => s.id), 'a detail never stands alone').toEqual(['b'])
    expect(core.lineWidth([seg('a', 'aaaa', 1), seg('a+', 'x', 1, true), seg('b', 'bb', 1)], 3)).toBe(4 + 1 + 1 + 3 + 2)
  })

  test("every fact the strip promises is in it, at a terminal's width", () => {
    const snapshot = core.snapshotOfStatusLine(
      {
        session_id: 's',
        model: { id: 'claude-opus-5-5' },
        prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 },
        context_window: { total_input_tokens: 400000, context_window_size: 1_000_000 },
        rate_limits: { five_hour: { used_percentage: 25, resets_at: (T0 + 2 * H) / 1000 }, seven_day: { used_percentage: 90, resets_at: (T0 + 72 * H) / 1000 } },
        cost: { total_cost_usd: 12.5 },
      },
      null,
      T0,
    )
    const segments = core.segmentsOf(core.viewOf(snapshot, T0 + 12 * M + 48_000, config), T0, { seconds: true })
    const text = segments.map(s => s.text).join(' ')

    expect(text).toContain('● cache 47:12')
    expect(text).toContain('next msg $0.08, cold $3.20')
    expect(text).toContain('ctx 400k')
    expect(text).toContain('/1M')
    expect(text).toContain('5h 25%')
    expect(text).toContain('wk 90%')
    expect(text).toContain('session $12.50 API')
    expect(segments.find(s => s.id === '7d')?.tone, '90% of the week is a warning').toBe('bad')
  })
})

describe('account limits', () => {
  const opts = { pollMs: 60_000, me: 'sess-a', jitterMs: 0 }

  test("the usage endpoint's answer: both windows, microsecond times, and a model's own weekly limit", () => {
    const read = core.limitsOfUsage(USAGE_BODY)

    expect(read?.fiveHour).toEqual({ pct: 40, resetsAt: Date.parse('2026-10-28T15:00:00.250Z') })
    expect(read?.sevenDay).toEqual({ pct: 70, resetsAt: Date.parse('2026-11-01T09:00:00.250Z') })
    expect(read?.scoped).toEqual([{ name: 'Fable', pct: 95, resetsAt: Date.parse('2026-11-01T08:59:59.512Z') }])
    expect(core.limitsOfUsage({ five_hour: null, seven_day: null }), 'no window, no reading').toBe(null)
    expect(core.limitsOfUsage('nonsense')).toBe(null)
  })

  test("a response's windows, as session.measure hands them over", () => {
    const windows = core.windowsOfRateLimits([
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-28T15:00:00Z' },
      { kind: 'seven_day', percentUsed: 80 },
      { kind: 'spend_limit', percentUsed: 5 },
    ])

    expect(windows).toEqual({ fiveHour: { pct: 42.5, resetsAt: Date.parse('2026-10-28T15:00:00Z') }, sevenDay: { pct: 80, resetsAt: null } })
  })

  test('one session polls at a time: last asked, a claim, a backoff, and off', () => {
    const asked = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-b', T0)

    expect(core.isPollDue(null, T0, opts), 'nothing read yet').toBe(true)
    expect(core.isPollDue(asked, T0 + 59_000, opts), 'asked a minute ago, by anyone').toBe(false)
    expect(core.isPollDue(asked, T0 + 60_000, opts)).toBe(true)
    expect(core.isPollDue(asked, T0 + 60_000, { ...opts, jitterMs: 4000 }), 'a later session waits its jitter out').toBe(false)
    expect(core.isPollDue(core.claimed(asked, 'sess-b', T0 + 60_000), T0 + 61_000, opts), "another session's claim").toBe(false)
    expect(core.isPollDue(core.claimed(asked, 'sess-a', T0 + 60_000), T0 + 61_000, opts), 'its own claim').toBe(true)
    expect(core.isPollDue(core.claimed(asked, 'sess-b', T0 + 60_000), T0 + 60_000 + core.CLAIM_MS, opts), 'a claim lapses').toBe(true)
    expect(core.isPollDue(null, T0, { ...opts, pollMs: 0 }), 'off').toBe(false)

    const failed = core.pollFailed(asked, 'sess-a', T0 + 60_000, 'HTTP 429', 60_000)

    expect([failed.failures, failed.backoffUntil - (T0 + 60_000), failed.error]).toEqual([1, 60_000, 'HTTP 429'])
    expect(failed.sevenDay, 'a failure keeps what was read').toEqual(asked.sevenDay)
    expect(core.isPollDue(failed, T0 + 119_000, opts), 'everyone backs off').toBe(false)

    let worse = failed

    for (let i = 0; i < 8; i++) worse = core.pollFailed(worse, 'sess-a', T0, 'HTTP 503', 60_000)

    expect(worse.backoffUntil - T0, 'doubling, up to 30 min').toBe(30 * M)
    expect(core.polled(worse, core.limitsOfUsage(USAGE_BODY)!, 'sess-a', T0).failures, 'an answer resets it').toBe(0)
  })

  test("a response's reading is newest, and keeps the scoped limit no header carries", () => {
    const asked = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-b', T0)
    const after = core.measured(asked, { fiveHour: { pct: 90, resetsAt: null }, sevenDay: null }, T0 + 5000)!

    expect([after.source, after.at, after.fiveHour?.pct, after.sevenDay?.pct, after.scoped?.[0]?.pct]).toEqual(['response', T0 + 5000, 90, 70, 95])
    expect(core.accountOf(JSON.parse(JSON.stringify(after))), 'what limits.json holds reads back the same').toEqual(after)
    expect(core.accountOf({ v: 2 })).toBe(null)
  })

  test("a response that trails the file's reading changes nothing: within one window the higher figure stands", () => {
    // A response's headers leave the server when its request starts, so after a long turn they trail
    // what the endpoint read since. The headers' whole seconds against the endpoint's microseconds
    // are one window.
    const asked = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-b', T0)
    const header = (pct: number, iso: string) => ({ pct, resetsAt: Date.parse(iso) })

    expect(core.measured(asked, { fiveHour: header(39, '2026-10-28T15:00:00Z'), sevenDay: header(69, '2026-11-01T09:00:00Z') }, T0 + 5000), 'both behind').toBe(null)

    const moved = core.measured(asked, { fiveHour: header(41, '2026-10-28T15:00:00Z'), sevenDay: header(69, '2026-11-01T09:00:00Z') }, T0 + 5000)

    expect([moved?.fiveHour?.pct, moved?.sevenDay?.pct, moved?.at, moved?.source], 'the one ahead is taken, the one behind kept').toEqual([41, 70, T0 + 5000, 'response'])
    expect(core.measured(asked, { fiveHour: header(40, '2026-10-28T15:00:00Z'), sevenDay: null }, T0 + 5000)?.at, 'the same figure: confirmed now').toBe(T0 + 5000)
  })

  test('a window that has ended gives way to the next, a late reading from it is dropped, and another login replaces', () => {
    const asked = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-b', T0)
    const afterReset = Date.parse('2026-10-28T15:01:00Z')
    const next = core.measured(asked, { fiveHour: { pct: 5, resetsAt: Date.parse('2026-10-28T20:00:00Z') }, sevenDay: null }, afterReset)

    expect(next?.fiveHour?.pct, 'the next window, from 5%').toBe(5)
    expect(core.measured(next, { fiveHour: { pct: 60, resetsAt: Date.parse('2026-10-28T15:00:00Z') }, sevenDay: null }, afterReset + 5000), 'a long turn from before the reset').toBe(null)

    // A login whose week ends sooner than the old one's, which has not ended.
    const switched = core.measured(asked, { fiveHour: null, sevenDay: { pct: 0, resetsAt: Date.parse('2026-10-30T10:00:00Z') } }, T0 + M)

    expect(switched?.sevenDay?.pct).toBe(0)
  })

  test("a model's own limit is as old as the endpoint's last answer, however fresh the responses keep the rest", () => {
    const own = core.snapshotOfStatusLine({ session_id: 's', rate_limits: { five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 30 } } }, null, T0)
    const asked = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-b', T0)
    const failing = core.pollFailed(asked, 'sess-b', T0 + 20 * M, 'HTTP 503', 60_000)
    const late = core.measured(failing, { fiveHour: { pct: 60, resetsAt: Date.parse('2026-10-28T15:00:00Z') }, sevenDay: null }, T0 + 29 * M)!
    const shownAt = (now: number) => core.withAccountLimits(own, late, now).limits

    expect([shownAt(T0 + 29 * M).fiveHour?.pct, shownAt(T0 + 29 * M).scoped?.[0]?.pct], 'through a failed poll, while the answer is young').toEqual([60, 95])
    expect([shownAt(T0 + 31 * M).fiveHour?.pct, shownAt(T0 + 31 * M).scoped], 'the answer is 31 min old: the response stands, Fable goes').toEqual([60, null])

    // A record 0.2.0 wrote has no answeredAt: its last poll answered where it holds no error.
    const legacy = JSON.parse(JSON.stringify(asked))

    delete legacy.answeredAt
    expect(core.accountOf(legacy)?.answeredAt).toBe(T0)
    expect(core.accountOf({ ...legacy, error: 'HTTP 503' })?.answeredAt).toBe(null)
  })

  test("another login's reading is not this session's: the weekly window tells them apart while its own is live", () => {
    // An idle session can hold the token a /login replaced: its poll writes the old login's week,
    // which ends hours away from the new login's.
    const oldLogin = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-old', T0)
    const newWeek = Date.parse('2026-11-01T13:00:00Z')
    const ownOf = (weekEnds: number) => core.snapshotOfStatusLine({ session_id: 's', rate_limits: { five_hour: { used_percentage: 15 }, seven_day: { used_percentage: 5, resets_at: weekEnds / 1000 } } }, null, T0)
    const newLogin = ownOf(newWeek)

    expect(core.accountFit(newLogin, oldLogin, T0 + M)).toBe('another-login')
    expect(core.withAccountLimits(newLogin, oldLogin, T0 + M), 'its own figures stand').toBe(newLogin)
    expect(core.accountFit(ownOf(Date.parse('2026-11-01T09:00:00Z')), oldLogin, T0 + M), "the old login's own session: the endpoint's microseconds, the same week").toBe('applies')

    // Its own week has ended: nothing tells the logins apart any more, so the reading stands in.
    const later = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-old', newWeek + M)

    expect(core.accountFit(newLogin, later, newWeek + 2 * M)).toBe('applies')
    expect(core.accountFit(newLogin, oldLogin, T0 + 31 * M), 'too old, whoever it is').toBe('stale')
  })

  test('a model-scoped limit stands only beside the week it was read in', () => {
    // The old login's poll, then a new login's response that brings its own week: the old login's
    // model limit must not stay beside it.
    const oldLogin = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-old', T0)
    const newWeek = Date.parse('2026-11-01T13:00:00Z')
    const mixed = core.measured(oldLogin, { fiveHour: { pct: 16, resetsAt: Date.parse('2026-10-29T00:00:00Z') }, sevenDay: { pct: 6, resetsAt: newWeek } }, T0 + M)!
    const ownOf = (pct: number, weekEnds: number) => core.snapshotOfStatusLine({ session_id: 's', rate_limits: { seven_day: { used_percentage: pct, resets_at: weekEnds / 1000 } } }, null, T0)
    const shown = core.withAccountLimits(ownOf(6, newWeek), mixed, T0 + 2 * M).limits

    expect([shown.sevenDay?.pct, shown.scoped], "the new login's week, without the old one's Fable").toEqual([6, []])

    const sameWeek = core.measured(oldLogin, { fiveHour: null, sevenDay: { pct: 72, resetsAt: Date.parse('2026-11-01T09:00:00Z') } }, T0 + M)!
    const kept = core.withAccountLimits(ownOf(72, Date.parse('2026-11-01T09:00:00Z')), sameWeek, T0 + 2 * M).limits

    expect(kept.scoped?.[0]?.name, 'the same week keeps it: Fable resets at 08:59:59.512 beside 09:00:00.250').toBe('Fable')
  })

  test("an idle session shows the account's reading in place of its own last response", () => {
    const own = core.snapshotOfStatusLine({ session_id: 's', rate_limits: { five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 30 } } }, null, T0)
    const account = core.polled(null, core.limitsOfUsage(USAGE_BODY)!, 'sess-b', T0 + 10 * M)

    const shown = core.withAccountLimits(own, account, T0 + 11 * M)

    expect([shown.limits.fiveHour?.pct, shown.limits.sevenDay?.pct, shown.limits.scoped?.[0]?.name]).toEqual([40, 70, 'Fable'])
    expect(core.withAccountLimits(own, account, T0 + 10 * M + core.ACCOUNT_MAX_AGE_MS + 1), 'too old: its own again').toBe(own)

    const noWindows = core.snapshotOfStatusLine({ session_id: 's' }, null, T0)

    expect(core.withAccountLimits(noWindows, account, T0 + 11 * M), 'no sign of a subscription').toBe(noWindows)
    expect(core.withAccountLimits(noWindows, account, T0 + 11 * M, { isSubscription: true }).limits.sevenDay?.pct, 'a bearer, before its first response').toBe(70)

    const segments = core.segmentsOf(core.viewOf(shown, T0 + 11 * M, config), T0 + 11 * M, { seconds: true })

    expect(segments.map(s => s.text).join(' ')).toContain('wk 70%')
    const fable = segments.find(s => s.id === 'scoped:Fable')

    expect([fable?.text, fable?.tone]).toEqual(['Fable 95%', 'bad'])
  })

  test('/cache-keeper limits: off, a period, and nonsense', () => {
    expect(config.limitsPollSeconds).toBe(60)
    expect((core.configEdit(config, 'limits off') as { config: { limitsPollSeconds: number } }).config.limitsPollSeconds).toBe(0)
    expect((core.configEdit(config, 'limits 30') as { config: { limitsPollSeconds: number } }).config.limitsPollSeconds).toBe(30)
    expect('error' in core.configEdit(config, 'limits 5'), 'not faster than every 15 s').toBe(true)
    expect(core.configOf({ limitsPollSeconds: 0 }).limitsPollSeconds).toBe(0)
    expect(core.configOf({ limitsPollSeconds: 2 }).limitsPollSeconds).toBe(60)
  })
})

describe('the notification', () => {
  test('Windows: one fixed command text whatever the notice says, the texts in its environment, nothing encoded', () => {
    const notice = { title: `It's "quoted" ' $(rm -rf) · ü`, body: 'body; `backtick` $env:X', tag: 'sess-1:2' }
    const toast = core.notifyArgv('win32', notice)!
    const other = core.notifyArgv('win32', { title: 'another', body: 'notice', tag: 'x' })!
    const line = toast.argv.join(' ')

    expect(toast.argv).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', core.TOAST_SCRIPT])
    expect(other.argv, 'the same command line for every notice').toEqual(toast.argv)
    expect(toast.env).toEqual({ CACHE_KEEPER_TOAST_TITLE: notice.title, CACHE_KEEPER_TOAST_BODY: notice.body, CACHE_KEEPER_TOAST_TAG: 'sess-12' })
    expect(line).not.toMatch(/EncodedCommand|ExecutionPolicy|Bypass|Base64/i)
    expect(line).not.toContain('rm -rf')
    expect(core.TOAST_SCRIPT, 'no double quote for a command line to re-split').not.toContain('"')
    expect(core.TOAST_SCRIPT, 'no cmdlet: a PowerShell 7 module path cannot break it').not.toMatch(/New-Object|Add-Type|Import-Module/)
    expect(core.TOAST_SCRIPT).toContain('$env:CACHE_KEEPER_TOAST_TITLE')
    expect(core.notifyArgv('win32', { title: 't', body: 'b', tag: '::' })?.env.CACHE_KEEPER_TOAST_TAG, 'a tag with nothing left').toBe('cache-keeper')
  })

  test('macOS and Linux take the texts as arguments', () => {
    expect(core.notifyArgv('darwin', { title: 't', body: 'b' })?.argv.slice(-2)).toEqual(['t', 'b'])
    expect(core.notifyArgv('linux', { title: 't', body: 'b' })).toEqual({ argv: ['notify-send', '--app-name=Claude Code', 't', 'b'], env: {} })
    expect(core.notifyArgv('aix', { title: 't', body: 'b' })).toBe(null)
  })

  test('the warning names the session, the time left and the price of letting it go cold', () => {
    const snapshot = core.snapshotOfStatusLine(
      { session_id: 's', session_name: 'my-project', model: { id: 'claude-opus-5-5' }, prompt_cache: { ttl: '1h', expires_at: (T0 + H) / 1000, caching_observed: true, recache_tokens_if_cold: 400000 } },
      null,
      T0,
    )
    const notice = core.warningNotice(core.viewOf(snapshot, T0 + 55 * M, config))

    expect(notice.title).toBe('Cache goes cold in 5 min · my-project')
    expect(notice.body).toContain('next message $0.08 now, $3.20 once cold')
  })
})

describe('the brief', () => {
  test('taken from between the tags, or the whole answer, but not from a one-liner', () => {
    expect(core.briefOf('Sure.\n<handoff>\n## Goal\nShip the strip above the prompt.\n</handoff>\nDone')).toBe('## Goal\nShip the strip above the prompt.')
    expect(core.briefOf('## Goal\nShip the strip above the prompt, with its countdown.')).toBe('## Goal\nShip the strip above the prompt, with its countdown.')
    expect(core.briefOf('ok')).toBe(null)
    expect(core.briefOf(undefined)).toBe(null)
  })

  test('the pasted text says where it came from; the saved file sorts by time', () => {
    const text = core.pastedBrief('## Goal\nx', { sessionName: 'my-project', sessionId: '00000000-0000', at: T0 })

    expect(text.startsWith('Continue from this handoff brief, written by my previous session (my-project, 2026-10-28 12:00 UTC')).toBe(true)
    expect(text).toContain('## Goal\nx')
    expect(core.briefFileName(T0, '00000000-0000-4000')).toBe('20261028-120000-00000000.md')
    expect(core.handoffPrompt().startsWith(core.HANDOFF_MARK)).toBe(true)
  })
})

describe('once the cache is cold', () => {
  const ROOT = 'C:/Users/t/.claude'
  const SID = '00000000-0000-4000-8000-000000000001'
  const HANDOFF = `${ROOT}/handoffs/my-project/2026-10-28-1130-ship-the-strip.md`
  const from = { sessionName: 'my-project', sessionId: SID, at: T0 }

  /** handoff-guard's record of a session (`handoff-guard/live/<sid>.json`), current unless a test says otherwise. */
  const record = (extra: Record<string, unknown> = {}, track: Record<string, unknown> = {}) => ({
    v: 1,
    sid: SID,
    role: null,
    upToDate: true,
    endedAt: null,
    track: { workAt: T0 - 40 * M, handoffAt: T0 - 30 * M, handoffPath: HANDOFF, turnsAfter: 0, ...track },
    ...extra,
  })

  test('a handoff document, by where it is and what it is named; a side note in the same folder is not one', () => {
    const kinds = [
      HANDOFF,
      `${ROOT}\\handoffs\\my-project\\20261028-1130-notes.md`,
      `${ROOT}/handoffs/my-project/release-handoff.md`,
      `${ROOT}/handoffs/my-project/draft-12.md`,
      `${ROOT}/handoffs/my-project/acct/2026-10-28-1030-pack-ffffffff.md`,
      `${ROOT}/handoffs/my-project/2026-10-28-1130-x.txt`,
      `${ROOT}/hub/h1/hub-handoff.md`,
      `${ROOT}/hub/h1/handoff-g3.md`,
      `${ROOT}/hub/h1/notes.md`,
      `${ROOT}/autohandoff/briefs/20261028-113000-00000000.md`,
      `${ROOT}/cache-keeper/handoffs/20261028-113000-ffffffff.md`,
      'C:/dev/x/handoffs/2026-10-28-1130-x.md',
    ].map(path => core.handoffDocKind(path, SID))

    expect(kinds).toEqual(['yes', 'yes', 'yes', 'heading', 'no', 'no', 'yes', 'yes', 'no', 'yes', 'no', 'no'])
    expect(core.HANDOFF_HEADING.test('# Handoff: Cache Keeper\n')).toBe(true)
    expect(core.HANDOFF_HEADING.test('\uFEFF# Session hand-off\n')).toBe(true)
    expect(core.HANDOFF_HEADING.test('## Summary\nThe handoff is below.')).toBe(false)
    expect([core.hubOf(`${ROOT}/hub/h1/hub-handoff.md`), core.hubOf(`${ROOT}\\hub\\h2\\hub-handoff.md`), core.hubOf(`${ROOT}/hub/h1/handoff-g3.md`)]).toEqual(['h1', 'h2', null])
  })

  test('the latest handoff: current, or why there is none to go on from', () => {
    expect(core.latestHandoff(record(), SID)).toEqual({ path: HANDOFF, at: T0 - 30 * M, hub: null, check: false })
    expect(core.latestHandoff(record({}, { handoffPath: `${ROOT}\\hub\\h1\\hub-handoff.md` }), SID)).toEqual({ path: `${ROOT}/hub/h1/hub-handoff.md`, at: T0 - 30 * M, hub: 'h1', check: false })
    expect((core.latestHandoff(record({}, { handoffPath: `${ROOT}/handoffs/my-project/draft-12.md` }), SID) as { check: boolean }).check).toBe(true)

    const why = (r: unknown, sid: string | null = SID) => (core.latestHandoff(r, sid) as { why?: string }).why

    expect(why(null)).toBe('handoff-guard keeps no record of this session')
    expect(why(record(), 'another-session')).toBe('handoff-guard keeps no record of this session')
    expect(why(record({ v: 2 }))).toBe('handoff-guard keeps no record of this session')
    expect(why(record({ role: 'worker' }))).toBe("a hub worker's handoff is its hub's to use")
    expect(why(record({ endedAt: T0 }))).toBe('its handoff-guard record says the session ended')
    expect(why(record({}, { handoffPath: null }))).toBe('the session has written no handoff')
    expect(why(record({ upToDate: false }, { turnsAfter: 1 }))).toBe('the session did more work after its last handoff (1 turn since 2026-10-28-1130-ship-the-strip.md)')
    expect(why(record({ upToDate: false }, { turnsAfter: 3 }))).toContain('(3 turns since')
    expect(why(record({}, { handoffPath: `${ROOT}/handoffs/my-project/acct/2026-10-28-1030-x.md` }))).toBe('the newest file it wrote among the handoffs, 2026-10-28-1030-x.md, is not a handoff')
  })

  test('what the fresh prompt gets: a pointer that begins as a brief does, or the hub command', () => {
    const latest = core.pastedLatest({ path: HANDOFF, at: T0 - 30 * M, hub: null }, from)

    expect(latest.startsWith('Continue from this handoff brief, written by my previous session (my-project) at 2026-10-28 11:30 UTC, before its prompt cache went cold')).toBe(true)
    expect(latest).toContain(`Read ${HANDOFF} in full first, then carry on from it.`)
    expect(latest).toContain('/clear kept the process')
    expect(core.pastedLatest({ path: `${ROOT}/hub/h1/hub-handoff.md`, at: T0, hub: 'h1' }, from)).toBe('/hub resume h1\n')

    const pack = core.pastedPack(`${ROOT}/handoffs/my-project/acct/p.md`, { ...from, sessionName: null })

    expect(pack.startsWith('Continue from this handoff brief: a pack acct-sync built, without a model call, from my previous session (00000000, cleared at 2026-10-28 12:00 UTC')).toBe(true)
    expect(pack).toContain(`Read ${ROOT}/handoffs/my-project/acct/p.md in full first`)
  })

  test('acct-sync: the command, its pack, a session it does not know, and its failures in its own words', () => {
    expect(core.packArgv('C:/t/acct-sync.mjs', SID)).toEqual(['node', 'C:/t/acct-sync.mjs', 'handoff', SID, '--kind', 'clear', '--json'])
    expect(core.packOf({ exitCode: 0, stdout: 'written\n{"pack":"C:/p.md","tokens":9000}\n', stderr: '' })).toEqual({ pack: 'C:/p.md', tokens: 9000 })
    expect(core.packOf({ exitCode: 1, stdout: '', stderr: 'acct-sync: no session matches 00000000' })).toEqual({ missing: true })
    expect(core.packOf({ exitCode: 1, stdout: '', stderr: 'acct-sync: the transcript could not be read\n  at x' })).toEqual({ error: 'the transcript could not be read at x' })
    expect(core.packOf({ exitCode: 2, stdout: '', stderr: '' })).toEqual({ error: 'acct-sync ended with exit code 2' })
    expect(core.packOf(undefined)).toEqual({ error: 'acct-sync ended with exit code ?' })
  })

  describe('the engine export', () => {
    const facts = (messages: unknown[]) => ({
      messages,
      sessionId: SID,
      cwd: 'C:/dev/x',
      configDir: ROOT,
      at: T0,
      startedAt: T0 - 2 * H,
      lastTurnAt: T0 - 40 * M,
      model: 'claude-opus-5-5',
      title: 'my-project',
      why: 'Claude Code saves none for a process started from inside another Claude session',
      contextTokens: 400_000,
      handoff: { path: HANDOFF, at: T0 - 30 * M, turnsAfter: 0 },
    })
    const conversation = [
      { role: 'user', content: 'Ship the strip.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'long thoughts', signature: 'sig' },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'text', text: 'Writing it.' },
          { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'C:/dev/x/a.ts', content: 'x'.repeat(50_000) } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'y'.repeat(30_000) }, { type: 'image', source: { data: 'AAAA' } }] }, { type: 'image', source: { data: 'BBBB' } }] },
      { role: 'system', content: 'not a turn' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]

    test('whole where it fits: what acct-sync reads, without thinking or media', () => {
      const x = JSON.parse(core.engineExport(facts(conversation)))

      expect([x.kind, x.sessionId, x.cwd, x.configDir, x.exportedAt, x.title, x.trimmed]).toEqual(['cache-keeper engine export', SID, 'C:/dev/x', ROOT, T0, 'my-project', null])
      expect(x.usage).toEqual({ input_tokens: 400_000, output_tokens: 0 })
      expect(x.handoffs).toEqual([{ path: HANDOFF, at: T0 - 30 * M, turnsAfter: 0 }])
      expect(x.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(x.messages[1].content.map((b: { type: string }) => b.type)).toEqual(['text', 'tool_use'])
      expect(x.messages[1].content[1].input.content.length).toBe(50_000)
      expect(x.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'y'.repeat(30_000) }, { type: 'image' }] }, { type: 'image' }])
    })

    test('over the budget: long pieces are cut first, and the export says so', () => {
      const text = core.engineExport(facts(conversation), 20_000)
      const x = JSON.parse(text)

      expect(core.utf8Bytes(text)).toBeLessThanOrEqual(20_000)
      expect(x.messages.length).toBe(4)
      expect(x.messages[1].content[1].input.file_path).toBe('C:/dev/x/a.ts')
      expect(x.messages[1].content[1].input.content).toContain('more characters cut from the export]')
      expect(x.trimmed).toEqual({ resultChars: 4000, inputChars: 2000, textChars: 24_000, droppedMessages: 0, messages: 4, kept: 4 })
    })

    test('still over: the oldest messages go, the first and the last kept', () => {
      const many = [{ role: 'user', content: 'This session is being continued from a previous conversation. The summary.' }]

      for (let i = 0; i < 60; i += 1) {
        many.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `message ${i} ${'z'.repeat(2400)}` })
      }

      const text = core.engineExport(facts(many), 40_000)
      const x = JSON.parse(text)

      expect(core.utf8Bytes(text)).toBeLessThanOrEqual(40_000)
      expect(x.messages[0].content).toContain('The summary.')
      expect(x.messages[x.messages.length - 1].content.startsWith('message 59 ')).toBe(true)
      expect(x.trimmed.droppedMessages).toBeGreaterThan(0)
      expect(x.trimmed.droppedMessages + x.messages.length).toBe(61)
    })

    test("Claude's open question: its input whole at any budget, and no result for it, as asked and not answered", () => {
      const asked = {
        questions: [
          {
            question: 'Which date library should the export use?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'Small, tree-shakes well. '.repeat(40) },
              { label: 'Luxon', description: 'Time zones built in.' },
            ],
          },
        ],
      }
      const open = [
        { role: 'user', content: 'Ship the strip.' },
        { role: 'assistant', content: [{ type: 'text', text: 'w'.repeat(30_000) }, { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: asked }] },
        // The engine may hold a result for the call that is still open: it is left out.
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'pending' }] },
      ]
      const x = JSON.parse(core.engineExport({ ...facts(open), openQuestion: 'q1' }, 9000))
      const call = x.messages[1].content.find((b: { type: string }) => b.type === 'tool_use')

      expect(call).toEqual({ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: asked })
      expect(x.messages.length, 'the message that held only its result is gone').toBe(2)
      expect(JSON.stringify(x.messages)).not.toContain('tool_result')

      const answered = JSON.parse(core.engineExport(facts(open)))

      expect(answered.messages[2].content[0].tool_use_id, 'no open question named: kept').toBe('q1')
    })

    test('bytes as the file holds them', () => {
      expect([core.utf8Bytes('a'), core.utf8Bytes('é'), core.utf8Bytes('€'), core.utf8Bytes('😀'), core.utf8Bytes('\u0430\u0435€😀')]).toEqual([1, 2, 3, 4, 11])
    })
  })
})

describe('formatting', () => {
  test('tokens, dollars and the countdown', () => {
    expect([core.tokenLabel(412_345), core.tokenLabel(1_000_000), core.tokenLabel(1500), core.tokenLabel(950)]).toEqual(['412k', '1M', '1.5k', '950'])
    expect([core.usd(0), core.usd(0.004), core.usd(3.204), core.usd(123.4), core.usd(12_345)]).toEqual(['$0', '<$0.01', '$3.20', '$123', '$12.3k'])
    expect([core.countdown(47 * M + 12_000), core.countdown(H + 2 * M + 3000), core.countdown(-5)]).toEqual(['47:12', '1:02:03', '0:00'])
    expect([core.minutesLeft(47 * M + 59_000), core.minutesLeft(59_000)]).toEqual(['47m', '<1m'])
  })
})
