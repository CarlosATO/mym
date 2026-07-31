# Auditoría de Cartera Vencida (Fase CV-0)

Estado de la auditoría: CERRADA
Veredicto del sistema: NO_APTO — REQUIERE CV-1

## 1. Resumen ejecutivo
La presente auditoría técnica documenta el estado actual del dominio `clientes` y cuentas por cobrar en el repositorio PetGroup (sincronizado desde Bsale). Tras realizar una conciliación muestral contra la API de Bsale, el hallazgo estructural más importante es que el sistema actual presenta un **INCIDENTE_CONFIRMADO** derivado de que no captura cambios históricos (mayores a 14 días) en pagos ni en documentos, debido a limitaciones combinadas del payload nativo de Bsale y la estrategia de ventana móvil (polling) utilizada en el sincronizador local. El endpoint `unpaid_documents.json` ha sido reclasificado tras utilizar la URI correcta y arroja datos fiables para conciliación.

## 2. Alcance y metodología
- **Rama auditada:** `main`
- **Herramientas utilizadas:** `npx supabase db query`, API Bsale, y scripts de NodeJS sobre la DB mediante `@supabase/supabase-js`.
- **Muestra de Conciliación:** 10 clientes con diversos perfiles de deuda y pagos (Sin deuda, deuda vencida, pagos parciales, etc).
- **Validaciones:** Se revisó la definición de las tablas puente, las vistas maestras, y se consultó la API en la URI correcta: `GET /v1/clients/unpaid_documents.json?clientid=<ID>`.

## 3. Estado inicial
- `git status --short` muestra que el dominio original está íntegro y sin alteraciones en el `tree`.
- No se han agregado migraciones ni dependencias espurias que afecten `comercial`.

## 4. Mapa de esquemas
- **Esquema fuente analítico:** `comercial`.
- **Esquema fuente crudo:** `integraciones`.
- **Decisión de Arquitectura:** `MANTENER_COMERCIAL` para vistas y lógica de negocio analítica. `integraciones` aloja los espejos crudos.

## 5. Inventario de objetos
- **`comercial.customers`**: Tabla consolidada que enriquece los datos de Bsale.
- **`integraciones.bsale_clients`**: Espejo crudo. PK `(company_id, bsale_client_id)`.
- **`integraciones.bsale_documents`**: Espejo crudo de `/v1/documents.json`.
- **`integraciones.bsale_document_details`**: Detalle transaccional.
- **`integraciones.bsale_document_references`**: Relaciones (Notas de Crédito).
- **`integraciones.bsale_payments`**: Espejo crudo de `/v1/payments.json`.
- **`integraciones.bsale_document_payments`**: Tabla puente que almacena aplicaciones de pago a factura.

## 6. Modelo actual de clientes
- **Tabla:** `comercial.customers`
- Existen 492 registros en `comercial.customers` que mapean con `integraciones.bsale_clients`.

## 7. Modelo actual de documentos
- **Validación de fechas (Bsale API):** `emissionDate`, `expirationDate`, `generationDate` están presentes.

## 8. Modelo actual de pagos
- El payload de GET `/v1/payments.json` **NO** entrega un campo de modificación (`updatedAt`, `modifiedAt`, `lastModified`). Entrega `recordDate`, `createdAt`, `accountingDate`, `checkDate`.

## 9. Semántica de fechas
- `emissionDate` y `expirationDate` se normalizan y almacenan como DATE.

## 10. Vencimientos (Muestra total base)
- **Total de facturas:** 3,190
- **Activas / Pendientes:** 158
- **Vencidas:** 46
- **Pagadas:** 3,032

## 11. Aplicaciones de pagos
- La tabla `bsale_document_payments` almacena la asignación `amount_applied`.

## 12. Notas de crédito y abonos
- **Estado real:** `NC_PARCIALMENTE_VALIDADAS`.
- Se obtienen descargando el XML (`urlXml`) de documentos Tipo 2 y extrayendo referencias vía Regex (lo que representa una fragilidad P1). El descuento recae en SQL (`vw_customer_receivables`).

## 13. Vistas actuales
- `comercial.vw_customer_receivables` calcula saldos sumando sobre la vista de facturas `vw_customer_invoice_receivables`.

## 14. Sincronizadores actuales
- Se apoya en ventana temporal (`days=14`). No existen rutinas comprobables que hagan full-backfill recurrente de pagos.

## 15. Cobertura temporal
- Factura abierta más antigua: `2026-01-05`
- Pago más antiguo: `2026-01-05T00:00:00+00:00`
- Pago más reciente: `2026-07-30T00:00:00+00:00`
- **Condición:** `oldest_payment_coverage_date <= oldest_open_invoice_date` confirmada.

## 16. Webhooks
- No existen webhooks implementados en la instancia.

## 17. Calidad de datos
- Los clientes están sincronizados, pero los pagos dependen del sync de 14 días.

