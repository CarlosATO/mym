# Diseño Técnico del Sync y Conciliación Financiera Bsale (Fase CV-1A)

**Estado:** CV-1A: APROBADA PARA CV-1B

## 1. Resumen ejecutivo
Este documento establece la arquitectura definitiva para mantener la integridad de los datos de Cartera Vencida entre Bsale y PetGroup. Tras la auditoría CV-0 que demostró la existencia de un riesgo estructural P0 (la incapacidad de sincronizar pagos históricos modificados), se diseña un sistema híbrido que combina la sincronización incremental (frecuente) con una reconciliación nocturna independiente (diaria). Cuando esta reconciliación detecta diferencias a través del endpoint `unpaid_documents`, se dispara un proceso de reparación dirigida por cliente. La solución será observable, convergente, reparable y escalable a `REQUIRES_REVIEW` cuando la corrección automática no sea segura.

## 2. Alcance
- Sincronización de clientes, documentos, detalles, referencias, vendedores, pagos, aplicaciones pago-documento, notas de crédito y saldos.
- Diseño teórico de los procesos A (Incremental), B (Reconciliación), C (Reparación) y D (Backfill profundo).
- No incluye implementación de código ni SQL.

## 3. Estado inicial
- **Rama actual:** `main`
- **Commit base:** `6e882b8 feat: add inventory recount request operation`
- **Cambios preexistentes:** Solo documentos en `docs/clientes/`.
- **Última migración de integraciones:** `20260721190000_integraciones_bsale_base.sql` (Inferida de CV-0).
- **Último cambio de sincronizador Bsale:** Sin cambios en el código actual (se mantiene el polling a 14 días).

## 4. Requisitos heredados de CV-0
- **Brecha P0:** Los cambios en pagos más antiguos a 14 días no son garantizados.
- **Brecha P1:** Fragilidad al parsear referencias de Notas de Crédito mediante Regex. Endpoint `unpaid_documents` requiere N+1 llamadas por cliente.
- **Caso de conciliación con diferencia:** Diferencia superior a $1.000.000 detectada en cliente ID 643.
- **Caso de diferencia vencido/futuro:** Detectado por discrepancia en reglas de aging.
- **Cobertura histórica:** Primeros documentos y pagos desde `2026-01-05`.

## 5. Arquitectura actual
- `integraciones` actúa como esquema crudo para Bsale.
- `comercial` aloja clientes consolidados y vistas analíticas de negocio (ej. `vw_customer_receivables`).
- El flujo local usa polling (`fetch` a Bsale con filtro temporal) y upserts en PostgreSQL, asumiendo que los registros son estáticos o que todo cambio ocurre dentro de los últimos 14 días.

## 6. Flujo actual
- Cron Job -> Ejecuta `syncBsalePayments` / `syncDocuments`.
- Frecuencia: Por demanda o crons.
- Lectura Bsale API: Basado en `recorddate` o fechas de emisión (ventana móvil de 14 días).
- Escritura: UPSERT PostgreSQL. Con limpieza parcial (`DELETE`) de `bsale_document_payments` para los documentos afectados dentro de los pagos traídos.

## 7. Casos forenses
**Caso A — Descuadre superior a $1.000.000**
- **Documento:** Folio 23201 (Bsale ID 88806), emitido el 2026-07-14.
- **Estado Bsale:** No registra deuda.
- **Estado Supabase:** `is_pending = true`, deuda $1.071.498.
- **Diagnóstico:** Se constata un **INCIDENTE_FINANCIERO_CONFIRMADO**. La causa se clasifica como **CAUSA_RAIZ_NO_DETERMINADA** de momento, hasta que se demuestre con identificadores exactos qué pago, aplicación, nota de crédito o anulación provocó el cierre en Bsale y por qué evadió la sincronización local.

**Caso B — Diferencia entre vencido y futuro**
- **Diagnóstico:** Se constata un **INCIDENTE_AGING_CONFIRMADO** con **CAUSA_RAIZ_NO_DETERMINADA**. Existen discrepancias por comparación de fechas sin normalización de huso horario comercial. Se usará `America/Santiago` como regla objetivo.

## 8. Fallas confirmadas
- No existe ningún proceso que relea pagos y documentos anteriores a 14 días regulares. Estado: **CAMBIOS_HISTORICOS_NO_CUBIERTOS**.

## 9. Principios objetivo
- **Bsale como fuente oficial**: Es la fuente absoluta de clientes operacionales, documentos, pagos, aplicaciones, estados y vencimientos.
- **`integraciones` como espejo**: Mantiene payload crudo, IDs oficiales, fechas normalizadas, timestamps de sincronización. Sin lógica analítica.
- **`comercial` como capa analítica**: Consolida y expone deuda. No repara datos faltantes silenciosamente.
- **Reconciliación independiente**: El cruce `unpaid_documents` vs `comercial` no debe depender del estado final de un job de sync ordinario.

## 10. Arquitectura propuesta
Modelo Híbrido: **Incremental + Reconciliación nocturna + Reparación dirigida**.

