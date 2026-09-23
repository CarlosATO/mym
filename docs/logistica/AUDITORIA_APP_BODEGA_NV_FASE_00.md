# Auditoría Técnica Fase 0: App Bodega y Notas de Venta

> **Nota (2026-09-10):** Bloque 1 implementado. Se resolvieron las brechas de lectura transversal (RLS Hardening), divergencias en vistas (filtrado `state = 0`) y cancelación automática de tarjetas logísticas por anulación de NV.

## 1. Resumen ejecutivo
Se realizó una auditoría *read-only* de la base de datos de PetGroup, enfocada en la infraestructura existente (Supabase, integraciones Bsale, logística e inventarios) de cara al desarrollo de una App de Bodega independiente. Se identificó que existe una base sólida (tablas de tarjetas Kanban, historial de movimientos, referencias Bsale) pero hay brechas arquitectónicas en tiempo real (webhooks ausentes), acoplamiento de dominios (barcodes viviendo en `inventarios`) y falta de mapeo explícito `variante_bsale <-> producto_wms` en los flujos de preparación.

## 2. Arquitectura actual encontrada
La aplicación actual basa su flujo logístico en una arquitectura modular dentro de Supabase:
- Esquema `integraciones`: Espejo local de Bsale (documentos, detalles, referencias, variantes, sync_runs).
- Esquema `logistica`: Reglas de ruteo, tarjetas de preparación (`sales_order_preparation_cards`) y layouts WMS.
- Esquema `inventarios`: Maestro secundario de código de barras (`product_barcode_aliases`) y flujos de conteo.
- Esquema `adquisiciones`: Maestro de productos, almacenes y kardex original (consumido por logística).

## 3. Flujo actual real de una Nota de Venta
El ciclo de vida en BD para una NV es:
1. Se genera en Bsale.
2. Un job (CRON) o trigger manual sincroniza `bsale_documents` (tipo 23).
3. Se invoca periódicamente `logistica.sync_sales_order_preparation_cards()` (vía `materialize_next_route_preparation_cards()`).
4. Si la NV aplica para despacho (calendario, ciudad), se materializa en `sales_order_preparation_cards` con estado `PENDING_ROUTE_PREP`.
5. Los operadores la mueven pasando a `IN_PREPARATION` -> `IN_AUDIT` -> `INVOICED_READY_FOR_ROUTE`.

## 4. Sincronización Bsale actual
- Existen tablas de control: `integraciones.bsale_sync_runs`, `sync_job_configs`.
- Las ventas se sincronizan mediante funciones como `syncBsaleSales()`, leyendo un listado paginado.
- **Webhooks**: **NO se identificó infraestructura de webhooks Bsale vigente** (no hay endpoints en `src/app/api/` procesando webhooks).
- Una NV recién creada tardará lo que tarde la siguiente ejecución periódica en bajar a PetGroup.
- Faltaría configurar un endpoint webhook e inscribirlo en Bsale para lograr sincronización "Push" en tiempo real, vital para operaciones de bodega ágiles.

## 5. Preparación de Pedidos actual
El motor de estados vive en `logistica.sales_order_preparation_cards`.
- Estados confirmados (CHECK constraint): `PENDING_ROUTE_PREP`, `IN_PREPARATION`, `IN_AUDIT`, `INVOICED_READY_FOR_ROUTE`, `CANCELLED`.
- Trazabilidad en `logistica.sales_order_preparation_movements` (`from_status`, `to_status`, `moved_by`).
- Campos heredados o usados: `locked_by_user_id`, `assigned_user_id`, `locked_at`, `last_moved_at`, `notes`, `cancellation_reason`. UUIDs corresponden al sistema de usuarios `portal.users` / `auth.users`.

## 6. Próxima ruta
La próxima ruta está regida por:
- Tablas `logistica.dispatch_calendars` y `dispatch_calendar_cities`.
- Funciones RPC como `preview_next_route_candidates()` y `materialize_next_route_preparation_cards()`.
- Filtra las NV no preparadas según el día de la semana y la alias de ciudad normalizada (`logistica.city_aliases`).
- Cuando hay una excepción u override, se guarda para autorizar o re-programar.

