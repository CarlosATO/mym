# Guía práctica para integrar nuevas tareas al Motor Sync Bsale (Fase BSYNC-0.1)

## 1. Propósito
Esta guía provee los pasos detallados para implementar de manera segura y estándar nuevas integraciones de recursos de Bsale en PetGroup.

## 2. Relación con el estándar
`ESTANDAR_MOTOR_SYNC_BSALE.md` → define la arquitectura y reglas obligatorias.
`GUIA_INTEGRACION_TAREAS_BSALE.md` → explica cómo aplicar esas reglas al incorporar una tarea nueva.
Ninguna integración nueva de Bsale debe implementarse sin revisar ambos documentos.

## 3. Cuándo crear una tarea nueva
**SÍ crear cuando:**
- Se requiere un nuevo recurso Bsale (ej. sucursales).
- El payload o la lógica de negocio cambió radicalmente (nueva versión).
- Un nuevo proceso requiere lógica atómica independiente (ej. reconciliación, reparación financiera).

**NO crear cuando solo cambia:**
- El rango temporal, modo de ejecución, cursor, empresa o el origen (manual o programado).

## 4. Información requerida
Antes de programar, documenta obligatoriamente: `task_code`, `nombre funcional`, `objetivo`, `consumidor`, `endpoint Bsale`, `documentación del endpoint`, `métodos HTTP`, `estructura real del payload`, `recurso origen`, `tabla destino`, `clave única`, `dependencias`, `frecuencia`, `modos soportados`, `cursor`, `paginación`, `rate limit`, `sensibilidad de datos` y `riesgos`.
*Regla de oro: No autorizar una tarea sin consumidor real y claramente identificado.*

## 5. Clasificación
| Recurso               | Tipo           |
| --------------------- | -------------- |
| Clientes              | CATALOG        |
| Documentos            | TRANSACTIONAL  |
| Stock actual          | SNAPSHOT       |
| Aplicaciones de pago  | RELATIONAL     |
| Conciliación de deuda | RECONCILIATION |
| Reparación de saldos  | REPAIR         |
| Carga histórica       | BACKFILL       |

## 6. Modos
Solo habilitar los modos necesarios:
- **INCREMENTAL**: Trae deltas. Usa cursor.
- **FULL**: Trae todo (útil para catálogos pequeños).
- **BACKFILL**: Llenado histórico segmentado por rango.
- **REPAIR / RECONCILIATION**: Lógicas correctivas. Requieren `scope` específico.
- **MANUAL**: Forzado por usuario.

## 7. Dependencias
Declarar dependencias explícitamente (ej. `bsale.documents -> bsale.clients`).
- Si una dependencia crítica falla, la tarea se bloquea (`WAITING_DEPENDENCY`).
- El Dependency Resolver del motor previene ciclos de dependencias.

## 8. Cursores
Elegir entre: `OFFSET`, `SOURCE_DATE`, `SOURCE_ID`, `COMPOSITE`, `SNAPSHOT`, `NONE`.
- `SOURCE_DATE` es ideal para transaccional (ej. pagos).
- `SOURCE_ID` es ideal para catálogos.
- **Regla obligatoria:** El cursor solo avanza después de persistir y confirmar completamente el lote.

## 9. Paginación
Patrón estándar: `construir solicitud → obtener página → validar payload → normalizar → persistir → confirmar lote → avanzar cursor → solicitar página siguiente`. Maneja respuestas parciales y reanuda desde la última página completada en caso de interrupción. Evita loops mediante límites máximos de páginas de seguridad.

## 10. Normalización
El payload Bsale jamás se inserta directo.
`payload Bsale → normalizador → modelo interno validado → persistencia`
Valida nulabilidad, convierte fechas/monedas. El `raw_json` solo se guarda para fines de auditoría si es estrictamente necesario y sin datos personales sensibles.

## 11. Persistencia
Elegir sabiamente:
- **Catálogos:** `UPSERT`.
- **Transaccional:** `UPSERT` atómico.
- **Relaciones (aplicaciones):** `UPSERT` del padre + reemplazo de hijos.
- **Historial:** `INSERT append-only`.
*Prohibidas eliminaciones masivas sin snapshot completo.*

## 12. Idempotencia
Toda tarea debe definir su clave idempotente operacional.
Ejemplo: `company_id + task_code + source_id + source_hash`.
`run_id` agrupa auditoría, pero no reemplaza la regla de idempotencia que previene duplicados físicos.

## 13. Transacciones
Declarar ámbito: por recurso, por página, por cliente, etc.
**Regla inquebrantable:** *Nunca ejecutar una llamada HTTP dentro de una transacción PostgreSQL.*
Patrón obligatorio: `fetch remoto → validar → tomar lock corto → abrir transacción → persistir → actualizar cursor → commit → liberar lock`.

## 14. Concurrencia
Declarar `lock_scope` (ej. `GLOBAL_BSALE`, `COMPANY`, `CUSTOMER`, `TASK`). Usar Constraints únicas y Advisory Locks cortos para proteger a nivel BD. Evitar bloqueos amplios que pausen otros flujos.

## 15. Rate limiting
Prohibido usar sleeps internos. Toda tarea usa el limitador central, declarando su `rate_limit_group`, `priority`, `request_rate_per_second` y `max_concurrency`. Backoff exponencial con jitter maneja los errores 429 respetando el header `Retry-After`.