## 11. Sync incremental
- Frecuencia: Cada 30-60 minutos. Permite múltiples runs diarios.
- Ventana recomendada: 14 días con solapamiento (ventana configurable).
- Objetivo: Traer lo nuevo (`clientes`, `documentos`, `detalles`, `referencias`, `vendedores`, `pagos`, `aplicaciones`).

## 12. Reconciliación nocturna
- Frecuencia: Diaria.
- Proceso: Ejecuta `GET /v1/clients/unpaid_documents.json?clientid=<ID>` para los clientes activos relevantes.
- Compara totales: `overdueDebt`, `upcomingDebt`, `totalDebt` y folios contra las vistas de Supabase.
- Detecta diferencias exactas (monto faltante, documentos sobrantes/faltantes o cambio vencido/futuro).

## 13. Reparación dirigida
Cuando la reconciliación detecta una diferencia, la reparación canónica debe operar así:
1. Bloquear lógicamente el cliente (evitar duplicados).
2. Obtener documentos oficiales pendientes (desde la respuesta del `unpaid_documents` del cliente).
3. Efectuar comparación documental local vs remota.
4. Consultar `GET /v1/payments.json?documentid=<ID>` para detectar los pagos que afectaron el documento desincronizado.
5. Hacer `GET` individual de cada pago detectado.
6. Realizar la reconstrucción atómica de las aplicaciones locales de ese pago.
7. Nueva conciliación para verificar corrección.

**Fallback histórico:**
Si la diferencia no puede explicarse desde documentos pendientes, el proceso no asume filtro de pagos por cliente directo en API. En su lugar:
1. Buscar primero por `documentid`.
2. Si no basta, ejecutar escaneo global paginado por rangos temporales y filtrar localmente por los documentos que corresponden a dicho cliente.

Toda diferencia debe terminar en un estado `MATCHED`, `REPAIRED` o escalar a `REQUIRES_REVIEW` (dentro del SLA) cuando la corrección automática no sea segura.

## 14. Backfill profundo
- Proceso periódico (mensual o a demanda) para repasar el histórico total disponible, desde un cursor persistido o desde el inicio del año, garantizando convergencia a largo plazo.

## 15. Clientes
- La sincronización no depende únicamente de la existencia de documentos. Debe hidratarse el listado general para actualizar razones sociales, ruts y contactos.

## 16. Documentos
- Sincronización continua de fechas, montos, tipos y URL/XML, actualizando el `state` si se anulan.

## 17. Pagos
- Cada pago y su array `documents[]` define qué porción abona a qué folio.
- **Pagos inactivos:** La semántica actual de `state` queda pendiente de validación. Como regla objetivo, se definirá contractual y teóricamente: `state = 0 → activo`, `state = 1 → inactivo`. Un pago inactivo no suma al monto pagado y sus aplicaciones locales deben invalidarse. CV-1B debe auditar rigurosamente las vistas SQL actuales antes de crear los contratos físicos definitivos para este comportamiento.

## 18. Aplicaciones
Estrategia seleccionada para mantener exacta la tabla `bsale_document_payments`:
- Por cada pago:
  1. Upsert del pago.
  2. Eliminar aplicaciones locales *solo* de ese pago.
  3. Insertar el snapshot completo actual de `documents[]` asociado al pago.
- Todo ejecutado dentro de una transacción corta. No se eliminan todas las aplicaciones del cliente entero sin un snapshot probado.

## 19. Notas de crédito
- **Fuente principal:** `GET /v1/documents/:id/references.json`.
- **Fallback:** Parser XML formal.
- **Último recurso:** Uso de Regex. Generará el estado `REFERENCE_PARSE_FAILED` y `REQUIRES_REVIEW`.
- **Doble descuento:** La prevención de doble descuento deberá asegurar un cruce formal versus formas de pago.

## 20. unpaid_documents
- Uso: **FUENTE_DE_RECONCILIACION**. No debe usarse para armar la UI directamente. Tolerancia y backoff ante HTTP 429 requeridos.

## 21. Jerarquía de comparación
- Nivel 1 — Deuda total por cliente
- Nivel 2 — Deuda vencida y futura
- Nivel 3 — Documentos pendientes
- Nivel 4 — Saldo por documento
- Nivel 5 — Pagos y aplicaciones

**Tolerancia Monetaria:** `tolerancia = 0 CLP`. Se debe usar `round(amount)` a entero CLP antes de toda comparación.
**Regla de Aging:** Se define fecha comercial canónica como regla objetivo: `America/Santiago`.
- `expiration_date < business_date → VENCIDA`
- `expiration_date = business_date → VENCE_HOY`
- `expiration_date > business_date → POR_VENCER`

## 22. Idempotencia
Claves exactas para garantizar repetibilidad:
- **Incremental:** `company_id + resource + source_id + source_hash`
- **Reconciliación Run:** `company_id + run_type + scheduled_for_at`
- **Reconciliación Item:** `run_id + customer_id`
- **Reparación:** `company_id + customer_id + mismatch_fingerprint`
- **Backfill:** `company_id + resource + range_start + range_end`

