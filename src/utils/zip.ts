/**
 * Минимальный ZIP-ридер на нативном DecompressionStream — без внешних зависимостей.
 *
 * ponytail: поддерживаются только методы store (0) и deflate (8) и обычный (не ZIP64)
 * архив. Если понадобятся архивы >4 ГБ или >65535 файлов — заменить на fflate.
 */
const EOCD_SIG = 0x06054b50
const utf8 = new TextDecoder()

const findEOCD = (view: DataView): number => {
  const max = Math.min(view.byteLength, 0xffff + 22)
  for (let i = 22; i <= max; i++) {
    const pos = view.byteLength - i
    if (view.getUint32(pos, true) === EOCD_SIG) {
      return pos
    }
  }
  throw new Error('Некорректный ZIP-архив: не найдена структура файла')
}

const inflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Распаковывает ZIP в карту "путь внутри архива" → содержимое файла
 */
export const unzip = async (buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> => {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const eocd = findEOCD(view)

  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)

  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64-архивы не поддерживаются')
  }

  const entries = new Map<string, Uint8Array>()
  let p = cdOffset

  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    // Папки и служебные файлы macOS пропускаем
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) {
      continue
    }

    // Размеры берём из центральной директории, длины — из локального заголовка
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = bytes.subarray(start, start + compressedSize)

    entries.set(name, method === 0 ? raw : await inflateRaw(raw))
  }

  return entries
}
