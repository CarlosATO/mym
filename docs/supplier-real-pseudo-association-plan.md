# Plan de Asociación: Proveedores Reales y Pseudoproveedores Bsale

Este plan documenta la estrategia para migrar el manejo de proveedores operativos de Bsale hacia un modelo estructurado en PetGrup con Proveedores Reales/Legales como entidad principal y Pseudoproveedores Bsale como entidades secundarias hijas.

## 1. Diagnóstico y Reporte de Dry-Run

El análisis del estado actual revela que la base de datos de proveedores importada desde Bsale no distingue entre proveedores legales y operativos. Bsale utiliza la categoría del producto (ej. `HAGEN/SNACK`) como un pseudoproveedor para agrupar operativamente los productos.

**Resultados de la Auditoría (`scripts/classify_bsale_pseudo_suppliers.ts`):**

- **Total de proveedores actuales:** 269 (100% clasificados como Candidatos a Pseudoproveedor Bsale).
- **Proveedores Activos:** 269 | **Inactivos:** 0
- **Pseudoproveedores con Mappings de productos:** 93
- **Pseudoproveedores sin Mappings de productos:** 176
- **Asociados a productos activos:** 25
- **Asociados SOLO a productos inactivos:** 52
- **Pseudoproveedores "basura" inactivos sin productos:** 0

### Excepciones detectadas en el mapeo Bsale
Durante la clasificación, 3 de los 269 proveedores fueron identificados como pseudoproveedores por su sintaxis (contienen `/`), pero no existe un tipo de producto equivalente exacto en `integraciones.bsale_product_types`, por lo que quedaron con `bsale_product_type_id` y `bsale_product_type_name` en valor `NULL`:
1. `BEWICAT/ALIMENTO HUMEDO`: 0 mappings, 0 productos asociados.
2. `BEWIDOG/ALIMENTO HUMEDO`: 0 mappings, 0 productos asociados.
3. `BELCANDO/SUPLEMENTO`: 0 mappings, 0 productos asociados.
*(Motivo: Probablemente existieron en Bsale y fueron sincronizados antes, pero ya no figuran en el diccionario de tipos de Bsale actual. Al no tener mappings, no afectan el catálogo).*

> [!WARNING]
> **Ningún proveedor actual tiene características de Proveedor Real.** Todos provienen de los tipos de producto importados de Bsale.

**Agrupación Sugerida por Raíz (Top 15):**

| Raíz Sugerida | Pseudos | Productos | Prod Activos | Prod Inactivos | Con Costo | Sin Costo |
|:--------------|:--------|:----------|:-------------|:---------------|:----------|:----------|
| HAGEN         | 17      | 250       | 109          | 27             | 203       | 47        |
| MARBEN        | 15      | 105       | 0            | 55             | 12        | 93        |
| ROYAL         | 2       | 105       | 0            | 55             | 35        | 70        |
| RYS           | 6       | 77        | 0            | 36             | 60        | 17        |
| GRMOR         | 10      | 65        | 19           | 23             | 46        | 19        |
| ACWS          | 15      | 59        | 15           | 14             | 37        | 22        |
| COMECAN       | 2       | 51        | 0            | 26             | 1         | 50        |
| BRIT          | 3       | 49        | 0            | 25             | 39        | 10        |
| VYA           | 1       | 39        | 0            | 22             | 0         | 39        |
| DOGSHOP       | 9       | 38        | 0            | 22             | 15        | 23        |
| AMIGO         | 11      | 37        | 1            | 17             | 8         | 29        |
| KOBOR         | 3       | 33        | 0            | 14             | 21        | 12        |
| SOUTHPOINT    | 5       | 26        | 0            | 11             | 4         | 22        |
| CAYLO         | 2       | 9         | 0            | 4              | 0         | 9         |
| DANDI         | 13      | 7         | 3            | 2              | 3         | 4         |

*(Muestra detallada guardada en `docs/pseudo-suppliers-sample.md`)*

## 2. Estructura Actual

- **`adquisiciones.suppliers`**: Carece de campos para distinguir el tipo de proveedor o jerarquías (no existen `supplier_kind`, `parent_supplier_id`, ni metadatos de integración Bsale).
- **`adquisiciones.product_supplier_mappings`**: Mantiene la relación fuerte `(product_id, supplier_id)`. **Esta estructura se mantendrá inalterada** para no romper el vínculo base entre un producto y su clasificación original (pseudoproveedor).

## 3. Migración Propuesta

