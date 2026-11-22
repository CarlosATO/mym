// Ejecutar contra una base local vacía cxp_due_date_test; el SQL incluye su propia guarda.
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const fixture = await readFile('scripts/test-cuentas-por-pagar-due-dates.sql', 'utf8')
const published = await readFile('supabase/migrations/20261120140000_cuentas_por_pagar_service_invoices.sql', 'utf8')
const mockStart = fixture.indexOf('CREATE FUNCTION cuentas_por_pagar.prepare_invoice() RETURNS trigger')
const mockEnd = fixture.indexOf('CREATE TRIGGER prepare_invoice', mockStart)
const realStart = published.indexOf('CREATE OR REPLACE FUNCTION cuentas_por_pagar.prepare_invoice() RETURNS trigger')
const realEnd = published.indexOf('REVOKE ALL ON FUNCTION cuentas_por_pagar.prepare_invoice()', realStart)
if ([mockStart, mockEnd, realStart, realEnd].some(position => position < 0)) throw new Error('No se pudo localizar el trigger real o la fixture')
const testSql = fixture.slice(0, mockStart) + published.slice(realStart, realEnd) + fixture.slice(mockEnd)
const result = spawnSync('psql', ['-h', '127.0.0.1', '-p', '55439', '-d', 'cxp_due_date_test', '-v', 'ON_ERROR_STOP=1'], { input: testSql, encoding: 'utf8' })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
