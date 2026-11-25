import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement, ReactNode } from 'react'

/** Shared props for the artwork below; the default matches the harness's set. */
interface IconProps {
  readonly size?: number
}

/**
 * One glyph's frame.
 *
 * `stroke` and `strokeWidth` live on the `<svg>` and are inherited, which is how
 * the harness's own icons avoid repeating them on every path; a fill-only shape
 * (the sparkle, the refresh arrowhead) opts out with `stroke="none"`.
 */
function Glyph({ size = 16, children }: { readonly size?: number; readonly children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/**
 * Read-only: the eye.
 *
 * The pupil is deliberately small -- at 16 pixels a pupil at half the eye's
 * height closes the shape up into a blob, and the eye stops reading as an eye
 * before it stops reading as anything else.
 */
export const IconBrowse = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <path d="M1.4 8C3 5.9 5.3 4.9 8 4.9C10.7 4.9 13 5.9 14.6 8C13 10.1 10.7 11.1 8 11.1C5.3 11.1 3 10.1 1.4 8Z" />
    <circle cx="8" cy="8" r="1.6" />
  </Glyph>
)

/**
 * Editable: the pencil.
 *
 * The miter join is deliberate and is the one place in this file that overrides
 * the shared `round`: a pencil whose tip is rounded reads as a crayon.
 */
export const IconEdit = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <path
      strokeLinejoin="miter"
      d="M10.09 4.07L11.93 5.91L6.7 11.14L4.08 11.92L4.86 9.3Z"
    />
    <path d="M9.17 4.99L11.01 6.83" />
  </Glyph>
)

/**
 * The sparkle is the mark both agent buttons share, and it is the only thing
 * they share: what differs is the subject drawn at its lower left, so the pair
 * reads as one family without the two becoming confusable at 16 pixels.
 */
const SPARKLE = 'M12.1 1.2L12.83 3.17L14.8 3.9L12.83 4.63L12.1 6.6L11.37 4.63L9.4 3.9L11.37 3.17Z'

/** Ask the agent about the selection: a marching-ants marquee plus the sparkle. */
export const IconAskSelection = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <rect x="1.6" y="5.2" width="8.6" height="8.6" rx="1" strokeDasharray="2.4 1.7" />
    <path fill="currentColor" stroke="none" d={SPARKLE} />
  </Glyph>
)

/** Ask the agent about the edits: the record of them, as lines, plus the sparkle. */
export const IconAskEdits = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <path d="M1.6 6.6H10.4" />
    <path d="M1.6 9.9H8.2" />
    <path d="M1.6 13.2H10.4" />
    <path fill="currentColor" stroke="none" d={SPARKLE} />
  </Glyph>
)

/**
 * The native editor, browse and edit.
 *
 * A frame around the same eye and pencil, because that is exactly what these
 * two buttons are: the same two modes, in another window, with the full local
 * renderer.  A bare arrow-out-of-a-box would have had to be drawn twice and
 * would then have said nothing about which mode it opens.
 */
export const IconNativeBrowse = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <rect x="1.7" y="3" width="12.6" height="10" rx="1.6" />
    <path d="M5 8C5.8 6.8 6.8 5.8 8 5.8C9.2 5.8 10.2 6.8 11 8C10.2 9.2 9.2 10.2 8 10.2C6.8 10.2 5.8 9.2 5 8Z" />
    <circle cx="8" cy="8" r="1.3" />
  </Glyph>
)

export const IconNativeEdit = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <rect x="1.4" y="3" width="13.2" height="10" rx="1.6" />
    <path strokeLinejoin="miter" d="M9.66 5.2L10.8 6.33L7.12 10.01L5.21 10.79L5.99 8.88Z" />
  </Glyph>
)

/**
 * Something the strip cannot do, and why.
 *
 * The refusal was drawn as its own sentence until 2026-10-07, standing where the
 * two buttons it explains would have been.  On the header row that is not a
 * thing anyone can read: measured, the sentence took 419 of the row's 323 pixels
 * and squeezed the file path to nothing.  As a glyph it costs what one button
 * costs, and the sentence moves into its tooltip -- which is where every other
 * button on this strip keeps its words.
 */
export const IconInfo = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.3V11.3" />
    {/* The dot is a zero-length stroke rather than a filled circle, so it takes
        the same weight as the rest of the outline. */}
    <path d="M8 4.8V4.9" strokeWidth={1.8} />
  </Glyph>
)

/**
 * Re-read the file: the banner's only action.
 *
 * The arc runs clockwise from just below three o'clock all the way round to
 * half past one, so the gap it leaves is on the right and the head sits at the
 * top of it, pointing into the turn.  Both flags matter and neither is
 * guessable: `1 1` is the long arc, clockwise.
 */
export const IconRefresh = ({ size }: IconProps): JSX.Element => (
  <Glyph size={size}>
    <path d="M13.18 8.45A5.2 5.2 0 1 1 11.68 4.32" />
    <path fill="currentColor" stroke="none" d="M11.68 4.32L9.11 3.85L10.87 1.72Z" />
  </Glyph>
)

// The button's own colours are HARNESS TOKENS (`--dsw-alias-*`), not literals,
// and each carries the dark value this strip used before the tokens existed.
// See the note on the pane's other surfaces in `*Viewer.tsx`; these two live
// here because the button does.
const BUTTON: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  // 22 and not 24: the strip lives on the harness header row now, which is 323
  // pixels wide and carries the file path, the harness's reload and its "more
  // ways to open" as well.  Six buttons at the old padding left the path nothing;
  // at this one the path keeps a little over fifty pixels on the desktop carrier
  // and seventy-odd on the Web carrier, where two of the six are one info glyph.
  // The banner's refresh button overrides this, so it keeps its own size.
  padding: 2,
  color: 'var(--dsw-alias-label-primary, #d7e5e8)',
  background: 'var(--dsw-alias-bg-layer-2, #1b2f38)',
  border: '1px solid var(--dsw-alias-border-l3, #45616a)',
  borderRadius: 4,
  cursor: 'pointer',
}
// The whole `border` and not just `borderColor`: mixing the shorthand above with
// one of its longhands here makes React explode the shorthand into empty
// longhands in the style attribute, and the button measures right only because
// the browser ignores the empties.  Setting the shorthand twice is unambiguous.
const BUTTON_ACTIVE: React.CSSProperties = {
  background: 'var(--dsw-alias-brand-primary, #247bbf)',
  border: '1px solid var(--dsw-alias-brand-primary, #247bbf)',
  color: 'var(--dsw-alias-label-primary-inverted, #fff)',
}

/**
 * One icon button with its tooltip.
 *
 * `style` is a whole override rather than a patch, and the spread order below
 * says so: the banner's button passes its own amber surface and nothing of this
 * one survives it.
 */
export function IconButton({ label, onClick, active = false, style, children }: {
  readonly label: string
  readonly onClick: () => void
  readonly active?: boolean
  readonly style?: React.CSSProperties
  readonly children: ReactElement
}): JSX.Element {
  return (
    // `delayMs` because the strip is a row of identical rectangles: a bubble
    // that appears the instant the pointer crosses one flashes on the way to
    // the button the user actually meant.  `portal` because the pane is a
    // scrollport with `overflow: hidden` above it.
    <Tooltip label={label} side="bottom" delayMs={400} portal>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        style={{ ...BUTTON, ...(active ? BUTTON_ACTIVE : {}), ...style }}
      >
        {children}
      </button>
    </Tooltip>
  )
}