Se ha creado la migración SQL `supabase/migrations/20260706120000_supplier_real_operational_hierarchy.sql` (NO aplicada).

**Columnas agregadas a `adquisiciones.suppliers`:**
- `supplier_kind varchar(30) DEFAULT 'REAL'` (Check: `REAL` o `BSALE_OPERATIVE`)
- `parent_supplier_id uuid NULL` (FK a `adquisiciones.suppliers(id) ON DELETE SET NULL`)
- `bsale_product_type_id integer NULL`
- `bsale_product_type_name text NULL`
- `source text NULL`
- `last_bsale_sync_at timestamptz NULL`

**Nuevos Índices:**
- `idx_suppliers_kind_company`
- `idx_suppliers_parent_company`
- `idx_suppliers_bsale_type_company`
- `idx_suppliers_bsale_type_unique` (Único para no duplicar los tipos base de Bsale por compañía).

## 4. Modelo Conceptual y Reglas de Negocio

- **Proveedor REAL:** Entidad principal con RUT, razón social y cuenta bancaria. 
- **Pseudoproveedor BSALE_OPERATIVE:** Derivado de `integraciones.bsale_product_types` (Ej. `ACWS/HIGIENE`). No se renombran ni eliminan.
- **Relación (Jerarquía):** Un `BSALE_OPERATIVE` tiene un `parent_supplier_id` que apunta a un `REAL`. 
- **Restricciones Lógicas (App):**
  - Un pseudoproveedor solo puede tener un único padre REAL a la vez.
  - El padre no puede ser a la vez hijo de otro (no recursivo), es decir, un `REAL` no tiene `parent_supplier_id`.
  - Los productos no cambian su mapping físico actual en base de datos.
  - La UI del Catálogo infiere el proveedor real a través de: `Producto -> Mappings -> Proveedor BSALE_OPERATIVE -> Proveedor REAL`.

## 5. Diseño de UI (Propuesta para Desarrollo Posterior)

### Vista Principal de Proveedores
- **Filtro base:** Solo lista los proveedores `supplier_kind = 'REAL'`.
- **Columnas añadidas:** Cantidad de Pseudoproveedores asociados y Cantidad de Productos inferidos.

### Pestaña "Pseudoproveedores Bsale"
- Tabla dedicada listando `supplier_kind = 'BSALE_OPERATIVE'`.
- Columnas: Nombre (Ej. `ACWS/HIGIENE`), Raíz Sugerida (`ACWS`), Proveedor Real Asociado, Productos Totales, Activos, Inactivos y Status de Costos.

### Formulario de Creación/Edición (Proveedor Real)
- **Sección "Asociar pseudoproveedores Bsale":** 
  - Listado con Checklist Múltiple.
  - Barra de búsqueda y filtrado por Raíz Sugerida.
  - Al guardar, la app hace un bulk update de `parent_supplier_id` sobre los pseudoproveedores seleccionados, apuntando al nuevo/editado proveedor real.

### Catálogo de Productos
- **Solución Técnica:** Crear una VIEW o RPC `adquisiciones.product_supplier_resolution` que en un solo join cruce el mapping con el pseudoproveedor y obtenga el nombre del Proveedor Real Padre para mostrarlo como columna "Proveedor Real" en la grilla del catálogo.

## 6. Riesgos y Mitigaciones

- **Riesgo:** Conflicto de reasociación si un usuario vincula un pseudoproveedor que ya pertenece a otro proveedor real.
  - **Mitigación:** La UI debe mostrar un warning de confirmación al usuario antes de permitir la reasignación en el guardado.
- **Riesgo:** Los queries actuales que listan todos los proveedores mezclarán reales y pseudoproveedores si no se filtran.
  - **Mitigación:** En FASE 2 de implementación UI, todas las actions de listado (`getSuppliers`) deben actualizarse para filtrar por defecto por `supplier_kind = 'REAL'`.

## 7. Pasos de Aplicación Recomendados

1. **APROBACIÓN DE MIGRACIÓN:** Ejecutar la migración SQL (`20260706120000...`).
2. **CLASIFICACIÓN MASIVA:** Correr el script `classify_bsale_pseudo_suppliers.ts --apply --confirm-remote` para marcar los 269 proveedores actuales como `BSALE_OPERATIVE`.
3. **ACTUALIZACIÓN DE ACTIONS:** Modificar las functions/actions de backend para inyectar `supplier_kind`.
4. **DESARROLLO UI:** Implementar la pestaña separada y el checklist de asociación en el Drawer de Proveedores.
