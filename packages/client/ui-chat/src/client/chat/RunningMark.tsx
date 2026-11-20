/** The IAM mark, pulsing while a Turn runs. */
import { IamBrandMark } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/**
 * Render the running status's decorative mark; the host times it.
 *
 * The pulse is a CSS animation rather than a second element: reduced motion and
 * forced colours select the still mark through the same media query the shipped
 * motion guard uses, with no asset and no per-frame state.
 * @returns the product mark inside its fixed icon footprint.
 */
export function RunningMark() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningMark}>
        <IamBrandMark />
      </span>
    </span>
  )
}
