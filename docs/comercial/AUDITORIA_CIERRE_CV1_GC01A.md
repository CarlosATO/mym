# Auditoría de Cierre Operacional de CV-1 (Fase GC-01A)

## 1. Resumen Ejecutivo
Esta auditoría determina el estado operativo real de la Fase CV-1 (Sincronización y Reconciliación Bsale). Tras revisar la documentación histórica, las migraciones de base de datos, el código fuente (runtime) y los registros físicos en Supabase remoto, se concluye que **la infraestructura de base de datos de CV-1 fue diseñada y desplegada exitosamente (CV-1A y CV-1B), pero NO EXISTE código en ejecución (runtime) para las fases operacionales (CV-1C a CV-1G)**. El sistema actual continúa utilizando el mecanismo *legacy* vulnerable de polling de 14 días. Por lo tanto, la cartera actual no es apta para construir sobre ella la Gestión de Cobranza.

## 2. Antecedente CV-0
La auditoría inicial (`AUDITORIA_CARTERA_VENCIDA_FASE_00.md`) detectó que el motor de sincronización de Bsale contaba con una vulnerabilidad P0: la sincronización de pagos y documentos operaba con una ventana temporal de lectura corta (14 días). Pagos y modificaciones históricas quedaban ciegos al ERP, provocando una desincronización acumulativa de saldos.

## 3. Arquitectura Diseñada CV-1
Según `ESTANDAR_MOTOR_SYNC_BSALE.md` y `CONTRATOS_FISICOS_MOTOR_SYNC_BSALE_CV_1B.md`, la fase CV-1 diseñó una solución en las siguientes etapas:
* **CV-1A:** Diseño de Reconciliación (Híbrida).
* **CV-1B:** Contratos físicos (Tablas de Sync V2 y Financieras).
* **CV-1C:** Sync Incremental (El core genérico).
* **CV-1D:** Reconciliación periódica con endpoint `unpaid_documents`.
* **CV-1E:** Reparación dirigida asíncrona.
* **CV-1F:** Backfill y saneamiento inicial.
* **CV-1G:** Validación de estabilidad.

## 4. Inventario Implementado en Repositorio
**Migraciones encontradas (Infraestructura):**
* `20260730230000_integraciones_bsale_sync_v2_core.sql` (Núcleo)
* `20260730231000_integraciones_bsale_sync_v2_config_errors.sql` (Config/Errores)
* `20260731055000_integraciones_bsale_sync_v2_financial_reconciliation.sql` (Reconciliación y Reparación)

**Código fuente (Runtime):**
* Se buscaron referencias a `bsale_sync_v2`, `unpaid_documents`, `reconciliation_runs`, `repair_queue` en toda la carpeta `src/`.
* **Resultado:** 0 hallazgos. No existe implementación en Node/React/Server Actions de esta arquitectura.

## 5. Estado de Migraciones
Todas las migraciones mencionadas fueron aplicadas correctamente en el entorno de Supabase. Existen los constraints, las políticas RLS y los grants de seguridad definidos en el diseño.

## 6. Estado Remoto (Supabase)
Se realizó una consulta en el entorno remoto a través del cliente `@supabase/supabase-js`.
* **Tablas comprobadas:** `bsale_sync_v2_runs`, `bsale_sync_v2_steps`, `bsale_sync_v2_cursors`, `bsale_sync_v2_task_config`, `bsale_sync_v2_errors`, `bsale_sync_v2_reconciliation_runs`, `bsale_sync_v2_reconciliation_items`, `bsale_sync_v2_repair_queue`.
* **Resultado:** Todas existen, pero **poseen 0 registros**.
* **Diagnóstico:** INFRAESTRUCTURA EXISTENTE SIN EVIDENCIA DE OPERACIÓN.

## 7. Runtime Real Actual
El archivo `src/app/actions/integraciones/bsale-sync.ts` mantiene la orquestación monolítica antigua ("legacy"). Se invoca a través de funciones acopladas como `syncBsaleSales` y `syncBsalePayments`, las cuales son consumidas manualmente o por el cron antiguo.

## 8. Estado Sync V2
No implementado operacionalmente. No existen consumidores ni productores que lean o escriban en `bsale_sync_v2_runs` o `bsale_sync_v2_task_config`.

## 9. Reconciliación Nocturna
No implementada operacionalmente. No existe ningún proceso que consuma el endpoint `GET /v1/clients/unpaid_documents.json` ni registre ejecuciones en base de datos.

