export interface Appearance {
  /** Already resolved: `system` never reaches here. */
  readonly theme: 'light' | 'dark'
  /** A locale id the view knows, or one it will fall back from. */
  readonly language: string
}

/** The harness's own attribute, spelled once. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * What the harness is showing right now.
 *
 * Total: with no `<body>` yet, no attribute and no `lang`, it answers
 * light/English, which is what the harness answers in the same conditions.
 * Nothing here can throw, which is the property that matters -- this runs
 * during a React render, and a throw would take the whole pane with it.
 */
export function readAppearance(): Appearance {
  const body = typeof document === 'undefined' ? null : document.body
  const dark = body !== null && body.hasAttribute(DARK_ATTRIBUTE)
  const tag = (typeof document === 'undefined' ? '' : document.documentElement.lang) || ''
  return {
    theme: dark ? 'dark' : 'light',
    // The tag is `zh-CN` for Chinese and `en` for English; the view's table has
    // two entries and falls back to English for anything else, so the language
    // subtag is all this needs to look at.
    language: tag.toLowerCase().startsWith('zh') ? 'zh' : 'en',
  }
}

/**
 * Call `onChange` whenever the harness changes either half, and return the
 * unsubscribe.
 *
 * A MutationObserver rather than the harness's `theme/change` event, for the
 * same reason the value is read from the DOM: both halves of the pair arrive as
 * attribute writes, so one observer sees every change that matters and cannot
 * see a change the pane's CSS did not also see.
 *
 * The observer reports only real changes, so a callback that remounts something
 * expensive is not woken by an unrelated attribute write on `body` -- of which
 * the harness makes many.
 */
export function observeAppearance(onChange: (appearance: Appearance) => void): () => void {
  if (typeof MutationObserver === 'undefined')
    return () => {}
  let last = readAppearance()
  const check = (): void => {
    const next = readAppearance()
    if (next.theme === last.theme && next.language === last.language)
      return
    last = next
    onChange(next)
  }
  const observer = new MutationObserver(check)
  if (document.body !== null)
    observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => { observer.disconnect() }
}

/** The two parameters, appended to the view's URL. */
export function appearanceQuery(appearance: Appearance): string {
  return `theme=${encodeURIComponent(appearance.theme)}&lang=${encodeURIComponent(appearance.language)}`
}
