import { useState } from 'react'

import { ImportRequest, ImportResponse } from '../endpoints/import.js'
import { CollectionField, ImportSettings } from '../types/import.js'

export type ImportStep = 'complete' | 'configure' | 'processing' | 'upload'

export interface ImportProgress {
  errors: string[]
  failed: number
  isLoading?: boolean
  processed: number
  success: number
  total: number
}

export const useImportManager = (collectionFields: CollectionField[]) => {
  const [currentStep, setCurrentStep] = useState<ImportStep>('upload')
  const [importProgress, setImportProgress] = useState<ImportProgress>({
    errors: [],
    failed: 0,
    processed: 0,
    success: 0,
    total: 0,
  })

  const goToStep = (step: ImportStep) => {
    setCurrentStep(step)
  }

  const startImport = async (
    settings: ImportSettings,
    data: Record<string, any>[],
    collection: string,
    assets?: Record<string, string>,
  ) => {
    setCurrentStep('processing')
    setImportProgress((prev) => ({ ...prev, errors: [], isLoading: true }))

    try {
      const importRequest: ImportRequest = {
        assets,
        collection,
        data,
        settings,
      }

      // Вызываем наш Payload endpoint
      const response = await fetch('/api/import', {
        body: JSON.stringify(importRequest),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      const result: ImportResponse = await response.json()

      if (result.success) {
        setImportProgress((prev) => ({
          ...prev,
          errors: result.errors,
          failed: result.errors.length,
          isLoading: false,
          processed: prev.total,
          success: result.created + result.updated,
        }))
        setCurrentStep('complete')
      } else {
        setImportProgress((prev) => ({
          ...prev,
          errors: [result.message, ...result.errors],
          isLoading: false,
        }))
        setCurrentStep('complete')
      }
    } catch (error) {
      setImportProgress((prev) => ({
        ...prev,
        errors: ['Ошибка подключения к серверу'],
        isLoading: false,
      }))
      setCurrentStep('complete')
    }
  }

  const resetImport = () => {
    setCurrentStep('upload')
    setImportProgress({
      errors: [],
      failed: 0,
      processed: 0,
      success: 0,
      total: 0,
    })
  }

  const setTotalRecords = (total: number) => {
    setImportProgress((prev) => ({ ...prev, total }))
  }

  return {
    collectionFields,
    currentStep,
    goToStep,
    importProgress,
    resetImport,
    setTotalRecords,
    startImport,
  }
}
