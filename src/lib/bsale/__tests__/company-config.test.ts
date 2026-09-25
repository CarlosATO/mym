/**
 * Tests focales del resolver BSale multiempresa.
 *
 * NO utiliza secretos reales. Solo verifica la lógica de resolución
 * con valores ficticios en variables de entorno.
 *
 * Ejecutar con: npx ts-node --project tsconfig.test.json src/lib/bsale/__tests__/company-config.test.ts
 * o con el runner de tests del proyecto si está configurado.
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

// ─── Helper para aislar env vars entre tests ─────────────────────────────────
type EnvSnapshot = Record<string, string | undefined>

function setEnv(vars: EnvSnapshot) {
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  })
}

// ─── Re-import con eval para forzar re-lectura de env en cada test ────────────
// company-config lee process.env en el momento de la llamada (no a nivel módulo),
// por lo que el import estático funciona correctamente.
import { getBsaleConfigForCompany, KNOWN_COMPANY_IDS } from '../company-config'

const CAYLO_ID = KNOWN_COMPANY_IDS.CAYLO
const AMIMASCOTA_ID = KNOWN_COMPANY_IDS.AMIMASCOTA
const UNKNOWN_ID = 'd9000000-0000-0000-0000-000000000009'

// Tokens ficticios — no son valores reales
const FAKE_TOKEN_CAYLO = 'fake-caylo-token-abc123'
const FAKE_TOKEN_AMIMASCOTA = 'fake-amimascota-token-xyz789'
const FAKE_TOKEN_LEGACY = 'fake-legacy-token-legacy000'
const FAKE_BASE_URL = 'https://api.bsale.cl/v1'

describe('getBsaleConfigForCompany', () => {
  let saved: EnvSnapshot

  beforeEach(() => {
    // Guarda variables actuales
    saved = {
      BSALE_API_BASE_URL: process.env.BSALE_API_BASE_URL,
      BSALE_ACCESS_TOKEN: process.env.BSALE_ACCESS_TOKEN,
      BSALE_ACCESS_TOKEN_CAYLO: process.env.BSALE_ACCESS_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: process.env.BSALE_ACCESS_TOKEN_AMIMASCOTA,
    }
    // Limpia todas para cada test
    setEnv({
      BSALE_API_BASE_URL: undefined,
      BSALE_ACCESS_TOKEN: undefined,
      BSALE_ACCESS_TOKEN_CAYLO: undefined,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: undefined,
    })
  })

  afterEach(() => {
    setEnv(saved)
  })

  // ── 1. CAYLO → token CAYLO ────────────────────────────────────────────────
  it('CAYLO → devuelve BSALE_ACCESS_TOKEN_CAYLO', () => {
    setEnv({
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: FAKE_TOKEN_AMIMASCOTA,
    })
    const config = getBsaleConfigForCompany(CAYLO_ID)
    assert.equal(config.accessToken, FAKE_TOKEN_CAYLO, 'Token de CAYLO debe ser BSALE_ACCESS_TOKEN_CAYLO')
    assert.equal(config.companyId, CAYLO_ID)
  })

  // ── 2. AMIMASCOTA → token AMIMASCOTA ─────────────────────────────────────
  it('AMIMASCOTA → devuelve BSALE_ACCESS_TOKEN_AMIMASCOTA', () => {
    setEnv({
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: FAKE_TOKEN_AMIMASCOTA,
    })
    const config = getBsaleConfigForCompany(AMIMASCOTA_ID)
    assert.equal(config.accessToken, FAKE_TOKEN_AMIMASCOTA, 'Token de AMIMASCOTA debe ser BSALE_ACCESS_TOKEN_AMIMASCOTA')
    assert.equal(config.companyId, AMIMASCOTA_ID)
  })

  // ── 3. CAYLO fallback legacy → BSALE_ACCESS_TOKEN ─────────────────────────
  it('CAYLO fallback legacy: usa BSALE_ACCESS_TOKEN cuando BSALE_ACCESS_TOKEN_CAYLO no existe', () => {
    setEnv({
      BSALE_ACCESS_TOKEN: FAKE_TOKEN_LEGACY,
      BSALE_ACCESS_TOKEN_CAYLO: undefined, // no definido
      BSALE_ACCESS_TOKEN_AMIMASCOTA: FAKE_TOKEN_AMIMASCOTA,
    })
    const config = getBsaleConfigForCompany(CAYLO_ID)
    assert.equal(config.accessToken, FAKE_TOKEN_LEGACY, 'CAYLO debe usar BSALE_ACCESS_TOKEN como fallback cuando no hay CAYLO-específico')
  })

  // ── 4. AMIMASCOTA sin token → error ───────────────────────────────────────
  it('AMIMASCOTA sin token → lanza error explícito', () => {
    setEnv({
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: undefined,
    })
    assert.throws(
      () => getBsaleConfigForCompany(AMIMASCOTA_ID),
      (err: Error) => {
        assert.ok(err.message.includes('AMIMASCOTA'), 'Error debe mencionar AMIMASCOTA')
        assert.ok(!err.message.includes(FAKE_TOKEN_CAYLO), 'Error NO debe incluir tokens')
        return true
      }
    )
  })

  // ── 5. company_id desconocido → error ─────────────────────────────────────
  it('company_id desconocido → lanza error explícito', () => {
    setEnv({
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: FAKE_TOKEN_AMIMASCOTA,
    })
    assert.throws(
      () => getBsaleConfigForCompany(UNKNOWN_ID),
      (err: Error) => {
        assert.ok(err.message.includes('unknown company_id'), 'Error debe indicar company_id desconocido')
        return true
      }
    )
  })

  // ── 6. AMIMASCOTA NO hace fallback al token de CAYLO ─────────────────────
  it('AMIMASCOTA NO usa BSALE_ACCESS_TOKEN_CAYLO como fallback', () => {
    setEnv({
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN: FAKE_TOKEN_LEGACY,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: undefined,
    })
    assert.throws(
      () => getBsaleConfigForCompany(AMIMASCOTA_ID),
      (err: Error) => {
        assert.ok(err.message.includes('AMIMASCOTA'), 'Debe fallar con error de AMIMASCOTA, no usar CAYLO')
        return true
      }
    )
  })

  // ── 7. baseUrl usa valor de env si existe ─────────────────────────────────
  it('baseUrl → usa BSALE_API_BASE_URL del env', () => {
    const customUrl = 'https://custom.bsale.api/v2'
    setEnv({
      BSALE_API_BASE_URL: customUrl,
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
      BSALE_ACCESS_TOKEN_AMIMASCOTA: FAKE_TOKEN_AMIMASCOTA,
    })
    const config = getBsaleConfigForCompany(CAYLO_ID)
    assert.equal(config.baseUrl, customUrl)
  })

  // ── 8. baseUrl usa default cuando env no está ─────────────────────────────
  it('baseUrl → usa default cuando BSALE_API_BASE_URL no está en env', () => {
    setEnv({
      BSALE_API_BASE_URL: undefined,
      BSALE_ACCESS_TOKEN_CAYLO: FAKE_TOKEN_CAYLO,
    })
    const config = getBsaleConfigForCompany(CAYLO_ID)
    assert.equal(config.baseUrl, FAKE_BASE_URL)
  })
})

// Ejecutar si se llama directamente con ts-node
console.log('✅ Tests del resolver BSale multiempresa cargados. Ejecutar con el test runner del proyecto.')