## 7. NV → Factura
La detección de facturación ocurre por asociación documental.
- El objeto consumidor es `vw_bsale_sales_orders_for_preparation`.
- Hace un LEFT JOIN hacia `integraciones.bsale_document_references` buscando `source_document_type_id = 5` (Factura) apuntando al `bsale_id` de la NV (tipo 23).
- **Latencia**: Supeditado exclusivamente a cuándo el cron traiga la factura y las referencias a la BD de PetGroup.

## 8. Líneas/productos
Representado en `integraciones.bsale_document_details` y `vw_bsale_sales_order_items_for_preparation`.
- Relación: Detalle NV -> `variant_id` (Bsale).
- No hay unión directa al UUID `adquisiciones.products` en la vista de preparación. Solo retorna SKU y descripción de variante.
- Esto significa que para ubicar en bodega (Kardex), primero debe resolverse el SKU (Bsale) al `product_id` interno y luego buscarlo en `logistica.v_stock_by_location`.

## 9. Códigos de barra
El modelo actual vive en `inventarios.product_barcode_aliases` y `inventarios.product_barcode_proposals`.
- Regla: **Un barcode activo pertenece a un solo producto**. Un producto puede tener múltiples barcodes (aliases).
- Problema: Es un dominio de `inventarios`. El maestro de productos es `adquisiciones`.
- Dependencia arquitectónica: Usar esto directamente acoplaría las operaciones logísticas al módulo de auditoría/inventarios. Deuda arquitectónica evidente si el catálogo global no posee la colección de barcodes.

## 10. WMS/ubicaciones
La infraestructura WMS base existe:
- Tabla `logistica.locations` (bodega, rack, etc.) y `logistica.location_layouts` (posicionamiento visual).
- Vista `logistica.v_stock_by_location`: Agrega saldos de kardex por `product_id` y ubicación y filtra saldos > 0.
- Solo provee la posición con stock, no existe aún una función de ruteo/orden de picking automatizado (camino más corto).

## 11. Usuarios/RBAC
Se emplea RLS intensivo apoyado en `core.has_company_access` y `portal.has_permission(...)`.
- Las tablas logísticas requieren roles específicos. Los UUID (`moved_by`, `locked_by_user_id`) apuntan a la identidad base (`auth.users` / `portal.users`).

## 12. Evidencias/Storage
Existe una infraestructura de almacenamiento de fotos para el esquema inventarios (ej: recuentos de incidentes).
- El patrón técnico (Storage, RLS por bucket, metadatos JSON) es reutilizable, pero la tabla/directorio debe ser independiente (p. ej., `logistica/evidences`) y no reusar el bucket/tabla funcional de inventarios.

## 13. Medición de tiempos
Métricas:
- **Toma de NV**: Medible vía `locked_at`.
- **Picking time (preparación)**: Medible por diferencia entre timestamp de estado `IN_PREPARATION` y `IN_AUDIT` en la tabla `movements`.
- **Tiempo Auditoría**: Medible hasta `INVOICED_READY_FOR_ROUTE`.
- **Facturación Detectada**: Detectable por `vw_bsale_sales_orders_for_preparation.is_invoiced`, pero no guarda timestamp histórico exacto del momento en que PetGroup lo percibió por primera vez (a menos que dependa de sincronización de referencias).

## 14. Objetos vigentes y legado
**Vigentes**:
- `sales_order_preparation_cards`, `sales_order_preparation_movements`.
- Funciones `materialize_next_route_preparation_cards`.
- Modelo RLS `integraciones`.

**Sospechosos/Legado/En Evolución**:
- La función de `preview_next_route_candidates` ha sufrido muchos cambios y su firma se arregló recientemente.
- Algunas columnas en `bsale_document_references` se actualizaron. Siempre consultar las vistas consolidadas.

