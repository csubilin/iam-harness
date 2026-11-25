export interface ViewDomain {
  /** The domain token the event schema, the tools and the native bridge use. */
  readonly id: 'drawing' | 'mining'
  /** The route prefix this domain's files and endpoints are served under. */
  readonly route: string
  /** The page in `vendor/` that the preview embeds. */
  readonly page: string
  /** Every suffix this domain's documents answer for, without the leading dot. */
  readonly extensions: readonly string[]
  /**
   * The suffixes among `extensions` whose container the browser build cannot read.
   *
   * These are not given to the ordinary preview: the browser half registers them
   * as a `renderer` preview, which is the harness's way of saying the pane owns
   * its own content. That pane then reads nothing and mounts no frame -- which is
   * the point, because the read of a large store was the whole of the wait before
   * the native actions could even be offered.
   */
  readonly columnarExtensions?: readonly string[]
  /** Prefix for this domain's two model-facing tools. */
  readonly toolPrefix: string
  /**
   * The tool that READS one of this domain's documents.
   *
   * The two view tools are shared by both domains and their text is written
   * once, but the sentences that name a tool are not shareable: a Drawing
   * session reads a file with `describe_drawing` and a Mining session reads a
   * project with `iam_mine_describe`, and a description that named the wrong one
   * would send a model after a tool that is not in its table. That is the same
   * shape as the two bugs this file exists to stop, so the names live here.
   */
  readonly describeTool: string
  /**
   * The tool that OPENS one of this domain's documents in the pane, where the
   * domain's repository publishes one.
   *
   * Mining's does (`iam_mining_show`, in the MiningRepository package, which the
   * same profile installs). Drawing's publishes nothing that mounts a pane --
   * the user opens the file in the page -- which is why this is optional rather
   * than a name that happens not to work.
   */
  readonly openTool?: string
  /** The package id the browser half registers its preview under. */
  readonly previewId: string
  /**
   * The package id for the columnar-store pane, where this domain has one.
   *
   * A second id rather than a second package: the pane is the same component
   * family and the same route table, and the harness's preview registry keys one
   * slot body per id -- so the two loading modes cannot share one registration.
   */
  readonly columnarPreviewId?: string
  /** Window title for the embedded document, by mode. */
  readonly frameTitle: { readonly browse: string; readonly edit: string }
}

export const VIEW_DOMAINS: readonly ViewDomain[] = [
  {
    id: 'drawing',
    route: '/iam-drawingview',
    page: 'IamDrawingView.html',
    extensions: ['iamp', 'iaxp'],
    toolPrefix: 'iam_drawing',
    describeTool: 'describe_drawing',
    previewId: '@deepseek-ai/iam-drawingview',
    frameTitle: { browse: 'Drawing 2D Browse', edit: 'Drawing 2D Edit' },
  },
  {
    id: 'mining',
    route: '/iam-miningview',
    page: 'IamMiningView.html',
    // `.iamh` is in the list even though the WebAssembly build cannot read it:
    // the browser half splits these two suffixes into their own `renderer`
    // preview, so opening one reads nothing and offers the native editor
    // immediately instead of waiting on a read that cannot produce a picture.
    extensions: ['iam', 'iaxm', 'iamh', 'iaxh5'],
    columnarExtensions: ['iamh', 'iaxh5'],
    toolPrefix: 'iam_mining',
    describeTool: 'iam_mine_describe',
    openTool: 'iam_mining_show',
    previewId: '@deepseek-ai/iam-miningview',
    columnarPreviewId: '@deepseek-ai/iam-miningview-columnar',
    frameTitle: { browse: 'Mining 3D Browse', edit: 'Mining 3D Edit' },
  },
]

export function domainById(id: string): ViewDomain {
  const found = VIEW_DOMAINS.find(domain => domain.id === id)
  if (found === undefined) throw new Error(`no IAM view domain named ${id}`)
  return found
}

/**
 * The domains a bundle row asked for.
 *
 * Both halves take the same list from the same row config, so a profile that
 * wants one domain says so once.  Absent or empty means every domain, which is
 * what the shipped bundle row gets: one package installed, both views served.
 * The browser half filters too, because the harness mounts one client module per
 * package -- a preview registered for a domain the host was not asked to serve
 * would frame a route that never answered.
 */
export function selectedDomains(configured?: unknown): readonly ViewDomain[] {
  // Harness versions have passed the row's config value through as a scalar
  // (and occasionally as the whole config object). Only a string array is a
  // meaningful domain filter; malformed/absent values should retain the
  // package default instead of preventing either half from loading.
  if (!Array.isArray(configured) || configured.length === 0) return VIEW_DOMAINS
  const names = configured.filter((value): value is string => typeof value === 'string')
  if (names.length !== configured.length) return VIEW_DOMAINS
  const chosen = VIEW_DOMAINS.filter(domain => names.includes(domain.id))
  if (chosen.length !== names.length) {
    const known = VIEW_DOMAINS.map(domain => domain.id).join(', ')
    throw new Error(`config.domains names an unknown view; this package serves ${known}`)
  }
  return chosen
}
