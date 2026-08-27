import type { TableData } from './file-parsers.js'

import { parseCSV } from './file-parsers.js'
import { unzip } from './zip.js'

const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|pdf)$/i
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g

const MIME: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

const mimeOf = (path: string): string =>
  MIME[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const dirOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

const normalizeTitle = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

const toBase64 = (data: Uint8Array): string => {
  let binary = ''
  // Порциями, иначе String.fromCharCode переполняет стек на больших файлах
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Разбирает страницу Notion в Markdown: заголовок, блок свойств и тело
 */
const splitNotionPage = (text: string): { body: string; title: string } => {
  const blocks = text.split(/\r?\n\r?\n/)
  const title = (blocks[0] || '').trim().replace(/^#\s+/, '')

  // После заголовка Notion выводит свойства страницы в виде "Ключ: значение"
  const props = (blocks[1] || '').split(/\r?\n/).filter(Boolean)
  const start = props.length && props.every((line) => /^[^:\n]{1,60}: /.test(line)) ? 2 : 1

  return { body: blocks.slice(start).join('\n\n').trim(), title }
}

/**
 * Импорт экспорта Notion ("Export → Markdown & CSV").
 *
 * Из архива берётся CSV базы данных, к нему добавляется колонка с телом страницы,
 * а все ссылки на локальные файлы заменяются на путь внутри архива. Сами файлы
 * возвращаются в `assets` как data-URI — сервер грузит их в коллекцию media.
 *
 * ponytail: файлы уходят на сервер одним JSON-запросом. Для экспортов в сотни
 * мегабайт понадобится multipart-загрузка архива целиком.
 */
export const parseNotionZip = async (file: File): Promise<TableData> => {
  let entries = await unzip(await file.arrayBuffer())

  // Крупные экспорты Notion приходят как архив с архивом внутри
  if (![...entries.keys()].some((path) => path.toLowerCase().endsWith('.csv'))) {
    const nested = [...entries.keys()].find((path) => path.toLowerCase().endsWith('.zip'))
    if (nested) {
      const data = entries.get(nested)!
      entries = await unzip(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      )
    }
  }

  const csvPath = [...entries.keys()]
    .filter((path) => path.toLowerCase().endsWith('.csv'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0]

  if (!csvPath) {
    throw new Error('В архиве не найден CSV-файл базы данных Notion')
  }

  const decoder = new TextDecoder()
  const table = parseCSV(decoder.decode(entries.get(csvPath)!))

  // Все вложения архива — по пути внутри архива
  const files: Record<string, string> = {}
  for (const [path, data] of entries) {
    if (ASSET_EXT.test(path)) {
      files[path] = `data:${mimeOf(path)};base64,${toBase64(data)}`
    }
  }

  const paths = Object.keys(files)
  const byName = new Map<string, string>()
  for (const path of paths) {
    const name = path.split('/').pop()!
    if (!byName.has(name)) {
      byName.set(name, path)
    }
  }

  /** Ссылка из CSV или Markdown → путь внутри архива */
  const resolveAsset = (link: string, dir: string): string | undefined => {
    const value = safeDecode(link.trim())
    if (!value || /^(https?|data):/i.test(value)) {
      return undefined
    }
    if (files[value]) {
      return value
    }
    if (dir && files[`${dir}/${value}`]) {
      return `${dir}/${value}`
    }
    return paths.find((path) => path.endsWith(`/${value}`)) || byName.get(value.split('/').pop()!)
  }

  const used = new Set<string>()
  const csvDir = dirOf(csvPath)

  // Значения колонок "Files & media" — имена файлов через запятую
  const rows = table.rows.map((row) =>
    row.map((cell) => {
      const text = String(cell ?? '')
      if (!text) {
        return text
      }
      let found = false
      const mapped = text.split(',').map((part) => {
        const hit = resolveAsset(part, csvDir)
        if (!hit) {
          return part
        }
        found = true
        used.add(hit)
        return hit
      })
      return found ? mapped.join(',') : text
    }),
  )

  // Тела страниц: ключ — заголовок страницы, он же значение первой колонки CSV
  const pages = new Map<string, { body: string; refs: string[] }>()
  for (const [path, data] of entries) {
    if (!path.toLowerCase().endsWith('.md')) {
      continue
    }
    const dir = dirOf(path)
    const { body, title } = splitNotionPage(decoder.decode(data))
    const refs: string[] = []
    const rewritten = body.replace(MARKDOWN_IMAGE, (match, alt: string, link: string) => {
      const hit = resolveAsset(link, dir)
      if (!hit) {
        return match
      }
      refs.push(hit)
      return `![${alt}](${hit})`
    })
    pages.set(normalizeTitle(title), { body: rewritten, refs })
  }

  const headers = [...table.headers]
  const contents = rows.map((row) => {
    const page = pages.get(normalizeTitle(String(row[0] ?? '')))
    if (!page) {
      return ''
    }
    page.refs.forEach((ref) => used.add(ref))
    return page.body
  })

  if (contents.some(Boolean)) {
    const column = headers.includes('content') ? 'notion_content' : 'content'
    headers.push(column)
    rows.forEach((row, index) => row.push(contents[index]))
  }

  const assets: Record<string, string> = {}
  for (const path of used) {
    assets[path] = files[path]
  }

  return { assets, headers, rows }
}
