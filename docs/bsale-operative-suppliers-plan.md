# Resumen de Migración: Proveedores Operativos Bsale

Este documento resume el progreso realizado hoy para la lógica de proveedores operativos desde Bsale y el estado actual del repositorio, para continuar de manera segura en otra estación de trabajo.

## ¿Qué se hizo hoy?

1. **Definición de lógica de negocio:** 
   Se definió que en Bsale no existen proveedores reales y que se usará `product_type.name` completo como proveedor operativo sin cortar antes de `/`, ni aplicar alias. Solo se normalizan espacios, trim y uppercase. Se manejan exclusiones específicas (ej. `SIN TIPO`).

2. **Infraestructura en Supabase:**
   - Se conectó el proyecto remoto vía Supabase CLI.
   - Migración de esquema: Se aplicó `20260705000000_bsale_product_types.sql` para crear la tabla base.
   - Migración de permisos: Se creó y aplicó (`npx supabase db push`) la migración `20260705000001_bsale_product_types_grants.sql` que soluciona los errores de permisos (RSL/Grants) en la tabla para el esquema de integraciones.

3. **Sincronización (Catálogo):**
   - El script temporal logró insertar con éxito:
     - 200 product_types
     - 2,250 products
     - 3,500 variants
     - 1,300 stocks
   - Ahora el esquema `integraciones` de Supabase remoto está correctamente poblado con el catálogo de Bsale de la compañía.

4. **Script de Migración Principal (`scripts/migrate_operative_suppliers.ts`):**
   - Se refactorizó totalmente para operar de forma segura: por defecto usa `--dry-run`.
   - Se añadió un mecanismo de fetch paginado que evade el límite de 1,000 registros por consulta de la API de Supabase, logrando proyectar un total de **3,585 variantes** con SKU.
   - Se mejoró el filtrado de tipos excluidos usando comprobaciones exactas e insensibles a mayúsculas (`SIN TIPO`, `TIPO DE PRODUCTO O SERVICIO`, `DEMO BSALE`, etc).
   - El script es capaz de iterar, validar dependencias y estructurar la inserción en el esquema `adquisiciones`. No efectúa cambios a menos que se usen de forma explícita los argumentos `--apply` y `--confirm-remote`.

## Estado Actual Remoto (Fase 4C Completada - 06 de Julio de 2026)
- **`adquisiciones.products`**: 3.585 productos importados exitosamente.
- **`adquisiciones.product_supplier_mappings`**: 3.583 mappings creados exitosamente.
- **Proveedores**: 352 proveedores operativos activos. Los proveedores "basura" (SIN TIPO, DEMO BSALE, etc.) se excluyeron correctamente.

### Resultados Fase 4C (Validación SQL Final)
- **Empresa Objetivo:** DISTRIBUIDORA MYM (`d1000000-0000-0000-0000-000000000001`).
- **Productos importados:** 3.585
- **Mappings creados:** 3.583
- **Mappings con costo > 0:** 1.780
- **Mappings con costo = 0:** 1.803
- **Productos sin proveedor/mapping:** 2 (SKU `74920` y `CNTG0`). Ambos se importaron correctamente al catálogo pero sin mapping asociado.
- **SKUs Duplicados:** 0 (Se garantizó la idempotencia completa).
- **Protección de Entorno:** El script fue actualizado para abortar inmediatamente si intenta ejecutarse en un entorno o company_id distinto a DISTRIBUIDORA MYM (`d1000000-0000-0000-0000-000000000001`), y la lógica es ahora 100% idempotente (manual, evadiendo fallos por falta de unique constraints en PostgREST).
- **Nota sobre Data Antigua (`d200`):** Existe data cargada bajo la compañía original PetGrup (`d2000000-0000-0000-0000-000000000002`). Esta data duplicada queda pendiente de limpieza futura y no genera impacto operativo en el entorno activo.

## Próximos pasos recomendados
1. Habilitar la función "Generar OC" (Órdenes de Compra) en la UI y verificar que los productos operativos estén disponibles.
2. Definir si la limpieza de la compañía `d200` (PetGrup) se ejecutará mediante script directo o durante el cierre final de pruebas.
3. Avanzar con la visualización y análisis de costos/ventas en Órdenes de Compra usando los nuevos mappings.
