# UI Catálogo Bsale-aware: Cambios Implementados

Se han implementado con éxito todas las funcionalidades requeridas para exponer de forma segura y útil la metadata de Bsale en el panel del Catálogo, asegurando que todos los campos técnicos permanezcan de **solo lectura**.

## 1. Actualización de Acciones (Servidor)
[products.ts](file:///c:/Users/mympr/OneDrive/Desktop/PetGrup/mym/src/app/actions/adquisiciones/products.ts)
- Se añadieron los campos técnicos de Bsale (`source`, `bsale_product_id`, `bsale_status_conflict`, etc.) a la interfaz `Product`.
- Se añadieron 5 nuevos campos opcionales a la interfaz `ProductFilters` para permitir la búsqueda avanzada.
- La función `getProducts` ahora procesa correctamente los filtros (ej: si `bsale_inactive === 'true'`, se aplica `query.or('bsale_product_state.eq.1,bsale_variant_state.eq.1')`).
- **Validado:** `updateProduct` solo envía los campos procesados desde el FormData, sin tocar ni sobreescribir la nueva metadata de Bsale.

## 2. Mejoras en la Tabla Principal
[catalog-panel.tsx](file:///c:/Users/mympr/OneDrive/Desktop/PetGrup/mym/src/modules/adquisiciones/catalogo/catalog-panel.tsx)
- Se añadió la columna **"Tipo Bsale"** separada de Categoría, que muestra `bsale_product_type_name` (si existe) o `product_type`.
- Se añadió la columna **"Integ. Bsale"** justo antes de la columna "Estado". Esta columna muestra badges limpios para:
  - `BSALE` (fondo azul claro)
  - `LOTE` (fondo violeta)
  - `! CONFLICTO` (fondo ámbar con tooltip sobre el motivo)

## 3. Filtros Avanzados
- Se insertaron los 5 `<select>` solicitados en la grilla del panel de "Filtros Avanzados":
  1. Origen (Todos / Bsale / PetGrup)
  2. Conflicto Bsale (Todos / Sí)
  3. Estado Bsale (Todos / Inactivo en Bsale)
  4. Código Barra (Todos / Sin Código de Barra)
  5. Tipo Bsale (Todos / Sin Tipo Bsale)

## 4. Formulario de Edición y Guardado Seguro
- Al presionar **Editar**, se recopila la metadata de Bsale en un estado separado (`bsaleMeta`) para que no se mezcle con el `form` state.
- Se ha incorporado el bloque de **"Información de Integración Bsale"**, que solo se muestra si `source === 'BSALE'`. Este bloque es puramente texto y no contiene `<input>`, garantizando que no haya envío de estos datos al servidor al guardar.
- **Corrección Visual:** El sticky header superior ("Editar producto" / "Guardar") ahora utiliza `bg-theme-surface` y `z-20 shadow-sm`, evitando que los inputs pasen transparentemente detrás de él.

## 5. Verificación
- Se ejecutó de forma local `npx tsc --noEmit` sobre el código modificado y finalizó con **0 errores**, validando que los tipos y la interfaz están consistentes.
