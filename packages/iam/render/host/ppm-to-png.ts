import { deflateSync } from 'node:zlib'

export interface EncodedPngFrame {
  pngBytes: Buffer
  width: number
  height: number
}

/** A 32-bit CRC table, built once. */
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let byteValue = 0; byteValue < 256; byteValue += 1) {
    let checksum = byteValue
    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1
    }
    table[byteValue] = checksum >>> 0
  }
  return table
})()

function computeCrc32(bytes: Buffer): number {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum = PNG_CRC_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8)
  }
  return (checksum ^ 0xffffffff) >>> 0
}

function encodePngChunk(chunkType: string, chunkPayload: Buffer): Buffer {
  const payloadLength = Buffer.alloc(4)
  payloadLength.writeUInt32BE(chunkPayload.length, 0)
  const typeAndPayload = Buffer.concat([Buffer.from(chunkType, 'ascii'), chunkPayload])
  const encodedChecksum = Buffer.alloc(4)
  encodedChecksum.writeUInt32BE(computeCrc32(typeAndPayload), 0)
  return Buffer.concat([payloadLength, typeAndPayload, encodedChecksum])
}

function isPpmWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/**
 * P6 PPM to PNG, or a sentence saying why the bytes are not a frame.
 *
 * The header is parsed rather than assumed: a renderer that failed early can
 * still leave a truncated file, and a truncated file decoded as a frame would be
 * reported as a successful render of noise. In particular the pixel offset is
 * never guessed: exactly one whitespace byte separates `maxval` from the binary
 * data, and consuming more would eat a pixel whose value happens to be a space,
 * a tab or a newline.
 */
export function convertP6PpmToPng(ppmBytes: Buffer): EncodedPngFrame {
  if (ppmBytes.length < 10 || ppmBytes[0] !== 0x50 || ppmBytes[1] !== 0x36) {
    throw new Error('not a P6 PPM: the first two bytes are not "P6"')
  }
  let byteOffset = 2
  const headerNumbers: number[] = []
  while (headerNumbers.length < 3) {
    while (byteOffset < ppmBytes.length && isPpmWhitespace(ppmBytes[byteOffset]!)) byteOffset += 1
    if (ppmBytes[byteOffset] === 0x23) {
      while (byteOffset < ppmBytes.length && ppmBytes[byteOffset] !== 0x0a) byteOffset += 1
      continue
    }
    const numberStartOffset = byteOffset
    while (byteOffset < ppmBytes.length && ppmBytes[byteOffset]! >= 0x30 && ppmBytes[byteOffset]! <= 0x39) byteOffset += 1
    if (numberStartOffset === byteOffset) throw new Error('malformed PPM header: a dimension is missing')
    headerNumbers.push(Number(ppmBytes.subarray(numberStartOffset, byteOffset).toString('ascii')))
  }
  if (byteOffset >= ppmBytes.length || !isPpmWhitespace(ppmBytes[byteOffset]!)) {
    throw new Error('malformed PPM header: no whitespace after the maximum value')
  }
  const pixelStartOffset = byteOffset + 1
  const [width, height, maximumChannelValue] = headerNumbers as [number, number, number]
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`malformed PPM header: ${width}x${height} is not a frame`)
  }
  if (maximumChannelValue !== 255)
    throw new Error(`unsupported PPM maximum ${maximumChannelValue}; expected 255`)
  const bytesPerRow = width * 3
  const expectedPixelByteCount = width * height * 3
  const pixelBytes = ppmBytes.subarray(pixelStartOffset, pixelStartOffset + expectedPixelByteCount)
  if (pixelBytes.length !== expectedPixelByteCount) {
    throw new Error(`truncated PPM: expected ${expectedPixelByteCount} pixel bytes, found ${pixelBytes.length}`)
  }
  const uncompressedScanlines: Buffer[] = []
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    uncompressedScanlines.push(Buffer.from([0]))
    uncompressedScanlines.push(pixelBytes.subarray(rowIndex * bytesPerRow, (rowIndex + 1) * bytesPerRow))
  }
  const imageHeader = Buffer.alloc(13)
  imageHeader.writeUInt32BE(width, 0)
  imageHeader.writeUInt32BE(height, 4)
  imageHeader[8] = 8
  imageHeader[9] = 2
  imageHeader[10] = 0
  imageHeader[11] = 0
  imageHeader[12] = 0
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodePngChunk('IHDR', imageHeader),
    encodePngChunk('IDAT', deflateSync(Buffer.concat(uncompressedScanlines), { level: 6 })),
    encodePngChunk('IEND', Buffer.alloc(0)),
  ])
  return { pngBytes, width, height }
}
