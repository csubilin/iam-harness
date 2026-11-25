export type HostReason =
  /** A launch: this carrier cannot start a program on the user's own machine. */
  | 'desktopOnlyLaunch'
  /** The capability question: the same fact, asked before anything was pressed. */
  | 'desktopOnly'
  /** No directory was configured to look for the program in. */
  | 'noBinDir'
  /** No SHX font directory was configured, and the editor draws no text without one. */
  | 'noFontsDir'
  /** The directory is configured and the program is not in it. `detail` is the path tried. */
  | 'noExecutable'
  /** The loopback port the events arrive on would not open. */
  | 'noEventPort'
  /** The process was spawned and reported no pid. */
  | 'notStarted'
  /** A launch: this document already has a native window, and one is the limit. */
  | 'alreadyOpen'
  /** A wake: this session has no view record to hand the agent. */
  | 'noViewState'
  /** A wake: the session is not currently holding an agent that can be followed up. */
  | 'noAgent'

/** A refusal the pane can put into the user's language. */
export interface HostRefusal {
  readonly code: HostReason
  /** The one value the code's sentence needs, when it needs one. */
  readonly detail?: string
}
