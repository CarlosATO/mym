import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panel = await readFile(new URL('../src/modules/logistica/guias-ruta/route-guides-panel.tsx', import.meta.url), 'utf8')
const detail = await readFile(new URL('../src/modules/logistica/guias-ruta/components/route-guide-detail-panel.tsx', import.meta.url), 'utf8')

test('la carga inicial del panel no espera catálogos', () => {
  assert.match(panel, /loadTray\(\)\.finally\(\(\) => setIsLoading\(false\)\)/)
  assert.doesNotMatch(panel, /Promise\.all\(\[loadTray\(\), loadCatalogs\(\)\]\)/)
  assert.match(panel, /const ensureCatalogs = useCallback/)
})

test('Nueva Guía y edición solicitan catálogos bajo demanda', () => {
  assert.match(panel, /setActiveView\('NEW'\)[\s\S]*?void ensureCatalogs\(\)/)
  assert.match(panel, /setActiveView\('EDIT'\)[\s\S]*?void ensureCatalogs\(\)/)
  assert.match(panel, /catalogsPromiseRef/)
})

test('el detalle sólo solicita catálogos al abrir su edición', () => {
  assert.match(detail, /catalogOptions\?: CatalogOptions/)
  assert.match(detail, /setEditModalOpen\(true\);[\s\S]*?onRequestCatalogs\(\)/)
})
