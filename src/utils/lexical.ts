import type { Payload } from 'payload'

import type { ImportAssets } from './upload-handler.js'

import { handleUploadField } from './upload-handler.js'

// Строка целиком состоящая из markdown-картинки: ![alt](путь)
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/

const paragraph = (children: unknown[]) => ({
  type: 'paragraph',
  children,
  direction: null,
  format: '',
  indent: 0,
  textFormat: 0,
  version: 1,
})

const textNode = (text: string) => ({
  type: 'text',
  detail: 0,
  format: 0,
  mode: 'normal',
  style: '',
  text,
  version: 1,
})

/** Коллекция для картинок из архива: media, если есть, иначе первая upload-коллекция */
const uploadCollectionOf = (payload: Payload): string | undefined => {
  // Признак upload-коллекции — добавленное при санитизации поле filename
  const collections = payload.config.collections.filter((collection) =>
    collection.fields.some((field) => 'name' in field && field.name === 'filename'),
  )
  return (collections.find((collection) => collection.slug === 'media') || collections[0])?.slug
}

/**
 * Конвертирует строку (в т.ч. markdown из Notion) в формат Lexical richText.
 * Картинки, лежащие в архиве, загружаются в media и вставляются как upload-ноды.
 */
export const convertStringToLexicalFormat = async (
  text: string,
  options: { assets?: ImportAssets; payload?: Payload } = {},
): Promise<null | Record<string, unknown>> => {
  if (!text || typeof text !== 'string') {
    return null
  }

  const { assets, payload } = options
  const relationTo = assets && payload ? uploadCollectionOf(payload) : undefined

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const children: unknown[] = []

  for (const line of lines) {
    const image = relationTo ? IMAGE_LINE.exec(line) : null

    if (image && relationTo && assets && payload) {
      const id = await handleUploadField(payload, image[2], relationTo, false, assets)
      if (typeof id === 'string') {
        children.push({
          type: 'upload',
          fields: {},
          format: '',
          id: crypto.randomUUID(),
          relationTo,
          value: id,
          version: 3,
        })
        continue
      }
    }

    children.push(paragraph([textNode(line)]))
  }

  return {
    root: {
      type: 'root',
      children: children.length ? children : [paragraph([])],
      direction: null,
      format: '',
      indent: 0,
      version: 1,
    },
  }
}