## 16. Errores
Mapear excepciones a la taxonomía estándar (`RATE_LIMIT`, `BSALE_5XX`, `INVALID_PAYLOAD`, etc.). Declarar reintentables vs `REQUIRES_REVIEW`. Redactar logs eliminando información sensible (rut, correos).

## 17. Métricas
Obligatorias: `records_fetched`, `records_created`, `records_updated`, `records_unchanged`, `records_invalid`, `records_failed`, `requests`, `retries`, `rate_limits`, `duration`, `cursor_lag`, `source_freshness`.

## 18. Configuración
Toda tarea define: `enabled`, `schedule`, `page_size`, `window_days`, `request_rate`, `max_concurrency`, `timeout`, `max_retries`, `priority`, `freshness_threshold`. (Almacenado por empresa, sin overrides caprichosos por frontend).

## 19. Seguridad
Checklist obligatoria:
- Token Bsale solo server-side.
- `company_id` en toda operación multiempresa.
- Sin credenciales ni datos personales en logs.
- RLS en tablas de control.
- Ejecuciones manuales y backfills auditados con el usuario invocador.

## 20. Ejemplo completo
```text
task_code: bsale.prices
version: 1
task_type: CATALOG
endpoint: /v1/price_lists/...
destination: integraciones.bsale_prices
dependencies: [bsale.products]
supported_modes: [INCREMENTAL, FULL, BACKFILL]
cursor_strategy: SOURCE_ID
pagination_strategy: OFFSET
idempotency_strategy: company_id + task_code + source_id + source_hash
lock_scope: TASK
transaction_scope: PAGE
rate_limit_group: bsale.default
priority: NORMAL
```

## 21. Procedimiento de incorporación
1. Auditar endpoint y payload.
2. Definir consumidor y `task_code`.
3. Clasificar tipo, modos y dependencias.
4. Definir cursor, paginación y normalización.
5. Diseñar persistencia, transacciones y locks.
6. Ajustar errores y métricas.
7. Registrar la tarea en el Motor.
8. Desarrollar pruebas exhaustivas.
9. Ejecutar en Shadow Mode.
10. Validar e implementar progresivamente.

## 22. Modo shadow
Flujo no destructivo:
`fetch → normalizar → calcular resultado → no reemplazar todavía el consumidor oficial → comparar contra el flujo actual`. Medir impacto, diferencias y duración antes de sustituir.

## 23. Pruebas
Exigidas pruebas de: payload válido/incompleto, página vacía, 429, 500, timeouts, recuperación de cursor, concurrencia, reintentos e idempotencia perfecta frente a dobles ejecuciones.

## 24. Criterios de aceptación
La tarea se activa cuando:
- Respeta contrato.
- Cursor y dependencias funcionales.
- Idempotente.
- Pasa pruebas en Shadow mode.
- Posee rollback y documentación lista.

## 25. Documentación por tarea
Toda tarea requerirá una ficha documental en `docs/integraciones/tareas/<task_code>.md` (ej. `bsale.clients.md`) conteniendo consumidor, endpoint, tabla destino, estrategias elegidas y riesgos.

## 26. Catálogo
Se mantendrá a futuro en `docs/integraciones/CATALOGO_TAREAS_BSALE.md` indicando estado, modos, dependencias y versión de todas las tareas operativas.

## 27. Uso desde módulos
Un módulo de negocio (ej. Inventario o Finanzas) jamás:
- Llama a Bsale.
- Toca cursores.
- Usa rate limiters propios.
El módulo simplemente pide una ejecución:
`Orchestrator.request({ task_code: 'bsale.stock', mode: 'FULL' })`. El motor gestiona el resto.

## 28. Flujo de integración
`Módulo identifica necesidad → revisa catálogo de tareas → reutiliza o diseña nueva → registra → shadow → habilita → módulo consume únicamente la BD`.

## 29. Checklist
[ ] Existe consumidor real
[ ] Endpoint auditado
[ ] task_code único
[ ] Tipo y modos definidos
[ ] Dependencias declaradas
[ ] Cursor y paginación definidos
[ ] Idempotencia definida
[ ] Transacción y locks definidos
[ ] Uso del rate limiter central
[ ] Errores y métricas definidos
[ ] Seguridad e RLS revisados
[ ] Pruebas completas escritas
[ ] Ejecución Shadow exitosa
[ ] Ficha documental creada

## 30. Aplicación en CV-1
CV-1 utilizará `bsale.clients`, `bsale.documents`, `bsale.payments` como tareas de Núcleo. Y `bsale.receivables_reconciliation`, `bsale.receivables_repair` como extensiones financieras específicas montadas sobre este mismo orquestador unificado. CV-1B no re-inventará la rueda.

## 31. Errores comunes
- Hacer commits HTTP dentro de transacciones SQL.
- Usar timestamps genéricos (`run_id`) creyendo que evitan duplicidad física.
- Olvidar el rate limiter.

## 32. Conclusión
Esta guía permite la hiper-estandarización de integraciones, dotando a PetGroup de la capacidad de sumar recursos con resiliencia total y tiempo de desarrollo predecible.