`run_id` agrupará ejecuciones en auditorías, pero no reemplazará la clave idempotente.

## 23. Concurrencia
Decisión canónica: Tablas de ejecución + constraints únicas, sumado a **advisory lock corto por company_id/customer_id**.
- Secuencia obligatoria: `fetch remoto → validar snapshot → tomar lock → aplicar transacción corta → liberar lock → reconciliar`. No mantener locks durante llamadas HTTP en ninguna circunstancia.

## 24. Transacciones
Definición de unidades transaccionales exactas:
- **Pago y sus aplicaciones:** Una transacción corta atómica por pago.
- **Resultado de conciliación:** Una transacción por cliente/run.
- **Reparación:** Múltiples transacciones cortas orquestadas (no transacciones gigantes).
- **Cursor:** Avanzar solo después de completar exitosamente el lote completo.
- **Regla inquebrantable:** Nunca realizar `fetch` (HTTP) dentro de una transacción.

## 25. Errores
- Rate limiting: Se separa `max_concurrency` de `request_rate_per_second` (ambos configurables).
- Se implementará "token bucket" (o similar), backoff exponencial con jitter, respeto a `Retry-After`, y registro formal de estados (ej. 429, timeout, network error).

## 26. Observabilidad
- Métricas: clientes procesados, diferencias detectadas vs reparadas, ejecución de ciclos y duraciones. Sistema altamente observable.

## 27. Objetos futuros
Requeridos para el modelo de CV-1B:
- `integraciones.bsale_sync_runs` (Clave: `company_id + run_type + scheduled_for_at` o idempotency_key. Permite múltiples runs por día sin colisiones, ni sobreescrituras destructivas).
- `integraciones.bsale_sync_steps`
- `integraciones.bsale_sync_cursors`
- `integraciones.bsale_reconciliation_runs` (Clave idempotencia: `company_id + run_type + scheduled_for_at`). Mantiene historial de intentos.
- `integraciones.bsale_reconciliation_items` (Clave: `run_id + customer_id`). Guarda saldos con estado y error por intento.
- `integraciones.bsale_repair_queue` (Clave: `company_id + customer_id + mismatch_fingerprint`).

*Estrategia multiempresa:* Se usará `company_id` en todas las tablas para escalabilidad tenant. Ningún modelo contemplará sobreescritura destructiva del historial de intentos.

## 28. Alternativas
- A: Full sync nocturno completo
- B: Incremental + unpaid_documents + reparación dirigida
- C: Incremental + backfill histórico fijo
- D: Webhooks + polling + reconciliación

## 29. Arquitectura seleccionada
**Alternativa B (Incremental + unpaid_documents + reparación dirigida)**, complementada a futuro por Webhooks (`COMPLEMENTARIO` / `REQUIERE_VALIDACION_EN_INSTANCIA_MYM`).

## 30. Fases de implementación
1. **CV-1B**: Modelo de control y contratos (Tablas runs, cursores, locks).
2. **CV-1C**: Sync incremental robusto (Paginación segura, 14 días).
3. **CV-1D**: Reconciliación nocturna (`unpaid_documents`).
4. **CV-1E**: Reparación dirigida (Comparación documental y relectura atómica).
5. **CV-1F**: Backfill inicial y saneamiento de saldos desajustados.
6. **CV-1G**: Validación de estabilidad.

## 31. Criterios de aceptación
Para poder construir UI de Cartera Vencida:
- 100% de clientes activos relevantes conciliados.
- 0 diferencias totales o de aging no explicadas.
- 0 documentos pendientes adicionales/faltantes locales.
- Pagos inactivos excluidos correctamente.
- Notas de crédito validadas.
- Aplicaciones reconstruibles y reparación dirigida probada.
- Tres ejecuciones nocturnas consecutivas satisfactorias.

## 32. Matriz de pruebas
- Pagos antiguos alterados/inactivados, modificaciones en notas de crédito, error 429 durante conciliación, backfill concurrente, validaciones idempotentes.
- Estados de reparación deben terminar en `MATCHED`, `REPAIRED` o escalar a `REQUIRES_REVIEW`.

## 33. Riesgos
- Endpoint degradado de Bsale retrasando el cron.
- Vistas SQL de PetGroup. (CV-1B auditará vistas SQL frente a la exclusión de `state=1`).

## 34. Bloqueadores
- Crear migraciones SQL en CV-1B. Ningún código se escribirá hasta que CV-1B inicie formalmente.

## 35. Conclusión
El diseño establece un modelo robusto, asíncrono y resiliente a cambios silenciosos del origen (Bsale). La introducción de la reconciliación y reparación dirigida asienta una capa de convergencia a largo plazo infalible (observable y reparable).

## 36. Archivos revisados
- `docs/clientes/AUDITORIA_CARTERA_VENCIDA_FASE_00.md`
- `src/app/actions/integraciones/bsale-sync.ts`

## 37. Consultas ejecutadas
- Revisión teórica del modelo para unidades transaccionales e idempotencia en esta etapa.
