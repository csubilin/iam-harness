/**
 * The product mark, drawn in the sidebar's brand slot and by its official occupant.
 *
 * IT IS THE SAME MARK as the one `IAM/plugin/Brand` registers into
 * `sidebar.brand.mark`, path for path, and the two have to be changed together:
 * a profile with that plugin installed draws the occupant, every other profile
 * draws this. The paths come from IAM/Assets/mining-platform-icon.svg, which
 * stays the source of truth.
 *
 * THE COLOUR IS FIXED, not `currentColor` like the fish, and the shape is
 * square rather than 23.16:17.04.  A mark is not a piece of the interface: it
 * says the same thing in light and in dark, which is what the brand colour is
 * for.  The sidebar reserves a 24px box either way (`.brandMark` and
 * `.railMark` are centred flex), so the square fits where the fish did.
 */

/** Props for the product mark. */
export interface IamBrandMarkProps {
  /** Edge in px (default 24; the artwork is square). */
  readonly size?: number | undefined
}

/**
 * Render the mark.
 * @param props.size - edge in px (default 24; the artwork is square).
 * @returns the mark svg (aria-hidden; the name slot beside it carries the words).
 */
export function IamBrandMark({ size = 24 }: IamBrandMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
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
