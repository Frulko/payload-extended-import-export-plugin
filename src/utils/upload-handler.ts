import type { Payload } from 'payload'

export interface UploadFieldData {
  url: string
  alt?: string
  filename?: string
}

export interface ImportAssets {
  /** Путь файла внутри архива → data-URI */
  files: Record<string, string>
  /** Кэш одного импорта: путь → загрузка файла, чтобы не грузить его дважды */
  uploaded: Map<string, Promise<null | string>>
}

/**
 * Обрабатывает загрузку изображений для upload полей.
 * Значение — URL или путь файла внутри импортируемого архива (см. assets).
 */
export const handleUploadField = async (
  payload: Payload,
  value: string | string[] | null | undefined,
  relationTo: string,
  hasMany: boolean = false,
  assets?: ImportAssets,
): Promise<null | string | string[]> => {
  if (!value) {
    return null
  }

  try {
    if (hasMany) {
      // Обрабатываем массив изображений
      let urls: string[] = []

      if (Array.isArray(value)) {
        // Уже массив
        urls = value
      } else if (typeof value === 'string') {
        // Попытаемся распарсить как JSON
        try {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed)) {
            urls = parsed
          } else {
            // Если не JSON массив, то разбиваем по запятым
            urls = value
              .split(',')
              .map((url) => url.trim())
              .filter(Boolean)
          }
        } catch {
          // Если JSON не парсится, разбиваем по запятым
          urls = value
            .split(',')
            .map((url) => url.trim())
            .filter(Boolean)
        }
      }

      const uploadPromises = urls.map((url) =>
        processUploadUrl(payload, url, relationTo, 3, assets),
      )
      // Обрабатываем изображения пачками, чтобы избежать конкурентных записей в MongoDB
      const results = await processInBatches(uploadPromises, 3) // Максимум 3 одновременно
      return results.filter(Boolean) as string[] // Убираем null значения
    } else {
      // Обрабатываем одиночное изображение
      let url = ''

      if (typeof value === 'string') {
        // Попытаемся распарсить как JSON
        try {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed) && parsed.length > 0) {
            url = parsed[0]
          } else if (typeof parsed === 'string') {
            url = parsed
          } else {
            url = value.trim()
          }
        } catch {
          // Если JSON не парсится, используем как есть
          url = value.trim()
        }
      } else if (Array.isArray(value) && value.length > 0) {
        url = value[0]
      }

      if (!url) {
        return null
      }

      return await processUploadUrl(payload, url, relationTo, 3, assets)
    }
  } catch (error) {
    // Логирование ошибки для отладки
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.error('Ошибка при обработке upload поля:', error)
    }
    return null
  }
}

/**
 * Обрабатывает промисы пачками, чтобы избежать перегрузки MongoDB
 */
