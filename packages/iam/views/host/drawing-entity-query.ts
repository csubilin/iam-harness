import { randomUUID } from 'node:crypto'

export interface DrawingEntityQueryParameters {
  source: 'document' | 'selection'
  class?: string
  layer?: string
  bbox?: number[]
  limit: number
  after_handle?: string
  document_digest?: string
  selection_version?: number
  expand_blocks: boolean
  max_bytes: number
}

export interface DrawingEntityQueryRequest {
  id: string
  args: DrawingEntityQueryParameters
}

export const DRAWING_ENTITY_QUERY_WIRE_SCHEMA = 'iax.iam.drawing-query/1'

export function parseDrawingEntityQueryParameters(input: Record<string, unknown>): DrawingEntityQueryParameters {
  if (input.source !== 'document' && input.source !== 'selection') throw new Error('drawing query: invalid view source')
  const parameters: DrawingEntityQueryParameters = { source: input.source, limit: 1000, expand_blocks: true, max_bytes: 4 * 1024 * 1024 }
  for (const key of ['class', 'layer', 'after_handle', 'document_digest'] as const) {
    const value = input[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 4096) throw new Error(`drawing query: invalid ${key}`)
      parameters[key] = value
    }
  }
  for (const [key, minimum, maximum] of [['limit', 1, 5000], ['max_bytes', 4096, 64 * 1024 * 1024],
    ['selection_version', 0, Number.MAX_SAFE_INTEGER]] as const) {
    const value = input[key]
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`drawing query: invalid ${key}`)
      parameters[key] = value
    }
  }
  if (input.expand_blocks !== undefined) {
    if (typeof input.expand_blocks !== 'boolean') throw new Error('drawing query: expand_blocks must be boolean')
    parameters.expand_blocks = input.expand_blocks
  }
  if (input.bbox !== undefined) {
    const bounds = input.bbox
    if (!Array.isArray(bounds) || bounds.length !== 6 ||
        bounds.some(value => typeof value !== 'number' || !Number.isFinite(value)) ||
        bounds.slice(0, 3).some((minimum, axis) => minimum > bounds[axis + 3]))
      throw new Error('drawing query: bbox requires ordered finite bounds')
    parameters.bbox = bounds as number[]
  }
  return parameters
}

interface PendingBrowserDrawingEntityQuery {
  request: DrawingEntityQueryRequest
  viewInstanceId: string
  dispatchedToView: boolean
  finishQuery: (result: unknown) => void
}

// The queue carries requests and JSON only. Entity interpretation stays in C++.
export class BrowserDrawingEntityQueryQueue {
  private readonly pendingByRequestId = new Map<string, PendingBrowserDrawingEntityQuery>()
  private readonly lastPollTimeByViewId = new Map<string, number>()

  enqueueForView(viewInstanceId: string, parameters: DrawingEntityQueryParameters, signal?: AbortSignal): Promise<unknown> {
    if (Date.now() - (this.lastPollTimeByViewId.get(viewInstanceId) ?? 0) > 5000)
      return Promise.resolve({ error: { code: 'no_view', message: '没有可响应查询的视图；请打开或刷新图纸预览。' } })
    if (this.pendingByRequestId.size >= 32) throw new Error('drawing query queue is full; retry after the current query')
    return new Promise((resolve) => {
      const requestId = randomUUID()
      const finishQuery = (result: unknown): void => {
        clearTimeout(responseTimeout)
        signal?.removeEventListener('abort', cancelQuery)
        this.pendingByRequestId.delete(requestId)
        resolve(result)
      }
      const cancelQuery = (): void => finishQuery({ error: { code: 'cancelled', message: '图元查询已取消。' } })
      const responseTimeout = setTimeout(() => finishQuery({ error: { code: 'view_unresponsive', message: '视图在 30 秒内没有回答；请确认视图仍打开，然后重试。' } }), 30_000)
      this.pendingByRequestId.set(requestId, {
        request: { id: requestId, args: parameters }, viewInstanceId, dispatchedToView: false, finishQuery,
      })
      signal?.addEventListener('abort', cancelQuery, { once: true })
      if (signal?.aborted) cancelQuery()
    })
  }

  takeNextForView(viewInstanceId: string): DrawingEntityQueryRequest | null {
    this.lastPollTimeByViewId.set(viewInstanceId, Date.now())
    // Stale page identities cannot accumulate for the lifetime of the host.
    for (const [knownViewId, lastPollTime] of this.lastPollTimeByViewId)
      if (Date.now() - lastPollTime > 60_000) this.lastPollTimeByViewId.delete(knownViewId)
    for (const pendingQuery of this.pendingByRequestId.values()) {
      if (pendingQuery.viewInstanceId === viewInstanceId && !pendingQuery.dispatchedToView) {
        pendingQuery.dispatchedToView = true
        return { ...pendingQuery.request }
      }
    }
    return null
  }

  completeForView(viewInstanceId: string, requestId: string, result: unknown): boolean {
    const pendingQuery = this.pendingByRequestId.get(requestId)
    if (!pendingQuery || !pendingQuery.dispatchedToView || pendingQuery.viewInstanceId !== viewInstanceId) return false
    if (Buffer.byteLength(JSON.stringify(result) ?? '') > pendingQuery.request.args.max_bytes)
      pendingQuery.finishQuery({ error: { code: 'result_too_large', message: '视图回答超过 max_bytes；请缩小查询范围。' } })
    else pendingQuery.finishQuery(result)
    return true
  }

  disconnectView(viewInstanceId: string): void {
    this.lastPollTimeByViewId.delete(viewInstanceId)
    for (const pendingQuery of [...this.pendingByRequestId.values()])
      if (pendingQuery.viewInstanceId === viewInstanceId)
        pendingQuery.finishQuery({ error: { code: 'no_view', message: '图纸视图已卸载或被替换；请重新查询当前视图。' } })
  }

  close(): void {
    for (const pendingQuery of [...this.pendingByRequestId.values()])
      pendingQuery.finishQuery({ error: { code: 'no_view', message: '视图已卸载。' } })
    this.lastPollTimeByViewId.clear()
  }
}
