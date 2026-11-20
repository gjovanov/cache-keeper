/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { Elements, RenderElement } from 'claude-code'

import { fit, widthOf } from './core.mjs'

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
/** The band draws its own collapse control at its right edge. */
const BAND_CONTROL = 5
/** A button is drawn wider than its label. */
const BUTTON_CHROME = 4
/** Between two buttons. */
const BUTTON_GAP = 1

/** What the buttons take on screen, chrome and gaps included. */
export function buttonsWidth(buttons: readonly StripButton[]): number {
  return buttons.reduce((sum, b) => sum + widthOf(b.label) + BUTTON_CHROME, 0) + BUTTON_GAP * Math.max(0, buttons.length - 1)
}

/**
 * One row above the prompt: the cache countdown and what the session costs, then the buttons.
 * @param columns the band's body width
 */
export function stripView(kit: Kit, segments: Segment[], buttons: readonly StripButton[], columns: number): RenderElement {
  const { Box, Text, Button } = kit
  const room = Math.max(12, columns - BAND_CONTROL - buttonsWidth(buttons) - 2)
  const shown = fit(segments, room, widthOf(SEPARATOR))
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
    <Box justifyContent="space-between" paddingRight={BAND_CONTROL}>
      <Box>{parts}</Box>
      <Box gap={BUTTON_GAP}>
        {buttons.map(button => (
          <Button key={button.key} dimColor={button.isDim} onPress={button.onPress}>
            {button.label}
          </Button>
        ))}
      </Box>
    </Box>
  )
}
