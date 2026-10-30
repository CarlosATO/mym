export interface PriceDecimalValidationResult {
  isValid: boolean
  value: number | null
  raw: string
  decimals: number
  isEmpty: boolean
  error?: 'EMPTY' | 'INVALID_FORMAT' | 'INVALID_NUMBER' | 'EXCEEDS_MAX_DECIMALS'
  errorMessage?: string
}

export function validatePriceDecimal(
  input: string | number | null | undefined,
  maxDecimals: number = 2,
): PriceDecimalValidationResult {
  if (input === null || input === undefined) {
    return {
      isValid: false,
      value: null,
      raw: '',
      decimals: 0,
      isEmpty: true,
      error: 'EMPTY',
      errorMessage: 'El campo no puede estar vacío',
    }
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      return {
        isValid: false,
        value: null,
        raw: String(input),
        decimals: 0,
        isEmpty: false,
        error: 'INVALID_NUMBER',
        errorMessage: 'Debe ser un número válido mayor o igual a 0',
      }
    }
    const decStr = input.toString().split('.')[1] || ''
    if (decStr.length > maxDecimals) {
      return {
        isValid: false,
        value: input,
        raw: String(input),
        decimals: decStr.length,
        isEmpty: false,
        error: 'EXCEEDS_MAX_DECIMALS',
        errorMessage: `El valor no puede tener más de ${maxDecimals} decimales`,
      }
    }
    return {
      isValid: true,
      value: input,
      raw: String(input),
      decimals: decStr.length,
      isEmpty: false,
    }
  }

  const raw = String(input).trim()
  if (raw === '') {
    return {
      isValid: false,
      value: null,
      raw,
      decimals: 0,
      isEmpty: true,
      error: 'EMPTY',
      errorMessage: 'El campo no puede estar vacío',
    }
  }

  let s = raw.replace(/[$€£\s]/g, '')
  if (s === '') {
    return {
      isValid: false,
      value: null,
      raw,
      decimals: 0,
      isEmpty: true,
      error: 'EMPTY',
      errorMessage: 'El campo no puede estar vacío',
    }
  }

  if (/[.,]{2,}/.test(s) || !/^[0-9.,]+$/.test(s)) {
    return {
      isValid: false,
      value: null,
      raw,
      decimals: 0,
      isEmpty: false,
      error: 'INVALID_FORMAT',
      errorMessage: 'Formato numérico inválido',
    }
  }

  const dotCount = (s.match(/\./g) || []).length
  const commaCount = (s.match(/,/g) || []).length

  if (dotCount >= 1 && commaCount >= 1) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.')
    } else {
      s = s.replace(/,/g, '')
    }
  } else if (commaCount > 1) {
    s = s.replace(/,/g, '')
  } else if (commaCount === 1) {
    s = s.replace(',', '.')
  } else if (dotCount > 1) {
    s = s.replace(/\./g, '')
  }

  if (s.startsWith('.')) s = '0' + s

  const num = Number(s)
  if (!Number.isFinite(num) || num < 0) {
    return {
      isValid: false,
      value: null,
      raw,
      decimals: 0,
      isEmpty: false,
      error: 'INVALID_NUMBER',
      errorMessage: 'Debe ser un número válido mayor o igual a 0',
    }
  }

  const decPart = s.split('.')[1] || ''
  if (decPart.length > maxDecimals) {
    return {
      isValid: false,
      value: num,
      raw,
      decimals: decPart.length,
      isEmpty: false,
      error: 'EXCEEDS_MAX_DECIMALS',
      errorMessage: `El valor no puede tener más de ${maxDecimals} decimales`,
    }
  }

  return {
    isValid: true,
    value: num,
    raw,
    decimals: decPart.length,
    isEmpty: false,
  }
}

export function parseCurrencyDecimal(
  input: string | number | null | undefined,
  maxDecimals: number = 2,
): number | null {
  const result = validatePriceDecimal(input, maxDecimals)
  return result.isValid ? result.value : null
}

export function formatPriceDisplay(
  amount: number | null | undefined,
  currency: string = 'CLP',
  maxDecimals: number = 2,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—'
  const hasDecimals = amount % 1 !== 0
  return amount.toLocaleString('es-CL', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: maxDecimals,
  })
}

