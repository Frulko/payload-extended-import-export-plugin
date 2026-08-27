export type TableData = {
  /** Вложения из архива: путь внутри архива → data-URI (см. parseNotionZip) */
  assets?: Record<string, string>
  headers: string[]
  rows: (number | string)[][]
}

/**
 * Разбор CSV по RFC 4180: кавычки, запятые и переносы строк внутри значений
 */
const parseDelimited = (text: string, delimiter = ','): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char !== '"') {
        cell += char
      } else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        quoted = false
      }
      continue
    }

    if (char === '"' && cell === '') {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows
}

export const parseCSV = (text: string): TableData => {
  // BOM есть в экспортах Notion и Excel, иначе ломается первый заголовок
  const lines = parseDelimited(text.replace(/^\uFEFF/, '')).filter((row) =>
    row.some((cell) => cell.trim() !== ''),
  )
  if (lines.length === 0) {
    throw new Error('Файл пуст')
  }

  // Пустые заголовки отбрасываем вместе с их колонками
  const columns = lines[0].map((header, index) => ({ header: header.trim(), index }))
  const kept = columns.filter(({ header }) => header !== '')

  if (kept.length === 0) {
    throw new Error('Не найдены заголовки колонок')
  }

  return {
    headers: kept.map(({ header }) => header),
    rows: lines.slice(1).map((row) => kept.map(({ index }) => (row[index] ?? '').trim())),
  }
}

export const parseJSON = (text: string): TableData => {
  const data = JSON.parse(text)
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('JSON должен содержать массив объектов')
  }

  // Проверяем, что первый элемент - объект
  if (typeof data[0] !== 'object' || data[0] === null) {
    throw new Error('JSON должен содержать массив объектов')
  }

  const headers = Object.keys(data[0]).filter((key) => key && key.trim() !== '') // Фильтруем пустые ключи

  if (headers.length === 0) throw new Error('Не найдены заголовки полей')

  const rows = data.map((item) => {
    if (typeof item !== 'object' || item === null) {
      // Если элемент не объект, создаем пустую строку
      return headers.map(() => '')
    }
    return headers.map((header) => {
      const value = item[header]
      // Конвертируем все значения в строки, обрабатывая null/undefined
      if (value === null || value === undefined) {
        return ''
      }
      if (typeof value === 'object') {
        return JSON.stringify(value)
      }
      return String(value)
    })
  })

  return { headers, rows }
}

export const parseXLSX = async (file: File): Promise<TableData> => {
  // xlsx весит больше остального плагина — грузим только когда реально нужен
  const XLSX = await import('xlsx')

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })

        // Берем первый лист
        const firstSheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[firstSheetName]

        // Конвертируем в JSON
        const jsonData = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
        })

        if (!Array.isArray(jsonData) || jsonData.length === 0) {
          throw new Error('XLSX файл пуст')
        }

        const headers = (jsonData[0] as any[]).map((h) => String(h || ''))
        const rows = jsonData
          .slice(1)
          .map((row: any) => headers.map((_, index) => String(row[index] || '')))

        resolve({ headers, rows })
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Ошибка при обработке XLSX файла'))
      }
    }
    reader.onerror = () => reject(new Error('Ошибка чтения файла'))
    reader.readAsArrayBuffer(file)
  })
}

export const readFile = async (file: File): Promise<TableData> => {
  let parsedData: TableData

  if (file.name.toLowerCase().endsWith('.csv')) {
    const text = await file.text()
    parsedData = parseCSV(text)
  } else if (file.name.toLowerCase().endsWith('.json')) {
    const text = await file.text()
    try {
      parsedData = parseJSON(text)
    } catch (jsonError) {
      throw new Error(
        `Ошибка при парсинге JSON: ${
          jsonError instanceof Error ? jsonError.message : 'Неизвестная ошибка'
        }`,
      )
    }
  } else if (
    file.name.toLowerCase().endsWith('.xlsx') ||
    file.name.toLowerCase().endsWith('.xls')
  ) {
    parsedData = await parseXLSX(file)
  } else if (file.name.toLowerCase().endsWith('.zip')) {
    // Грузим разбор архива по требованию — он нужен только для экспортов Notion
    const { parseNotionZip } = await import('./notion.js')
    parsedData = await parseNotionZip(file)
  } else {
    throw new Error('Поддерживаются файлы: CSV, JSON, XLSX, XLS, ZIP (экспорт Notion)')
  }

  // Валидация данных перед установкой состояния
  if (!parsedData || !parsedData.headers || !Array.isArray(parsedData.rows)) {
    throw new Error('Неправильная структура данных в файле')
  }

  return parsedData
}
