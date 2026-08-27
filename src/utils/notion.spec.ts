import { describe, expect, it } from 'vitest'

import { parseCSV } from './file-parsers.js'
import { parseNotionZip } from './notion.js'
import { unzip } from './zip.js'

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

const deflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Собирает ZIP, чтобы проверить чтение архива */
const makeZip = async (
  files: Record<string, Uint8Array>,
  compress = false,
): Promise<ArrayBuffer> => {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const [name, source] of Object.entries(files)) {
    const data = compress ? await deflateRaw(source) : source
    const nameBytes = encoder.encode(name)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(8, compress ? 8 : 0, true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, source.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(10, compress ? 8 : 0, true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, source.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, centrals.length, true)
  eocdView.setUint16(10, centrals.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  const parts = [...locals, ...centrals, eocd]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const zip = new Uint8Array(total)
  let position = 0
  for (const part of parts) {
    zip.set(part, position)
    position += part.length
  }
  return zip.buffer
}

const zipAsFile = async (files: Record<string, Uint8Array>): Promise<File> =>
  new File([await makeZip(files, true)], 'Export-test.zip')

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('parseCSV', () => {
  it('понимает кавычки, запятые и переносы строк внутри значений', () => {
    const table = parseCSV('﻿Name,Tags\n"Hello, world","a\nb"\n')

    expect(table.headers).toEqual(['Name', 'Tags'])
    expect(table.rows).toEqual([['Hello, world', 'a\nb']])
  })

  it('выкидывает пустые заголовки вместе с их колонками', () => {
    const table = parseCSV('Name,,Tags\nfirst,junk,second\n')

    expect(table.headers).toEqual(['Name', 'Tags'])
    expect(table.rows).toEqual([['first', 'second']])
  })
})

describe('unzip', () => {
  it('читает несжатые файлы архива', async () => {
    const entries = await unzip(await makeZip({ 'a/b.txt': text('hello') }))

    expect(new TextDecoder().decode(entries.get('a/b.txt'))).toBe('hello')
  })

  it('распаковывает сжатые файлы архива', async () => {
    const body = 'привет '.repeat(50)
    const entries = await unzip(await makeZip({ 'a/b.txt': text(body) }, true))

    expect(new TextDecoder().decode(entries.get('a/b.txt'))).toBe(body)
  })
})

describe('parseNotionZip', () => {
  it('собирает строки, тело страницы и картинки из экспорта Notion', async () => {
    const table = await parseNotionZip(
      await zipAsFile({
        'Tasks abc.csv': text('﻿Name,Cover\nFirst task,photo.png\n'),
        'Tasks abc/First task def.md': text(
          '# First task\n\nCover: photo.png\n\nТекст страницы\n\n![](First%20task%20def/inline.png)',
        ),
        'Tasks abc/First task def/inline.png': PNG,
        'Tasks abc/First task def/photo.png': PNG,
        'Tasks abc/Unused page/orphan.png': PNG,
      }),
    )

    expect(table.headers).toEqual(['Name', 'Cover', 'content'])

    const [row] = table.rows
    // Ссылка на файл заменена путём внутри архива
    expect(row[1]).toBe('Tasks abc/First task def/photo.png')
    // Тело страницы без заголовка и блока свойств, ссылка на картинку переписана
    expect(row[2]).toBe('Текст страницы\n\n![](Tasks abc/First task def/inline.png)')

    // Уходят на сервер только те файлы, на которые есть ссылки
    expect(Object.keys(table.assets!).sort()).toEqual([
      'Tasks abc/First task def/inline.png',
      'Tasks abc/First task def/photo.png',
    ])
    expect(table.assets!['Tasks abc/First task def/photo.png']).toMatch(/^data:image\/png;base64,/)
  })
})