## 15. Brechas frente al flujo objetivo
- **Reutilizable sin cambios**: Tablas de control de acceso, tabla base Kanban de preparación (`sales_order_preparation_cards`), movimientos.
- **Reutilizable con extensión**: `vw_bsale_sales_order_items_for_preparation` (necesita cruzar explícitamente `product_id` transversal).
- **Requiere objeto nuevo**: Almacenamiento de evidencias logísticas (incidencias de picking) desvinculado de inventarios.
- **Debe reemplazarse/evolucionar**: Sincronización Bsale para Documentos Tipo 23 (de periódica pasiva a webhook activa).

## 16. Riesgos técnicos
- **Dependencia de Cron**: Si falla el CRON o está saturado, la app de bodega no verá las NV recientes.
- **Carreras concurrentes**: Múltiples operarios intentando tomar el mismo `bsale_nv_id`. Si bien `locked_by_user_id` ayuda, requiere control a nivel API (transaccional `UPDATE WHERE locked_by IS NULL`).
- **Acoplamiento Barcode-Inventarios**: Generará fricciones operacionales y deuda circular.
- **Variant vs Product**: Resolver mal el SKU en WMS enviaría a picking a la ubicación incorrecta.

## 17-19. Componentes (Reutilizables, Extendidos, Nuevos)
- **Reutilizables**: Motor RLS, tablas core de NV, Kanban actual.
- **A extender**: Endpoint API o RPC que unifique el pedido con ubicaciones `v_stock_by_location`.
- **Nuevos**: Webhook handler genérico Bsale; Máquina de estados explícita en backend para validar transiciones seguras.

## 20. Decisiones funcionales todavía pendientes
- ¿Se permite sobre-preparar unidades, o requiere supervisor?
- ¿El WMS puede despachar lotes o LIFO/FIFO específicos en picking?
- ¿Qué pasa si la NV se anula en Bsale en pleno picking?

## 21. Recomendación de arquitectura para la siguiente fase
Se recomienda adoptar un esquema de eventos asíncronos para el ingreso de NV, implementando un Webhook receptor, que empuje directamente la NV a una cola de materialización de Logística. Mantener la tabla `sales_order_preparation_cards` como pivote operacional pero encapsulando el acceso en la App mediante nuevos endpoints orientados a casos de uso (ej: `take_order`, `scan_item`, `report_incident`).

## 22. Orden recomendado de implementación posterior
1. **Infraestructura Core**: Implementar Webhooks Bsale para ingesta en tiempo real.
2. **Desacoplamiento Catálogo**: Trasladar o crear vista federada de Códigos de Barras a un módulo común/Catálogo Global.
3. **API Bodega (Backend)**: Endpoints atómicos (bloqueo, escaneo, movimiento).
4. **App Frontend Bodega**: Interfaz mobile first (Zxing, cámara).

---

# Respuestas Obligatorias

### A. ¿Debemos evolucionar el actual módulo `logistica.sales_order_preparation_*` o construir otro paralelo?
**Recomendación**: Evolucionar el actual. La infraestructura transaccional de tarjetas, movimientos y reglas de ruta es robusta y reciente (julio 2026). Reemplazarlo duplicaría código y generaría divergencia funcional con reportes o el ERP actual. Solo deben agregarse estados adicionales (si faltan para auditoría fina) y APIs estrictas encima.

### B. ¿Dónde debería vivir conceptualmente el futuro maestro transversal de códigos de barra?
**Recomendación**: En un esquema `catalog` (o el esquema transversal de `adquisiciones`), no en `inventarios`. Los códigos de barras son identificadores universales intrínsecos del producto, consumidos por compras, ventas, despachos e inventarios. El submódulo de resoluciones de incidencias sí puede vivir en inventarios, pero la tabla maestra aprobada de aliases debe promoverse al catálogo base.

### C. ¿Qué arquitectura de sincronización recomienda?
**Recomendación**: Sincronización operacional bajo demanda + Webhook Bsale + Reconciliación periódica (Cron).
- Webhook detecta la NV/Factura casi en tiempo real (Push) asegurando la inmediatez logística.
- Si falla el Webhook, la reconciliación periódica (cada N minutos) garantiza completitud (Eventual Consistency).