const processInBatches = async <T>(promises: Promise<T>[], batchSize: number): Promise<T[]> => {
  const results: T[] = []

  for (let i = 0; i < promises.length; i += batchSize) {
    const batch = promises.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch)
    results.push(...batchResults)

    // Небольшая задержка между пачками
    if (i + batchSize < promises.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return results
}

/**
 * Обрабатывает загрузку одного изображения по URL с повторными попытками
 */
const processUploadUrl = async (
  payload: Payload,
  url: string,
  relationTo: string,
  retries: number = 3,
  assets?: ImportAssets,
): Promise<null | string> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Файл из архива (экспорт Notion) — берём его содержимое напрямую, без сети
      const asset = assets ? findAsset(assets, url) : undefined
      if (assets && asset) {
        return await uploadAsset(payload, asset, relationTo, assets)
      }

      if (!isValidUrl(url)) {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.warn(`Некорректный URL: ${url}`)
        }
        return null
      }

      // Проверяем, может уже есть такое изображение в коллекции
      const existingMedia = await payload.find({
        collection: relationTo,
        where: {
          url: {
            equals: url,
          },
        },
        limit: 1,
      })

      if (existingMedia.docs.length > 0) {
        return String(existingMedia.docs[0].id)
      }

      // Скачиваем изображение
      const response = await fetch(url)
      if (!response.ok) {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.warn(`Не удалось скачать изображение: ${url} - статус: ${response.status}`)
        }
        return null
      }

      const contentType = response.headers.get('content-type') || ''

      // Проверяем, что это действительно изображение
      if (!contentType.startsWith('image/')) {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.warn(`URL не содержит изображение: ${url} - content-type: ${contentType}`)
        }
        return null
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const filename = extractFilenameFromUrl(url)

      // Создаем объект файла
      const file = {
        data: buffer,
        mimetype: contentType,
        name: filename,
        size: buffer.length,
      }

      // Создаем запись в коллекции media
      const mediaDoc = await payload.create({
        collection: relationTo,
        data: {
          alt: `${filename}`,
          // Добавляем другие поля, которые могут быть в коллекции media
        },
        file,
      })

      return String(mediaDoc.id)
    } catch (error) {
      const isLastAttempt = attempt === retries

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.error(`Попытка ${attempt}/${retries} загрузки изображения ${url}:`, error)
      }

      // Специальная обработка сетевых ошибок
      if (error && typeof error === 'object' && 'code' in error) {
        const errorCode = (error as { code: string | number }).code

        // Сетевые ошибки
        if (
          errorCode === 'ENOTFOUND' ||
          errorCode === 'ECONNREFUSED' ||
          errorCode === 'ETIMEDOUT'
        ) {
          if (isLastAttempt) {
            if (process.env.NODE_ENV === 'development') {
              // eslint-disable-next-line no-console
              console.warn(`Сетевая ошибка после ${retries} попыток для ${url}. Пропускаем.`)
            }
            return null
          }
          // Ждем перед повторной попыткой
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
          continue
        }

        // MongoDB WriteConflict ошибки
        if (errorCode === 112 || (error as { codeName?: string }).codeName === 'WriteConflict') {
          if (isLastAttempt) {
            if (process.env.NODE_ENV === 'development') {
              // eslint-disable-next-line no-console
              console.warn(`MongoDB WriteConflict после ${retries} попыток для ${url}. Пропускаем.`)
            }
            return null
          }
          // Для MongoDB конфликтов ждем дольше и используем экспоненциальную задержку
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000) // Max 10 секунд
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
      }

      if (isLastAttempt) {
        return null
      }

      // Ждем перед повторной попыткой
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }

  return null
}

/**
 * Ищет файл архива по значению ячейки (путь внутри архива, возможно URL-encoded)
 */
const findAsset = (assets: ImportAssets, value: string): string | undefined => {
  const path = value.trim()
  if (assets.files[path]) {
    return path
  }
  try {
    const decoded = decodeURIComponent(path)
    return assets.files[decoded] ? decoded : undefined
  } catch {
    return undefined
  }
}

/**
 * Создаёт запись в коллекции media из файла архива
 */
const uploadAsset = (
  payload: Payload,
  path: string,
  relationTo: string,
  assets: ImportAssets,
): Promise<null | string> => {
  // Кэшируем промис, а не результат: строки импортируются параллельно и одну
  // и ту же картинку иначе загрузят несколько раз.
  // ponytail: дедупликация живёт только внутри одного импорта, повторный импорт
  // того же архива создаст новые записи в media.
  const key = `${relationTo}:${path}`
  const pending =
    assets.uploaded.get(key) || createMediaFromAsset(payload, path, relationTo, assets)
  assets.uploaded.set(key, pending)
  return pending
}

const createMediaFromAsset = async (
  payload: Payload,
  path: string,
  relationTo: string,
  assets: ImportAssets,
): Promise<null | string> => {
  const parsed = /^data:([^;]+);base64,(.*)$/s.exec(assets.files[path])
  if (!parsed) {
    return null
  }

  const data = Buffer.from(parsed[2], 'base64')
  const name = path.split('/').pop() || 'file'

  const mediaDoc = await payload.create({
    collection: relationTo,
    data: { alt: name },
    file: { data, mimetype: parsed[1], name, size: data.length },
  })

  return String(mediaDoc.id)
}

/**
 * Проверяет валидность URL
 */
const isValidUrl = (url: string): boolean => {
  try {
    new URL(url)
    return true // Просто проверяем, что URL валидный, без проверки расширения
  } catch {
    return false
  }
}

/**
 * Извлекает имя файла из URL
 */
const extractFilenameFromUrl = (url: string): string => {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.split('/').pop() || 'image.jpg'

    // Убираем query параметры из имени файла
    return filename.split('?')[0] || 'image.jpg'
  } catch {
    return 'image.jpg'
  }
}
