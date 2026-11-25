import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
// Type-only: the ctx.locale service merge.  Erased by the build, which is what
// makes it safe — a VALUE import of that package would throw at
// materialization, because the client closure resolves only a fixed seed table
// and it is not in the table.  See scripts/build.mjs.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { selectedDomains, type ViewDomain } from '../host/domains'
import { ColumnarStoreView, ViewerView, type DocumentBodyProps } from './components/ViewerView'
import { MiningShowRow, type ObservableLike, type ShowRowInjected } from './components/MiningShowRow'
import { MINING_SHOW } from './core/mining-show'
import { type Appearance, observeAppearance, readAppearance } from './core/appearance'
import { en, NAMESPACE, zh } from './locales'

/**
 * The dictionary key that titles a domain's tab.
 *
 * Written out rather than derived from the domain id, so a new domain without
 * words fails to compile instead of showing a key.
 */
const TITLE_KEY: Record<ViewDomain['id'], string> = {
  drawing: 'previewTitleDrawing',
  mining: 'previewTitleMining',
}

export const inject = ['slots', 'documentPreviews', 'locale', 'sidebarRight']

/** The same row config the host half reads; see `host/domains.ts`. */
interface ClientConfig {
  readonly domains?: readonly string[]
}

export function apply(ctx: Context, config: ClientConfig = {}): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }))
  const t = ctx.locale.bind(NAMESPACE)

  /**
   * The row a `iam_mining_show` call leaves, and the one automatic open.
   *
   * THE PANEL IT OPENS IS ORDINARY: what the tool names is a workspace document,
   * so the preview registered below claims it by extension and the host half
   * resolves the address through the same workspace-confined resolver as any
   * other file.  The selection travels beside the address (see
   * `core/mining-show.ts` for why not inside it), and the pane hands it to the
   * running view.
   */
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    {
      name: 'tool.call.toolview', key: MINING_SHOW, locale: NAMESPACE,
      inject: (): ShowRowInjected => ({
        openPanel: (address: string) => { ctx.sidebarRight.openResource(address) },
        // The observable, not its value: openResource throws when no session
        // surface is mounted, so the row watches this and opens on the commit
        // that mounts one.
        sidebarMounted: ctx.sidebarRight.mounted as unknown as ObservableLike<string | undefined>,
      }),
    },
    MiningShowRow,
  )), 'iam-views: the show card')

  for (const domain of selectedDomains(config.domains)) {
    const columnar = domain.columnarExtensions ?? []
    const documentExtensions = domain.extensions.filter(extension => !columnar.includes(extension))

    if (documentExtensions.length > 0) {
      ctx.effect(() => ctx.documentPreviews.register({
        id: domain.previewId,
        extensions: [...documentExtensions],
        binaryExtensions: [...documentExtensions],
        // A function and not a string, because the harness re-renders the tab when
        // the language changes and asks again — which it cannot do with a value
        // captured at registration time.
        title: () => t(TITLE_KEY[domain.id]),
        loading: 'bytes-complete',
        wrap: false,
      }))

      /**
       * The pane, plus the appearance the embedded view has to be told about.
       *
       * The view inside the iframe is a separate document with no access to
       * anything here — not to the harness's theme, not to its locale registry —
       * so the two facts it needs travel the only way they can: as query
       * parameters on the frame's URL, which is the channel `?editable=` already
       * uses.  Written as a wrapper rather than read by the viewer itself, because
       * the viewer is a slot body and receives the slot's props and nothing else.
       *
       * Subscribed rather than read once: a user who switches to Light with a
       * document open expects the pane to follow, and the frame is remounted when
       * either changes (see `EmbeddedView.attach` — the appearance is part of the
       * URL, and a URL cannot be changed under a running wasm instance).
       */
      const Body = (props: DocumentBodyProps): JSX.Element => {
        const [appearance, setAppearance] = useState<Appearance>(readAppearance)
        useEffect(() => observeAppearance(setAppearance), [])
        return <ViewerView {...props} domain={domain} appearance={appearance} />
      }

      ctx.effect(() =>
        ctx.slots.inject('sidebar.right.tab.document', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document', key: domain.previewId, locale: NAMESPACE },
            Body,
          ),
        ),
      )
    }

    /**
     * The columnar-store pane, which owns its content instead of reading it.
     *
     * `loading: 'renderer'` is the whole of the fix this registration exists for:
     * the harness hands the pane a revision and starts no read, so opening a
     * large `.iamh` no longer spends its first seconds (or minutes) turning the
     * file into bytes for a wasm view that cannot read it.  What the pane shows
     * and why it has no frame is `ColumnarStoreView`'s own docblock.
     */
    const columnarPreviewId = domain.columnarPreviewId
    if (columnarPreviewId !== undefined && columnar.length > 0) {
      ctx.effect(() => ctx.documentPreviews.register({
        id: columnarPreviewId,
        extensions: [...columnar],
        binaryExtensions: [...columnar],
        title: () => t(TITLE_KEY[domain.id]),
        loading: 'renderer',
        wrap: false,
      }))

      const ColumnarBody = (props: DocumentBodyProps): JSX.Element =>
        <ColumnarStoreView {...props} domain={domain} />

      ctx.effect(() =>
        ctx.slots.inject('sidebar.right.tab.document', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document', key: columnarPreviewId, locale: NAMESPACE },
            ColumnarBody,
          ),
        ),
      )
    }
  }
}
