import type { Context } from '@deepseek-ai/cordis'

/** The slot ids, named once: a typo in either is a registration that never shows. */
const MARK_SLOT = 'sidebar.brand.mark'
const NAME_SLOT = 'sidebar.brand.name'

/**
 * The platform's mark.
 *
 * `currentColor` is deliberately NOT used.  This is a brand colour rather than a
 * piece of the interface -- it says the same thing in light and in dark, which
 * is the point of a mark -- and the harness's two appearances both give it
 * enough contrast to read.
 *
 * Sized from the owner's share, like the harness's own brand occupant: the
 * sidebar decides how big the mark is and this does not argue.
 */
function IamBrandMark({ size }: { readonly size?: number }): JSX.Element {
  const edge = size ?? 24
  return (
    <svg
      width={edge}
      height={edge}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
      // The name slot beside this one carries the accessible text; a title here
      // would be read twice by a screen reader walking the two slots.
    >
      {/* The geological frame: a hexagonal outline, the shape the whole mark sits in. */}
      <path
        fill="#078FCB"
        fillRule="evenodd"
        d="M256 48 454 162v188L256 464 58 350V162L256 48Zm0 65L114 195v122l142 82 142-82V195L256 113Z"
      />
      {/* The insight glint: one four-point spark, not a network of nodes. */}
      <path fill="#078FCB" d="m256 133 21 61 62 22-62 21-21 62-21-62-62-21 62-22z" />
      {/* The horizon, leading the eye down to the opening. */}
      <path
        d="M119 305c54-25 96-26 137-7s83 19 137-6"
        stroke="#078FCB"
        strokeWidth="19"
        strokeLinecap="square"
      />
      {/* The mine opening itself. */}
      <path
        d="M214 365v-32a42 42 0 0 1 84 0v32"
        stroke="#078FCB"
        strokeWidth="25"
        strokeLinecap="square"
      />
    </svg>
  )
}

/**
 * The product's name, as the sidebar draws it.
 *
 * Not translated, and not a key in any dictionary: it is a proper noun, it is
 * the same two words in every language the harness carries, and a translated
 * product name is how a product ends up with two of them.
 *
 * A `<span>` at the sidebar's own brand type size rather than an `<h1>` or a
 * styled div: the slot's owner decides the layout, and this supplies the words.
 */
function IamBrandName(): JSX.Element {
  return <span>IAM Harness</span>
}

export const inject = ['slots']

export function apply(ctx: Context): void {
  // One `inject` around both registrations rather than two: the two slots are
  // one decision -- the mark and the name belong to the same brand -- and a
  // teardown that removed one and left the other would be half a wordmark.
  ctx.effect(() =>
    ctx.slots.inject(MARK_SLOT, function* () {
      yield ctx.slots.register({ name: MARK_SLOT }, IamBrandMark)
      yield ctx.slots.register({ name: NAME_SLOT }, IamBrandName)
    }),
  )
}