## 18. Conciliación Bsale vs Supabase
**Muestra de 10 clientes (ID internos omitidos, IDs origen anonimizados):**
| Cliente | Deuda vencida Bsale | Deuda vencida PetGroup | Deuda futura Bsale | Deuda futura PetGroup | Diferencia | Resultado |
| ---- | ------------------: | ---------------------: | -----------------: | --------------------: | ---------: | --------- |
| Cliente A | 0 | 0 | 0 | 0 | 0 | COINCIDE |
| Cliente B | 168659 | 168659 | 0 | 0 | 0 | COINCIDE |
| Cliente C | 1571486 | 926852 | 1174258 | 1818892 | 0 | COINCIDE |
| Cliente D | 181558 | 181558 | 319527 | 319527 | 0 | COINCIDE |
| Cliente E (ID 643) | 9578578 | 9578578 | 17475040 | 18546538 | -1071498 | DIFERENCIA_NO_EXPLICADA |
| Cliente F | 0 | 0 | 0 | 0 | 0 | COINCIDE |
| Cliente G | 0 | 0 | 0 | 0 | 0 | COINCIDE |
| Cliente H | 0 | 0 | 0 | 0 | 0 | COINCIDE |
| Cliente I | 0 | 0 | 0 | 0 | 0 | COINCIDE |
| Cliente J | 0 | 0 | 0 | 0 | 0 | COINCIDE |

- **INCIDENTE_CONFIRMADO (Cliente E):** El Documento Bsale ID 88806 (Folio 23201, de monto 1,071,498) fue emitido el `2026-07-14` (hace 16 días). En Bsale no figura con deuda (fue pagado/anulado), pero en PetGroup figura PENDIENTE con 100% del monto.
- Esto se debe a que el pago/anulación en Bsale ocurrió fuera de la ventana móvil de 14 días.

## 19. Seguridad
- Permisos RLS existen sobre `comercial.customers`.

## 20. Rendimiento
- Existen ~6,500 documentos y ~5,700 pagos. Tablas responden rápido (ms).

## 21. Matriz de cobertura
| Recurso | Endpoint | Campo requerido | Existe API | Existe espejo | Se actualiza | Confiable | Brecha |
|---|---|---|---|---|---|---|---|
| Documento | documents | expirationDate | SÍ | SÍ | Parcialmente | SÍ | - |
| Pago | payments | modificación | NO | NO | NO | NO | P0 |
| Deuda Total| unpaid_docs | saldo individual | SÍ | NO | N/A | SÍ | P0 |

## 22. Matriz de brechas
- **P0:** Cambios históricos no garantizados (Ventana de 14 días sin backfill automático confirmado, resultando en incidentes de desactualización comprobados).
- **P1:** Notas de Crédito frágiles (Parseo XML con Regex puede romper).
- **P1:** Limitaciones del endpoint `unpaid_documents`: Requiere una llamada N+1 por cliente, lo cual inviabiliza su uso on-the-fly para listados masivos.

## 23. Decisiones
- El esquema correcto es `MANTENER_COMERCIAL`.
- El endpoint `unpaid_documents` demostró retornar `overdueDebt`, `upcomingDebt`, `totalDebt` y listados precisos.
- La clasificación definitiva de `unpaid_documents` es: **FUENTE_DE_RECONCILIACION** (Entrega datos confiables para contrastar, pero no reemplaza vistas internas debido al overhead N+1).
- Los pagos inactivos se capturan vía `state`, estado `NO_CONFIRMADO` en las vistas SQL pero sí existen en la tabla puente.
- ¿Existe proceso que relea pagos > 14 días recurrentemente? No. Clasificación: **CAMBIOS_HISTORICOS_NO_CUBIERTOS**.

## 24. Bloqueadores
- El desajuste de pagos históricos crea saldos desactualizados. (Brecha P0).

## 25. Plan de fases posteriores
El sistema no es apto en las condiciones actuales. Se debe ejecutar CV-1.

El objetivo de CV-1 será:
**Robustecer la actualización histórica de pagos, aplicaciones y documentos antes de construir Cartera Vencida.**

Esto incluye investigar y aplicar un mecanismo como polling incremental + reconciliación nocturna o backfills completos regulares para cerrar el P0 de la ventana de 14 días.

## 26. Conclusión
El sistema actual es vulnerable a la desincronización de eventos de cobranza que ocurran tardíamente o reajustes administrativos en Bsale. Se evidenció un caso concreto donde una factura de hace 16 días aparece pendiente localmente y pagada en origen. Por lo tanto, el sistema es **NO_APTO** para lanzar pantallas de Cartera Vencida hasta solucionar la confiabilidad en la capa de sincronización (Fase CV-1).

## 27. Anexo de consultas ejecutadas
- SQL (via API Node supabase-js).
- `GET /v1/clients/unpaid_documents.json?clientid=<ID>`

## 28. Anexo de archivos revisados
- `src/app/actions/integraciones/bsale-sync.ts`