## 10. Datos Reales de Reconciliation Runs / Items
* **Reconciliation Runs:** 0 registros históricos.
* **Reconciliation Items:** 0 registros.
* **Comentario:** Infraestructura existente, sin evidencia de operación.

## 11. Repair Queue
* **Repair Queue:** 0 registros pendientes, procesados o fallidos.

## 12. Reparación Dirigida
No implementada operacionalmente. Al no existir encolado (Detection), tampoco existe código consumidor de la cola de reparación (Workers/Jobs).

## 13. Backfill
No ejecutado. Al no existir la lógica del motor Sync V2, no se ha corrido ni el saneamiento histórico ni el poblamiento inicial de `unpaid_documents`.

## 14. Validación de Estabilidad (CV-1G)
No verificada ni aplicable por ahora, ya que el sistema operativo sigue con el modelo defectuoso original.

## 15. Situación de la Ventana de 14 Días
Este problema sigue vigente de forma crítica en producción.
* En `src/app/actions/integraciones/bsale-sync.ts`, línea 1894: `options: BsalePaymentsSyncOptions = { mode: 'incremental', days: 14 }`.
* En la línea 2422 (replenishment): `paymentsResult = await syncBsalePayments(companyId, { mode: 'incremental', days: 14 });`.

**Caso de Prueba Conceptual:**
* Factura emitida hace 45 días.
* Pago o modificación en Bsale ocurre hoy.
* ¿Existe un proceso automático que detecte y repare esa diferencia? **NO**.
* El sync incremental retrocede solo 14 días. La factura (o su aplicación de pago) modificada escapa del rango y queda permanentemente desincronizada localmente, provocando montos fantasma y discrepancias en deuda.

## 16. Matriz de Clasificación CV-1
| Componente | Repositorio | Remoto | Runtime | Evidencia de uso | Estado |
|---|---|---|---|---|---|
| CV-1A — Diseño | Sí (Markdown) | N/A | N/A | N/A | **IMPLEMENTADA** |
| CV-1B — Infraestructura Sync V2 | Sí (Migraciones SQL) | Sí (Tablas V2) | No | Tablas vacías (0 filas) | **IMPLEMENTADA** |
| CV-1C — Sync incremental | No (Sigue Legacy) | N/A | No | Usa `sync_runs` antiguo | **NO IMPLEMENTADA** |
| CV-1D — Reconciliación periódica | No | Tablas vacías | No | No hay crons/código | **NO IMPLEMENTADA** |
| CV-1E — Reparación dirigida | No | Tablas vacías | No | No hay jobs | **NO IMPLEMENTADA** |
| CV-1F — Backfill/saneamiento | No | No hay datos | No | Sin registros históricos | **NO IMPLEMENTADA** |
| CV-1G — Validación de estabilidad| No | No hay datos | No | Sin informes | **NO VERIFICADA** |

## 17. Riesgos
* **P0 - Desincronización de Saldo (Activo):** El problema raíz se mantiene intacto. El sistema actual no garantiza que lo pagado y facturado en el ERP coincida con Bsale.
* **P1 - Seguridad Comercial (Mantenido Separado):** Las vulnerabilidades de autorización detectadas en `customers.ts` de la Fase GC-00 siguen vigentes. No deben ser abordadas hasta que el negocio base esté consolidado.

## 18. Veredicto de Confiabilidad de Cartera
**NO APTA.**
Existe una brecha operativa confirmada (ventana de 14 días en Sync Legacy) que mantiene deuda local incorrecta sin ningún mecanismo automático efectivo de convergencia.

## 19. Bloqueador Mínimo Restante
¿Es técnicamente seguro construir YA la nueva Cobranza Operacional sobre los saldos actuales? **NO**.

**El bloqueo mínimo que se debe resolver de inmediato es la programación del runtime para las fases CV-1C a CV-1F**. Debemos inyectar el código TypeScript (orquestador, rate limiter, fetch a unpaid_documents, reparación asíncrona) que dé vida a la estructura de base de datos CV-1B ya existente, y culminar con la ejecución de un **Backfill masivo**.

## 20. Evidencias
* Repositorio: `docs/integraciones/CONTRATOS_FISICOS_MOTOR_SYNC_BSALE_CV_1B.md`
* Repositorio: `src/app/actions/integraciones/bsale-sync.ts` (líneas 1894, 2422 evidenciando los 14 días).
* Supabase Remoto: Queries JS comprobando 0 registros en `bsale_sync_v2_runs`, `bsale_sync_v2_reconciliation_runs`, `bsale_sync_v2_repair_queue`.

---
*Documento generado automáticamente por auditoría de solo lectura.*
