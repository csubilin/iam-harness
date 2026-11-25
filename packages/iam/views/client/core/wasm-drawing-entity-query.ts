import type { DrawingEntityQueryParameters } from '../../host/drawing-entity-query'

const VIEW_REQUEST_COMPLETED = 6
const VIEW_REQUEST_FAILED = 7

type WasmDrawingEntityQueryModule = {
  HEAPU8: Uint8Array
  _malloc: (size: number) => number
  _free: (pointer: number) => void
  _iamViewAgentDrawingQuery?: (...args: number[]) => number
  _iamViewAgentDrawingPoll?: (...args: number[]) => number
  _iamViewAgentDrawingRelease?: (requestId: number) => number
}

// The module runs the same C++ view/query code as Native. This bridge only
// allocates ABI arguments, waits for the render-thread request, and copies JSON.
export async function queryWasmDrawingEntities(
  frame: HTMLIFrameElement | null, parameters: DrawingEntityQueryParameters,
): Promise<unknown> {
  const module = (frame?.contentWindow as (Window & { Module?: WasmDrawingEntityQueryModule }) | null)?.Module
  if (!module?._iamViewAgentDrawingQuery || !module._iamViewAgentDrawingPoll)
    return { error: { code: 'view_query_unavailable', message: '当前视图尚未提供图元查询入口；请更新视图构建并刷新预览。' } }
  const allocatedPointers: number[] = []
  const allocateAbiBuffer = (byteCount: number): number => {
    const pointer = module._malloc(byteCount)
    if (!pointer) throw new Error('drawing query: could not allocate ABI buffer')
    allocatedPointers.push(pointer)
    return pointer
  }
  const writeOptionalUtf8Argument = (value: string | undefined): number => {
    if (value === undefined) return 0
    const bytes = new TextEncoder().encode(value)
    const pointer = allocateAbiBuffer(bytes.length + 1)
    module.HEAPU8.set(bytes, pointer)
    module.HEAPU8[pointer + bytes.length] = 0
    return pointer
  }
  try {
    const classNamePointer = writeOptionalUtf8Argument(parameters.class)
    const layerNamePointer = writeOptionalUtf8Argument(parameters.layer)
    const paginationCursorPointer = writeOptionalUtf8Argument(parameters.after_handle)
    const documentDigestPointer = writeOptionalUtf8Argument(parameters.document_digest)
    const selectionVersionPointer = writeOptionalUtf8Argument(
      parameters.selection_version === undefined ? undefined : String(parameters.selection_version),
    )
    let boundsPointer = 0
    if (parameters.bbox) {
      boundsPointer = allocateAbiBuffer(6 * 8)
      const heap = new DataView(module.HEAPU8.buffer)
      parameters.bbox.forEach((coordinate, index) => heap.setFloat64(boundsPointer + index * 8, coordinate, true))
    }
    const requestId = module._iamViewAgentDrawingQuery(
      parameters.source === 'selection' ? 2 : 1, classNamePointer, layerNamePointer, paginationCursorPointer,
      parameters.limit, parameters.expand_blocks ? 1 : 0, boundsPointer, parameters.max_bytes,
      documentDigestPointer, selectionVersionPointer,
    ) >>> 0
    if (!requestId) throw new Error('drawing query request was rejected; check filters and limits')
    const requestStatePointer = allocateAbiBuffer(8)
    const requiredByteCountPointer = requestStatePointer + 4
    const pollDeadline = Date.now() + 29_000
    while (Date.now() < pollDeadline) {
      const pollStatus = module._iamViewAgentDrawingPoll(requestId, requestStatePointer, 0, 0, requiredByteCountPointer)
      if (pollStatus) throw new Error(`drawing query poll failed (${pollStatus})`)
      const heap = new DataView(module.HEAPU8.buffer)
      const requestState = heap.getInt32(requestStatePointer, true)
      const requiredByteCount = heap.getUint32(requiredByteCountPointer, true)
      if (requestState === VIEW_REQUEST_COMPLETED || requestState === VIEW_REQUEST_FAILED) {
        if (requiredByteCount > parameters.max_bytes + 1) throw new Error('drawing query result exceeds max_bytes')
        const resultPointer = allocateAbiBuffer(Math.max(1, requiredByteCount))
        if (module._iamViewAgentDrawingPoll(
          requestId, requestStatePointer, resultPointer, requiredByteCount, requiredByteCountPointer,
        ))
          throw new Error('drawing query result is no longer available; retry')
        const resultText = new TextDecoder().decode(
          module.HEAPU8.subarray(resultPointer, resultPointer + Math.max(0, requiredByteCount - 1)),
        )
        module._iamViewAgentDrawingRelease?.(requestId)
        if (requestState === VIEW_REQUEST_FAILED) return { error: { code: 'query_failed', message: resultText } }
        return JSON.parse(resultText) as unknown
      }
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    return { error: { code: 'view_unresponsive', message: '视图线程没有及时执行图元查询；请确认视图仍在运行。' } }
  } finally {
    for (const pointer of allocatedPointers.reverse()) module._free(pointer)
  }
}