### D. ¿Cuál debería ser el primer bloque funcional implementable después de cerrar arquitectura?
**Recomendación**: El webhook receptor y materializador de Notas de Venta. Es un componente técnico pequeño, de backend, completamente observable (se puede validar en la BD y logs). Si la NV cae sola a PetGroup segundos después de crearse en Bsale, la confianza en el sistema habilita el desarrollo posterior seguro de la App Bodega.

## Fase 0B — Validación remota y contratos vigentes

Esta sección se agregó tras comprobar los contratos operacionales vigentes en BD (producción) y el código base.

### 1. Mecanismo REAL que ejecuta syncBsaleSales
**CONFIRMADO**. El proceso que descarga NVs (`syncBsaleSales`) se invoca a través de una tarea programada central `runReplenishmentBsaleSync` expuesta en `src/app/api/cron/sync-replenishment/route.ts` (posiblemente gatillada externamente vía Vercel Cron).
- *Frecuencia observada*: En `bsale_sync_runs` existen gatillos `SCHEDULED` y `MANUAL`. No depende exclusivamente de `sync_job_configs` para `sales/documents`.

### 2. Auditar sync dirigido existente
`syncBsaleDocumentsForRouteGuide(...)` se ubica en `src/app/actions/integraciones/bsale-sync.ts`. Busca individualmente documentos de tipo factura o guías por número, consumiendo el endpoint `/documents.json` filtrado y pidiendo sus detalles y clientes (`syncDirectedClient`).
- **Decisión arquitectónica**: **REUTILIZABLE CON EXTENSIÓN**. Este patrón "dirigido" ya soluciona el fetch síncrono, pero su firma y aserciones están restringidas explícitamente a tipos de documento 5 y 7 (no NVs tipo 23) y está condicionado a `route_guide_id` o `settlement_id`.

### 3. Sync específico de Nota de Venta
**CAPACIDAD PARCIAL**. Como se expuso arriba, se implementó el framework para consultar individualmente y persistir (upsert), pero enfocado en Facturas/Guías para Rendición de Ruta. Debe extenderse para permitir explícitamente NVs (tipo 23).

### 4. Seguridad REAL de Preparación de Pedidos
Las tablas `logistica.sales_order_preparation_cards` y `movements` cuentan con la política (RLS): `SELECT TO authenticated USING (true)`.
- **Consecuencia real**: Cualquier usuario autenticado en la plataforma, independiente de sus roles corporativos en su empresa, puede teóricamente leer todas las tarjetas y movimientos, incluyendo las de otras empresas.
- **Decisión**: **APTO CON HARDENING**. Se debe ajustar el RLS a un chequeo restrictivo de `company_id` y permisos.

### 5. Identidad operacional
Los campos `assigned_user_id`, `locked_by_user_id` y `moved_by` son de tipo UUID, pero **NO EXISTE restricción de Foreign Key** hacia `auth.users` ni `portal.users` a nivel de base de datos.
- Se escriben programáticamente pero la base de datos no asegura la integridad referencial.

### 6. Estado operacional real del módulo
**ESTRUCTURA MATERIALIZADA PERO NO OPERADA**.
- *Fase 0 decía*: Infraestructura transaccional robusta (movimientos).
- *Validación 0B*: En producción existen **489 tarjetas en PENDING_ROUTE_PREP**, **27 CANCELLED**, pero **0 (cero) registros** en `logistica.sales_order_preparation_movements`. El flujo jamás ha transitado etapas (`IN_PREPARATION` -> `IN_AUDIT`, etc.).
- *Conclusión vigente*: El tablero fue alimentado automáticamente por las rutinas de materialización de ruta, pero jamás ha sido operado por bodegueros en la práctica.

### 7. Máquina de estados vigente
- Restricción en BD (CHECK constraint): `PENDING_ROUTE_PREP`, `IN_PREPARATION`, `IN_AUDIT`, `INVOICED_READY_FOR_ROUTE`, `CANCELLED`.
- `INVOICED_READY_FOR_ROUTE` no es operada manualmente (evidenciado por los cero `movements`). Ocurre mediante la materialización de próxima ruta cuando detecta la factura a través de la vista.

