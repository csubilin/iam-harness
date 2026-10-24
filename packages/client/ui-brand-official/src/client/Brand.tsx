import { IamBrandMark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the IAM mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <IamBrandMark size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 *
 * The host's brand row owns the typography (size, weight, tracking), so the
 * occupant supplies the words only.
 * @returns the product name.
 */
export function OfficialBrandName() {
  return <span>IAM Harness</span>
}
