/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { Elements, RenderElement } from 'claude-code'

import { buttonsWidth as labelsWidth, fit, STRIP, textRoom, widthOf } from './core.mjs'

/** The elements the strip draws with. */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

type Segment = { id: string; text: string; tone: 'good' | 'warn' | 'bad' | 'dim' | 'plain'; priority: number; glue?: boolean; tight?: boolean }

/** One button at the strip's end. `key` is how a press names it (`$.ui.press({ plugin, key })`). */
export type StripButton = { key: string; label: string; isDim: boolean; onPress: () => void }

/** Claude Code's own theme colours, so the strip reads on a light terminal as well as a dark one. */
const TONE: Record<Segment['tone'], Record<string, unknown>> = {
  good: { color: 'success' },
  warn: { color: 'warning', bold: true },
  bad: { color: 'error', bold: true },
  dim: { dimColor: true },
  plain: {},
}

const SEPARATOR = ' · '

/** What the buttons take on screen, chrome and gaps included. */
export function buttonsWidth(buttons: readonly StripButton[]): number {
  return labelsWidth(buttons.map(b => b.label))
}

function drawButtons(kit: Kit, buttons: readonly StripButton[]): RenderElement[] {
  const { Button } = kit

  return buttons.map(button => (
    <Button key={button.key} dimColor={button.isDim} onPress={button.onPress}>
      {button.label}
    </Button>
  ))
}

/**
 * One row above the prompt: the cache countdown and what the session costs, then the buttons. The buttons have the
 * row first: the text is cut to what they leave, and left out where that is too narrow to read.
 * @param columns the band's body width
 * @param drawsButtons false while the buttons are still drawn under the prompt: their place stays empty, and the
 *   text where it stands, until that site has let them go
 */
export function stripView(kit: Kit, segments: Segment[], buttons: readonly StripButton[], columns: number, drawsButtons = true): RenderElement {
  const { Box, Text } = kit
  const room = textRoom(columns, buttons.map(b => b.label))
  const shown = room > 0 ? fit(segments, room, widthOf(SEPARATOR)) : []
  const parts: RenderElement[] = []

  shown.forEach((segment: Segment, i: number) => {
    // A detail sits after a space, a unit right against its number, anything else after a separator.
    if (i > 0 && segment.tight !== true) {
      parts.push(<Text dimColor>{segment.glue === true ? ' ' : SEPARATOR}</Text>)
    }

    parts.push(
      <Text wrap="truncate-end" {...TONE[segment.tone]}>
        {segment.text}
      </Text>,
    )
  })

  return (
    <Box justifyContent="space-between" paddingRight={STRIP.control}>
      <Box>{parts}</Box>
      <Box gap={STRIP.gap}>{drawsButtons ? drawButtons(kit, buttons) : []}</Box>
    </Box>
  )
}

/**
 * The buttons under the prompt, at the right end of its footer, for while the band above has no row for the strip.
 * @param modes the engine's mode labels there (`focus`), kept before the buttons and drawn as the engine draws
 *   them: dim, joined by ` & `
 */
export function footerView(kit: Kit, modes: readonly string[], buttons: readonly StripButton[]): RenderElement {
  const { Box, Text } = kit
  const parts: RenderElement[] = modes.length > 0 ? [<Text dimColor>{modes.join(' & ')}</Text>] : []

  return <Box gap={STRIP.gap}>{[...parts, ...drawButtons(kit, buttons)]}</Box>
}
