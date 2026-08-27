import type { Endpoint, PayloadRequest, RelationshipField } from 'payload'

import type { ImportAssets } from '../utils/upload-handler.js'

import { convertStringToLexicalFormat } from '../utils/lexical.js'
import { handleUploadField } from '../utils/upload-handler.js'

export interface ImportRequest {
  /** Файлы из архива: путь внутри архива → data-URI (экспорт Notion) */
  assets?: Record<string, string>
  collection: string
  data: Record<string, any>[]
  settings: {
    compareField?: string
    fieldMappings: { collectionField: string; csvField: string }[]
    locale?: string
    mode: 'create' | 'update' | 'upsert'
  }
}

export interface ImportResponse {
  created: number
  details?: any[]
  errors: string[]
  message: string
  success: boolean
  updated: number
}

export const importEndpoint: Endpoint = {
  handler: async (req: PayloadRequest) => {
    try {
      // Читаем body как ReadableStream
      let requestData: ImportRequest

      if (req.body) {
        const reader = req.body.getReader()
        const decoder = new TextDecoder()
        let bodyText = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          bodyText += decoder.decode(value, { stream: true })
        }

        requestData = JSON.parse(bodyText) as ImportRequest
      } else {
        throw new Error('Не удается получить данные из запроса')
      }

      const { assets: assetFiles, collection, data, settings } = requestData
      const { compareField, fieldMappings, locale, mode } = settings

      const assets: ImportAssets | undefined = assetFiles
        ? { files: assetFiles, uploaded: new Map() }
        : undefined

      // Валидация входных данных
      if (!collection || !data || !Array.isArray(data)) {
        return Response.json(
          {
            created: 0,
            errors: ['Отсутствуют обязательные поля: collection, data'],
            message: 'Некорректные данные для импорта',
            success: false,
            updated: 0,
          },
          { status: 400 },
        )
      }

      let created = 0
      let updated = 0
      const errors: string[] = []
      const details: any[] = []

      // Маппинг данных согласно настройкам полей
      const mappedDataPromises = data.map(async (row, index) => {
        try {
          const mapped: Record<string, any> = {}

          // Получаем конфигурацию коллекции для определения типов полей
          const collectionConfig = req.payload.config.collections?.find(
            (col) => col.slug === collection,
          )

          // Создаем карту типов полей для быстрого доступа
          const fieldTypeMap = new Map<string, string>()
          if (collectionConfig) {
            const mapFieldTypes = (fields: any[], prefix = '') => {
              fields.forEach((field) => {
                if (!field.name) {
                  return
                }
                const fieldName = prefix ? `${prefix}.${field.name}` : field.name
                fieldTypeMap.set(fieldName, field.type)

                // Обрабатываем вложенные поля
                if (field.fields && Array.isArray(field.fields)) {
                  mapFieldTypes(field.fields, fieldName)
                }
              })
            }
            mapFieldTypes(collectionConfig.fields)

            // Отладочная информация
            if (process.env.NODE_ENV === 'development') {
              console.log('Доступные поля в схеме:', Array.from(fieldTypeMap.keys()))
              console.log(
                'Маппинги полей:',
                fieldMappings.map((m) => `${m.csvField} -> ${m.collectionField}`),
              )
            }
          }

          for (const { collectionField, csvField } of fieldMappings) {
            if (row[csvField] !== undefined && row[csvField] !== '') {
              // Для поля id просто присваиваем значение без дополнительной обработки
              if (collectionField === 'id') {
                mapped[collectionField] = row[csvField]
                continue
              }

              // Получаем тип поля
              const fieldType = fieldTypeMap.get(collectionField)

              // Пропускаем поля, которых нет в схеме коллекции (кроме id)
              if (!fieldType && collectionField !== 'id') {
                if (process.env.NODE_ENV === 'development') {
                  console.warn(
                    `Поле "${collectionField}" не найдено в схеме коллекции "${collection}"`,
                  )
                }
                continue
              }

              // Обработка специальных типов полей
              let value = row[csvField]

              // Обработка richText полей
              if (fieldType === 'richText') {
                value = await convertStringToLexicalFormat(value, { assets, payload: req.payload })
              }

              if (fieldType === 'relationship') {
                const isMultiple = collectionConfig?.fields?.find((_field) => {
                  const field = _field as unknown as RelationshipField
                  return field?.name === collectionField && field.relationTo && field.hasMany
                })

                if (isMultiple) {
                  // Для множественных связей ожидаем массив значений
                  const items =
                    typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value
                  value = items.map((item: any) => {
                    return {
                      id: item, // Предполагаем, что это ID связанной записи
                    }
                  })
                } else {
                  // Для одиночных связей ожидаем объект с ID
                  value = {
                    id: value, // Предполагаем, что это ID связанной записи
                  }
                }
              }

              // Обработка upload полей
              if (fieldType === 'upload') {
                const uploadField = collectionConfig?.fields?.find((_field) => {
                  const field = _field as any
                  return field?.name === collectionField && field.type === 'upload'
                }) as any

                if (uploadField && uploadField.relationTo) {
                  const hasMany = uploadField.hasMany || false

                  // Обрабатываем загрузку изображений
                  value = await handleUploadField(
                    req.payload,
                    value,
                    uploadField.relationTo,
                    hasMany,
                    assets,
                  )
                }
              }

              // Обработка полей типа number
              if (fieldType === 'number') {
                if (typeof value === 'string') {
                  // Обработка специальных строковых значений
                  if (
                    value.toLowerCase().includes('есть') ||
                    value.toLowerCase().includes('наличии')
                  ) {
                    value = 1
                  } else if (
                    value.toLowerCase().includes('нет') ||
                    value.toLowerCase().includes('отсутствует')
                  ) {
                    value = 0
                  } else {
                    // Пытаемся извлечь число из строки
                    const numValue = parseFloat(value.replace(/[^\d.,]/g, '').replace(',', '.'))
                    value = isNaN(numValue) ? 0 : numValue
                  }
                } else if (typeof value !== 'number') {
                  value = 0
                }
              }

              // Обработка массивов (array fields)
              if (fieldType === 'array') {
                // Для array полей обеспечиваем правильную структуру
                if (typeof value === 'string') {
                  try {
                    value = JSON.parse(value)
                  } catch {
                    // Если не JSON, оставляем как строку
                  }
                }

                // Проверяем, что это массив
                if (!Array.isArray(value)) {
                  value = []
                }

                // Обрабатываем каждый элемент массива
                if (Array.isArray(value)) {
                  value = value.map((item, index) => {
                    if (typeof item === 'object' && item !== null) {
                      const processedItem = { ...item }

                      // Обеспечиваем наличие id для каждого элемента
                      if (!processedItem.id) {
                        processedItem.id = `item_${index}_${Date.now()}`
                      }

                      // Обрабатываем все поля внутри объекта как потенциальные relationship
                      Object.keys(processedItem).forEach((key) => {
                        const subFieldType = fieldTypeMap.get(`${collectionField}.${key}`)

                        if (subFieldType === 'relationship') {
                          const subValue = processedItem[key]

                          if (Array.isArray(subValue)) {
                            // Для множественных связей
                            processedItem[key] = subValue.map((val) =>
                              typeof val === 'string' ? { id: val } : val,
                            )
                          } else if (typeof subValue === 'string') {
                            // Для одиночных связей
                            processedItem[key] = { id: subValue }
                          }
                        }
                      })

                      return processedItem
                    }
                    return item
                  })
                }
              }

              mapped[collectionField] = value
            }
          }

          // Добавляем значения по умолчанию для обязательных полей только при создании
          if (collectionConfig && mode === 'create') {
            // Обрабатываем все поля коллекции
            const processFields = (fields: any[], prefix = '') => {
              fields.forEach((field) => {
                if (!field.name) {
                  return
                }

                const fieldName = prefix ? `${prefix}.${field.name}` : field.name

                // Проверяем, нужно ли заполнить поле
                const isRequired = field.required === true
                const hasDefaultValue = field.defaultValue !== undefined
                const isNotMapped = mapped[fieldName] === undefined

                if (isRequired && hasDefaultValue && isNotMapped) {
                  // Если defaultValue это функция
                  if (typeof field.defaultValue === 'function') {
                    try {
                      mapped[fieldName] = field.defaultValue({
                        user: req.user,
                      })
                    } catch (error) {
                      console.warn(`Ошибка при вычислении defaultValue для ${fieldName}:`, error)
                    }
                  } else {
                    // Если defaultValue это значение
                    mapped[fieldName] = field.defaultValue
                  }
                }

                // Обрабатываем вложенные поля для group, tabs, etc.
                if (field.fields && Array.isArray(field.fields)) {
                  processFields(field.fields, fieldName)
                }
              })
            }

            processFields(collectionConfig.fields)
          }

          return { index, mapped, original: row }
        } catch (error) {
          errors.push(`Ошибка маппинга строки ${index + 1}: ${error}`)
          return null
        }
      })

      // Ожидаем выполнения всех промисов
      const mappedDataResults = await Promise.all(mappedDataPromises)
      const mappedData = mappedDataResults.filter(Boolean)

      // Обработка данных согласно выбранному режиму
      for (const item of mappedData) {
        if (!item) {
          continue
        }

        try {
          if (mode === 'create') {
            // Только создание новых записей
            // Убираем поле id из данных для создания, т.к. Payload создает ID автоматически
            const createData = { ...item.mapped }
            delete createData.id

            const result = await req.payload.create({
              collection: collection as any,
              data: createData,
              locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
            })
            created++
            details.push({
              id: result.id,
              action: 'created',
              data: createData,
            })
          } else if (mode === 'update') {
            // Только обновление существующих записей
            if (!compareField || !item.mapped[compareField]) {
              errors.push(
                `Строка ${item.index + 1}: отсутствует поле для сравнения "${compareField}"`,
              )
              continue
            }

            const existing = await req.payload.find({
              collection: collection as any,
              limit: 1,
              locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
              where:
                compareField === 'id'
                  ? {
                      id: {
                        equals: item.mapped[compareField],
                      },
                    }
                  : {
                      [compareField]: {
                        equals: item.mapped[compareField],
                      },
                    },
            })

            if (existing.docs.length > 0) {
              // Для обновления записей объединяем существующие данные с новыми
              // чтобы избежать валидации обязательных полей
              const existingData = existing.docs[0]
              const mergedData = { ...existingData, ...item.mapped }

              const _result = await req.payload.update({
                id: existing.docs[0].id,
                collection: collection as any,
                data: mergedData,
                locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
              })
              updated++
              details.push({
                id: existing.docs[0].id,
                action: 'updated',
                data: item.mapped,
              })
            } else {
              errors.push(
                `Строка ${item.index + 1}: запись с ${compareField}="${item.mapped[compareField]}" не найдена`,
              )
            }
          } else if (mode === 'upsert') {
            // Создание или обновление
            if (compareField && item.mapped[compareField]) {
              const existing = await req.payload.find({
                collection: collection as any,
                limit: 1,
                locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
                where:
                  compareField === 'id'
                    ? {
                        id: {
                          equals: item.mapped[compareField],
                        },
                      }
                    : {
                        [compareField]: {
                          equals: item.mapped[compareField],
                        },
                      },
              })

              if (existing.docs.length > 0) {
                // Для обновления записей объединяем существующие данные с новыми
                const existingData = existing.docs[0]
                const mergedData = { ...existingData, ...item.mapped }

                const _result = await req.payload.update({
                  id: existing.docs[0].id,
                  collection: collection as any,
                  data: mergedData,
                  locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
                })
                updated++
                details.push({
                  id: existing.docs[0].id,
                  action: 'updated',
                  data: item.mapped,
                })
              } else {
                const result = await req.payload.create({
                  collection: collection as any,
                  data: item.mapped,
                  locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
                })
                created++
                details.push({
                  id: result.id,
                  action: 'created',
                  data: item.mapped,
                })
              }
            } else {
              // Если нет поля для сравнения, просто создаем
              const result = await req.payload.create({
                collection: collection as any,
                data: item.mapped,
                locale: (locale || req.locale || 'en') as 'bg' | 'en' | 'ru' | 'uk',
              })
              created++
              details.push({
                id: result.id,
                action: 'created',
                data: item.mapped,
              })
            }
          }
        } catch (error: any) {
          // Добавляем подробную информацию об ошибке
          let errorMessage = `Строка ${item.index + 1}: `

          if (error.message) {
            errorMessage += error.message
          } else {
            errorMessage += String(error)
          }

          // В development режиме добавляем отладочную информацию
          if (process.env.NODE_ENV === 'development') {
            console.error('Ошибка при создании/обновлении записи:', {
              error: error.message || error,
              data: item.mapped,
              collection,
            })
          }

          errors.push(errorMessage)
        }
      }

      const response: ImportResponse = {
        created,
        details: process.env.NODE_ENV === 'development' ? details : undefined,
        errors,
        message: `Импорт завершен: создано ${created}, обновлено ${updated} записей`,
        success: true,
        updated,
      }

      return Response.json(response)
    } catch (error: any) {
      console.error('Ошибка импорта:', error)
      const response: ImportResponse = {
        created: 0,
        errors: [error.message || 'Неизвестная ошибка'],
        message: 'Внутренняя ошибка сервера',
        success: false,
        updated: 0,
      }
      return Response.json(response, { status: 500 })
    }
  },
  path: '/import',

  method: 'post',
}
