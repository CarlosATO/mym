# Walkthrough: Clasificación de Pseudoproveedores Bsale

## Resumen de Tareas Realizadas

1. **Migración SQL Estructural:**
   - Se aplicó y validó la migración `20260706120000_supplier_real_operational_hierarchy.sql` que agregó las columnas necesarias para la jerarquía de proveedores (`supplier_kind`, `parent_supplier_id`, `bsale_product_type_id`, `source`, etc.).
   - Se aplicó la migración de corrección `20260706130000_supplier_bsale_type_uuid_fix.sql` para ajustar el tipo de dato de `bsale_product_type_id` a `uuid`.

2. **Clasificación Masiva Segura:**
   - Se actualizó el script `scripts/classify_bsale_pseudo_suppliers.ts` y se ejecutó en modo apply.
   - El 100% de los proveedores actuales (269) fueron identificados y marcados como `supplier_kind = 'BSALE_OPERATIVE'` y se les asignó `source = 'BSALE'`.
   - Se pobló el `bsale_product_type_id` de forma cruzada con la tabla de integraciones.

3. **Hallazgos Específicos (Excepciones):**
   - 3 pseudoproveedores (`BEWICAT/ALIMENTO HUMEDO`, `BEWIDOG/ALIMENTO HUMEDO`, `BELCANDO/SUPLEMENTO`) quedaron sin `bsale_product_type_id` ni `name` porque no coinciden con ningún tipo vigente en Bsale.
   - Estos 3 proveedores tienen **0 mappings y 0 productos asociados**. No causan ningún efecto secundario negativo en la BD.

4. **Preservación de Estado Operativo:**
   - No se modificaron productos.
   - No se modificaron stocks ni costos.
   - No se modificaron los mappings de productos-proveedor (se mantuvieron los 3.583 mappings).
   - Existen 2 productos sin mapping: SKU 74920 y SKU CNTG0.
   - Total products = 3.585.
   - No se crearon proveedores reales de forma artificial.
   - No se alteró ningún dato en Bsale.

## Fase 1: Asociación de Proveedores (UI)
- Se implementó la vista "Proveedores Reales" que lista de forma exclusiva a los proveedores con `supplier_kind = 'REAL'`.
- Se implementó la vista "Pseudoproveedores Bsale" para listar a los 269 proveedores operativos, excluyendo los 88 registros huérfanos históricos de otra empresa.
- Se agregó el formulario de "Nuevo Proveedor Real" que permite buscar y agrupar los pseudoproveedores Bsale, marcándolos con `parent_supplier_id = [NuevoProveedorReal.id]`.
- Se previno el error N+1 en las UI utilizando cruces optimizados con `.in()`.
- La UI no crea, actualiza, ni elimina mappings (eso permanece delegándose a otras fases).

## Fase 2: Proveedor en Catálogo
1. **Resolución Bulk (sin N+1):** Se modificó la carga de productos (`getProducts`) para que resuelva la cadena de mappings, obteniendo el `supplier_kind` original y el `parent_supplier_id` subyacente de un solo golpe para la página activa.
2. **Nuevo Action:** `getRealSuppliers()` devuelve exclusivamente la lista de proveedores validos (`REAL`) a ser usados.
3. **Formulario Bsale Seguro:** En productos Bsale el bloque Proveedor es solo lectura, detallando `Pseudoproveedor Bsale`, `Proveedor Real Resuelto` y el `Estado Asociación` (`DIRECTO`, `ASOCIADO`, `PENDIENTE ASOCIACIÓN`, `SIN PROVEEDOR`).
4. **Productos Manuales:** Tienen habilitada la edición con un `<select>` que apunta a `getRealSuppliers()`. Si se elige uno, el action genera un nuevo registro `product_supplier_mappings` asociando al nuevo producto con `unit_cost: 0` de manera que quede pendiente de actualización financiera, preservando la trazabilidad.

La base de datos sigue protegida, no hay `supplier_id` físico en la tabla de productos, y toda la jerarquía de asociaciones se soporta desde la tabla transaccional `product_supplier_mappings`.

## Fase Sync Core
1. **Infraestructura Base de Sincronización**: Se creó el core robusto `Sync Core` bajo el schema `integraciones` que previene condiciones de carrera (`sync_locks`) y registra métricas detalladas (`sync_runs`, `sync_errors`).
2. **Sincronización Refactorizada**: La sincronización de Clientes Bsale se centralizó en un módulo compartido `src/lib/integraciones/bsale-clients-sync.ts`. Este puede ser llamado desde el CLI, Server Actions (UI) o API Cron, sin duplicar lógica.
3. **Monitoreo en el Panel de Clientes**: Ahora, el encabezado de "Comercial -> Clientes" despliega un estado en tiempo real. En caso de una sincronización exitosa, muestra la fecha y el estado; durante una ejecución activa, avisa y bloquea intentos paralelos gracias a los locks.
4. **Protección de Datos Local**: Cualquier actualización extraída desde Bsale nunca borrará el campo de notas administrativas asignadas desde el panel local de PetGrup.
5. **Sincronización Automatizada (Cron)**: El endpoint `POST /api/integraciones/bsale/clients/sync` se encuentra disponible y protegido por el secreto de la plataforma `CRON_SECRET`. (Requiere configuración externa de Cron).