### 8. NV activa, modificada y anulada
- *Fase 0 decía*: Consolidación entre cabecera y detalles.
- *Validación 0B*: **Existe una divergencia crítica en los filtros de las vistas**. `vw_bsale_sales_orders_for_preparation` (cabecera) incluye todas las NVs Tipo 23, mientras que `vw_bsale_sales_order_items_for_preparation` (detalles) aplica un filtro estricto `nv.state = 0`.
- *Conclusión vigente*: Una NV anulada en Bsale (`state = 1`) y re-sincronizada a PetGroup seguirá mostrándose en el listado de cabecera como un pedido, pero **sus líneas de detalle desaparecerán**, generando una vista fantasma e inconsistente para un operador logístico.

### 9. NV → Factura
La detección usa la vista `vw_bsale_sales_orders_for_preparation` donde aplica el JOIN contra `bsale_document_references` (Factura Tipo 5 referenciando a NV).
- La latencia es equivalente a lo que tarde en ejecutarse el Cron que descarga `syncBsaleSales` (ya no es un realtime event). El cambio a `INVOICED_READY_FOR_ROUTE` depende totalmente de este pull periódico.

### 10. Cobertura WMS e Inventarios (Variant, WMS y Barcodes)
- **Barcodes remotos**: `inventarios.product_barcode_aliases` tiene un índice que restringe `UNIQUE(company_id, barcode) WHERE is_active=true`.
- **¿Existe maestro transversal?**: **NO**. Está fuertemente acoplado en `inventarios`.
- **Cobertura Variant -> Product -> WMS**: Debido a que todo el módulo de preparación está materializado pasivamente y no hay operarios consumiendo stock, `v_stock_by_location` no se encuentra acoplado.

### 11. Concurrencia / locking de preparación
**NO SEGURO**. `locked_by_user_id` y `locked_at` se actualizan. Sin embargo, no existe exclusión mutua pesada (tipo `SELECT FOR UPDATE` ni `pg_advisory_lock` explícito) durante la reclamación de la tarjeta que impida una carrera al 100%.

### 12. Materialización de próxima ruta
Las 487 tarjetas observadas fueron generadas masivamente por las funciones de materialización (`sync_sales_order_preparation_cards` / `materialize_next_route_preparation_cards`), no interactuadas.

### 13. Objetos legado y duplicados

| Objeto | Estado | Consumidor vigente | Recomendación futura |
| ------ | ------ | ------------------ | -------------------- |
| `preview_next_route_candidates` | VIGENTE | Funciones CRON y Route Views | Limpiar tras refactor |
| `vw_bsale_sales_orders_for_preparation` | VIGENTE | Kanban Logístico (Board) | Corregir filtros / Separar DTOs |
| `vw_bsale_sales_order_items_for_preparation` | VIGENTE | Detalles Kanban Logístico | Remover filtro `state=0` o alinear cabecera |

### 14. Decisiones obligatorias al cerrar 0B

* **A. Sync Bsale (¿Patrón dirigido reutilizable para App Bodega?)**: PARCIAL (existe para facturas y guías en Rendiciones, se puede abstraer para NVs).
* **B. Preparación actual (¿Evolucionar `sales_order_preparation_*`?)**: SÍ (La tabla existe y tiene 489 registros de pruebas reales; mejor agregar hardening RLS y reparar vistas que tirar a la basura el constraint).
* **C. Seguridad (¿Puede exponerse directamente a Mobile?)**: NO (El RLS `USING (true)` expone cross-tenant data. Requiere hardening urgente).
* **D. Producto → ubicación (¿Cobertura suficiente para sugerir ubicaciones?)**: PARCIAL. (Stock funciona en base a kardex, pero la interfaz UI deberá lidiar con líneas no mapeadas al maestro).
* **E. Barcode (¿Permanecer en inventarios?)**: NO.
* **F. Bloqueadores restantes**:
    1. Ajustar RLS de `sales_order_preparation_cards` / `movements`.
    2. Alinear las reglas de `state = 0` / `state = 1` (Anuladas) entre las vistas de cabecera y detalles de preparación.
    3. Extender el patrón de sync Bsale individual (Webhook/Pulling Dirigido) para aceptar DocumentType=23.
