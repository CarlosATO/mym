# Auditoría Bsale: Proveedor en Bsale y Proveedor Real

Fecha de lectura: 2026-08-19. Empresa auditada: DISTRIBUIDORA MYM (`d1000000-0000-0000-0000-000000000001`).

Esta auditoría fue read-only. No se modificaron código, esquema, productos, mappings ni suppliers.

## Resumen ejecutivo

- La integración efectiva de catálogo usa `GET /variants.json?expand=product,product_type&limit=50&offset=N` en `src/lib/integraciones/bsale-products-sync.ts`.
- Bsale entrega Marca dentro de `variant.product.brand`, como objeto `{ id, href }`; el espejo legado conserva el objeto en `integraciones.bsale_products.raw_json`.
- No existe `bsale_brand_id`, nombre de marca sincronizado ni tabla de marcas.
- `adquisiciones.products.brand` es la columna que la UI muestra como Marca, pero la sincronización V2 no la lee ni la escribe.
- En la base auditada: 1.240 productos Bsale activos, 0 con `brand` informado, cobertura efectiva 0,00%.
- En el espejo legado sí existe información de IDs de Marca. Ejemplo control: ADD CALM GEL tiene `brand.id = 29`, pero el endpoint de marcas probado devuelve 404 y el espejo no conserva el nombre.
- Suppliers: 306 en total, 27 `REAL` y 279 `BSALE_OPERATIVE`. El modelo actual no tiene una categoría persistida `DUDOSO`; cualquier dudoso debe ser una clasificación analítica, no una inferencia automática.
- Los 1.239 activos con mapping dependen de un `BSALE_OPERATIVE`; 0 activos tienen mapping directo a `REAL`; 1 activo no tiene mapping; 10 tienen múltiples mappings activos.
- No es seguro migrar por proveedor operativo completo: el mapping actual es por producto/SKU y ya existen agrupaciones por tipo Bsale. La migración futura debe ser por producto/mapping.

## 1. Flujo Bsale -> Catálogo

### Flujo V2 efectivo

`src/lib/integraciones/bsale-catalog-auto-sync.ts` ejecuta, en este orden:

1. `syncBsaleProductTypes`: `GET /product_types.json`; persiste `integraciones.bsale_product_types` y crea/actualiza suppliers `BSALE_OPERATIVE`.
2. `syncBsaleProducts`: `GET /variants.json?expand=product,product_type`; transforma cada variante en `adquisiciones.products`.
3. `syncProductSupplierMappings`: usa `products.bsale_product_type_name` para crear mappings a pseudoproveedores.

El mismo flujo es llamado por `src/app/actions/integraciones/bsale-sync.ts` para sincronizaciones de catálogo manuales/programadas y por las rutas/actions específicas de products.

### Campos recuperados en la variante

La transformación V2 usa:

| Bsale | Persistencia/uso |
|---|---|
| `v.id` | `products.bsale_variant_id`, `integraciones.bsale_variants.bsale_id` en el flujo legado |
| `v.product.id` | `products.bsale_product_id` |
| `v.code` | `products.sku` |
| `v.barCode` | `products.barcode` |
| `v.description` + `v.product.name` | `products.description` |
| `v.state` | `products.bsale_variant_state` |
| `v.product.state` | `products.bsale_product_state` |
| `v.product.product_type.id/name` | `bsale_product_type_id/name`, `product_type` |
| `v.product.brand` | No se transforma a columna de catálogo |
| `v` completo | No se persiste en V2; el flujo legado lo conserva en `integraciones.bsale_variants.raw_json` |

El flujo legado de `src/app/actions/integraciones/bsale-sync.ts` también sincroniza `/products.json` a `integraciones.bsale_products`, `/variants.json` a `integraciones.bsale_variants`, y conserva el payload completo en `raw_json`. Hay, por tanto, dos generaciones coexistentes; no deben confundirse sus responsabilidades.

## 2. Marca de Bsale

### Fuente y estructura

El campo recibido es `brand`, ubicado en el producto expandido (`v.product.brand`), no en el objeto propio de variante. Estructura observada:

```json
"brand": {
  "href": "https://api.bsale.io/v1/brands/29.json",
  "id": "29"
}
```

El producto de control `ADD CALM GEL` (`product_id=4347`, `variant_id=7034`, SKU `78353602353325`) devuelve `brand.id=29`. El nombre operacional informado por negocio es `ANASAC HAMBIENTAL S.A.`; ese nombre no está persistido en las tablas auditadas.

La consulta directa a `/brands.json`, `/brands/29.json` y `/brands/29` devolvió 404 en el API configurado. Por eso no se debe presentar el nombre de Marca como dato técnico confirmado desde el espejo actual: sólo se confirmó el ID y el valor de negocio indicado para el caso de control.

### Persistencia

| Dato | Existe | Ubicación |
|---|---:|---|
| Nombre de Marca en catálogo | Sí, como columna genérica | `adquisiciones.products.brand varchar(120) NULL` |
| `bsale_brand_id` | No | No existe columna equivalente |
| Nombre de Marca fuente Bsale | No en tabla normalizada | Sólo podría reconstruirse si se consulta Bsale |
| Objeto Brand fuente | Sí en espejo legado | `integraciones.bsale_products.raw_json->'brand'` |
| Catálogo propio de marcas | No encontrado | No hay tabla `brands`/`bsale_brands` |

En la lectura remota, `products.brand` fue `NULL` para los 1.240 activos Bsale. Por tanto, la UI no está mostrando actualmente el nuevo dato de Marca Bsale; muestra el campo de catálogo vacío.

## 3. Catálogo y columnas

La pantalla `src/modules/adquisiciones/catalogo/catalog-panel.tsx` obtiene filas mediante `getProducts()` y renderiza directamente `Product`.

| Columna UI | Fuente actual |
|---|---|
| SKU | `adquisiciones.products.sku` |
| Código barra | `products.barcode` |
| Descripción | `products.description` |
| Proveedor real | mapping activo seleccionado por `getProducts()` -> `suppliers` o parent |
| Origen prov. | calculado: `DIRECTO` para REAL; nombre del BSALE_OPERATIVE para pseudoproveedor |
| Marca | `products.brand` |
| Categoría | `products.category` |
| Tipo Bsale | `products.bsale_product_type_name`, fallback `product_type` |
| Presentación | `products.presentation` |
| U.Medida | `products.unit_of_measure` |

El label Marca todavía describe el significado físico de la columna, pero no el significado operacional nuevo. Técnicamente se podría renombrar sólo el label una vez que el campo sea alimentado por la fuente correcta; hoy hacerlo sería engañoso porque la columna está vacía para Bsale.

## 4. Proveedor Real y Origen Prov.

La resolución actual es:

`products.id -> product_supplier_mappings.product_id -> supplier_id -> suppliers`

- `suppliers.supplier_kind = REAL`: Proveedor Real directo; estado `DIRECTO`.
- `suppliers.supplier_kind = BSALE_OPERATIVE` y `parent_supplier_id` informado: Proveedor Real = supplier padre; estado `ASOCIADO`.
- `BSALE_OPERATIVE` sin padre: estado `PENDIENTE_ASOCIACION`; Proveedor Real vacío.
- Sin mapping o supplier encontrado: `SIN_PROVEEDOR`.

`Origen Prov.` no viene de Marca, ni es el Tipo Bsale puro, ni es una inferencia por nombre. Es un label calculado desde el supplier del mapping: `DIRECTO` para asociación directa o el nombre del pseudoproveedor operativo. En ejemplos como `MERCOSUR/ALIMENTO` + `ASOCIADO`, el primer valor es el pseudoproveedor y el segundo es el estado de resolución.

Hay una diferencia de prioridad que debe considerarse: la pantalla escoge el primer mapping activo, privilegiando activo sobre inactivo, pero no fuerza `is_preferred`; los consumidores de reposición/OC sí consultan `is_preferred=true AND is_active=true`.

## 5. product_supplier_mappings

Estructura efectiva:

| Columna | Tipo/rol |
|---|---|
| `id` | UUID PK |
| `company_id` | UUID obligatorio |
| `product_id` | UUID FK a products, nullable |
| `supplier_id` | UUID FK a suppliers, obligatorio |
| `bsale_variant_id` | integer nullable |
| `sku` | text obligatorio |
| `unit_cost` | numeric nullable |
| `is_preferred` | boolean |
| `is_active` | boolean |
| `synced_at`, `created_at`, `updated_at` | timestamps |

Restricciones importantes: única `(company_id, supplier_id, sku)` y único mapping preferido activo por `(company_id, sku)`. No hay una columna `manual` ni `origin` persistida en el mapping. La procedencia se infiere por el supplier, timestamps y el flujo que lo creó.

El mapping oficial actual para compras/reposición es el mapping activo y preferido. Los consumidores incluyen catálogo, reposición, generación de órdenes de compra, análisis comercial, Proveedor 360/Producto 360 y comisiones.

## 6. Suppliers y pseudoproveedores

`suppliers` tiene RUT (`rut`, `rut_normalized`), nombre comercial, estado y metadatos. En la empresa auditada:

| Clasificación técnica | Cantidad |
|---|---:|
| Total suppliers | 306 |
| `REAL` | 27 |
| `BSALE_OPERATIVE` | 279 |
| `DUDOSO` persistido | 0 |

`BSALE_OPERATIVE` es la definición técnica de pseudoproveedor: `supplier_kind`, usualmente `source='BSALE'`, `bsale_product_type_name` y opcionalmente `parent_supplier_id`. Se crean/actualizan desde `product_types.json`; el nombre coincide normalmente con el `product_type.name`, como `MERCOSUR/ALIMENTO`. El código de alias existente (`src/lib/bsale/supplier-aliases.ts`) aplica a lógica histórica/auxiliar de nombres, no a Marca Bsale.

No se identificó un flag `DUDOSO`. Los proveedores `REAL` sin RUT pueden ser comercialmente dudosos, pero no se reclasificaron por nombre durante esta auditoría.

## 7. Métricas remotas

La fuente usada para actividad fue `adquisiciones.products.is_active`, reforzada por `source='BSALE'`; la sincronización V2 calcula ese valor como `product.state=0 AND variant.state=0`.

| Métrica | Resultado |
|---|---:|
| Productos de empresa | 3.645 |
| Productos fuente Bsale | 3.642 |
| Productos Bsale activos | 1.240 |
| Activos con Marca/Proveedor en Bsale persistido | 0 |
| Activos sin Marca | 1.240 |
| Activos con Marca vacía | 1.240 |
| Cobertura nueva regla | 0,00% |
| Activos con mapping activo | 1.239 |
| Activos con mapping a REAL directo | 0 |
| Activos con mapping a pseudoproveedor | 1.239 |
| Activos sin proveedor/mapping | 1 |
| Activos con múltiples mappings activos | 10 |

Los valores visibles en la tabla por `bsale_product_type_name` no son Marca. Los principales fueron `HAGEN/JUGUETES` (113), `HAGEN/HIGIENE` (77), `HAGEN/A-C-T` (71), `GRMOR/ALIMENTO` (50), `LUDIPEK/SNACK` (49), `MERCOSUR/ALIMENTO` (38) y `ANASAC/HIGIENE` (37).

## 8. Matching Marca -> proveedor real

No se puede ejecutar un matching confiable sobre la cobertura actual porque el valor de Marca no está persistido como nombre. Resultado auditado:

| Clase | Cantidad de valores/productos evaluables |
|---|---:|
| EXACTA | 0 |
| NORMALIZABLE | 0 |
| AMBIGUA | 0 |
| SIN MATCH | 0 |
| No evaluable por ausencia de nombre | 1.240 activos |

Esto no significa que no existan coincidencias de negocio; significa que el ERP no conserva el valor textual necesario para compararlas. El RUT tampoco viene en Marca. Por ello, aun con nombre, un match automático sólo podría ser candidato, no identidad jurídica absoluta.

No existe una tabla de aliases `supplier aliases` persistida. La normalización existente es limitada: uppercase/trim/espacios, eliminación de puntos/guiones para RUT y aliases de product type. No hay matching reutilizable Marca-Bsale -> supplier real.

## 9. Pseudoproveedor -> resolución futura

No se puede clasificar ningún pseudoproveedor como `RESOLVIBLE`, `MIXTO` o `INCOMPLETO` usando la nueva Marca, porque todos los productos activos auditados tienen Marca vacía. Con la información operacional actual, los pseudoproveedores muestran asociación por Tipo Bsale, no por Marca.

Ejemplos de dependencia actual:

- `ANASAC/FARMACOS` -> `ANASAC HAMBIENTAL S.A.`; 1.239 activos en total de todos los pseudoproveedores, y el grupo de control `ANASAC/HIGIENE` tiene 36 activos.
- `MERCOSUR/ALIMENTO` -> `DISTRIBUIDORA MERCOSUR SPA`; 38 activos.
- `ACWS/HIGIENE` -> `ANIMAL CARE - ACWS S.A.`; 21 activos.

Estas asociaciones por parent son útiles operacionalmente, pero no prueban que el nuevo campo Marca coincida producto a producto.

Los 10 productos con múltiples mappings activos incluyen duplicados del mismo pseudoproveedor y conflictos entre pseudoproveedores, por ejemplo `LVL254` (`GLAM/HIGIENE` y `MARBEN/HIGIENE`) y `69083050987887` (`NB-ALIMENTO` y `NB/ALIMENTO`). Esto confirma que una conversión global por pseudoproveedor sería riesgosa.

## 10. Conflictos

Con `products.brand` vacío en todos los activos Bsale:

- Conflicto 1, Proveedor Real A vs Marca B: 0 observables; no evaluable contra la fuente Bsale real.
- Conflicto 2, pseudoproveedor + Marca coincidente con real: 0 observables; no evaluable.
- Conflicto 3, Proveedor Real + Marca vacía: 0, porque no hay mappings activos a REAL directo.
- Conflicto 4, Marca informada sin mapping: 0 observables; no evaluable.
- Conflicto 5, misma Marca con proveedores reales distintos: 0 observables; no evaluable.
- Conflicto 6, múltiples mappings activos: 10 productos.

El único activo sin mapping fue SKU `SH00514`, `SKOUTS HONOR GATO DESODORIZANTE PARA CAJAS DE ARENA 1035ML`, con Tipo Bsale `HAGEN/HIGIENE`.

## 11. Casos de control

### ADD CALM GEL

- SKU: `78353602353325`
- Producto Bsale: `4347`
- Variante Bsale: `7034`
- Descripción: `ADD CALM GEL 15ML`
- Marca fuente: objeto `brand`, `id=29`; nombre operacional informado: `ANASAC HAMBIENTAL S.A.`
- `products.brand`: `NULL`
- Tipo Bsale: `ANASAC/FARMACOS`
- Mapping: `ANASAC/FARMACOS`, `BSALE_OPERATIVE`, activo
- Proveedor Real actual: `ANASAC HAMBIENTAL S.A.` vía `parent_supplier_id`
- Estado UI: `ASOCIADO`

El caso confirma que el ERP actualmente obtiene Proveedor Real desde el pseudoproveedor/parent, no desde Marca.

### MERCOSUR

Productos auditados como SKU `00044`, `00046`, `00001`, `00054` y `00029` tienen:

- `products.brand`: `NULL`
- Tipo Bsale: `MERCOSUR/ALIMENTO` o `MERCOSUR/ALIM. HUMEDO`
- Mapping activo preferido al pseudoproveedor correspondiente
- Parent: `DISTRIBUIDORA MERCOSUR SPA`
- Estado: `ASOCIADO`

Por tanto, `Origen Prov. = MERCOSUR/ALIMENTO` representa el pseudoproveedor operativo; `ASOCIADO` representa que ese pseudoproveedor tiene parent real. No es una Marca ni una fuente independiente de proveedor.

## 12. Incremental y producto nuevo

### Cambio de Marca A -> B

En el código vigente:

- El API volvería a entregar `v.product.brand`.
- V2 no lo copia a `products.brand`, por lo que no actualiza el campo de catálogo.
- El espejo legacy puede sobrescribir `raw_json` de `bsale_products`, sin historial de versiones.
- No existe lógica que actualice `product_supplier_mappings` desde Marca.
- El mapping sólo cambia por el flujo de product type/auto-mapping, o por edición explícita de asociaciones; no por Marca.

### Producto nuevo

`BSALE -> sync` crea el producto con SKU, barcode, descripción, IDs/estados/tipo Bsale y `is_active`. Después el auto-mapping busca `bsale_product_type_name`, crea si falta un `BSALE_OPERATIVE` y crea el mapping. La Marca no se copia; el producto nuevo termina con `brand=NULL`, pseudoproveedor derivado del Tipo Bsale y Proveedor Real sólo si el pseudoproveedor ya tiene parent.

## 13. Consumidores e impacto

Consumidores encontrados:

- Catálogo: uso visual de `products.brand`; también permite búsqueda/filtro.
- Análisis de ventas: carga `marca` y ofrece filtro/agrupación; uso visual/analítico.
- Órdenes de Compra: muestra/recibe marca en formulario, pero la selección del proveedor usa mappings.
- Reposición: usa mapping activo/preferido y parent real para filtrar y resolver.
- Proveedor 360 y análisis comercial: agregan ventas por supplier real, incluyendo parent de pseudoproveedor.
- Comisiones: usa mappings activos/preferidos.
- Inventarios: snapshots pueden congelar `brand` de `products`; no es fuente de resolución de proveedor.
- Producto 360/WMS/Logística: aparecen como consumidores de catálogo/brand para presentación o búsqueda; no se encontró regla que convierta brand en supplier_id.

Riesgos reales de pseudoproveedores: dependencia de parent para generar OC, bloqueo de OC cuando no hay parent, análisis que sólo cuenta ventas si puede resolver parent, y distorsión por mappings múltiples o pseudoproveedores que agrupan variantes. No se observó lógica que use `brand` para decisiones de compra.

## 14. Arquitectura futura y bloques sugeridos

La separación recomendada es válida:

- Bsale: fuente operacional de `Proveedor en Bsale`.
- ERP: fuente normalizada de `Proveedor Real`, RUT y estado.
- Mapping/alias validado: relación entre ambos conceptos, con evidencia y revisión.

Bloques posteriores, sin implementar en esta auditoría:

1. **PROV-1:** definir persistencia explícita de `bsale_brand_id` y nombre fuente, con actualización incremental y trazabilidad.
2. **PROV-2:** crear catálogo/aliases Bsale -> supplier real, con revisión humana y RUT cuando exista evidencia externa; no inferir RUT desde nombre.
3. **PROV-3:** producir candidatos por producto y migrar únicamente mappings confiables, preservando historial y evitando convertir un pseudoproveedor completo.
4. **PROV-4:** resolver mixtos, faltantes, múltiples mappings y pseudoproveedores sin parent; medir activos antes de cualquier desactivación.
5. **PROV-5:** sólo después de validar impacto en OC, reposición, análisis, comisiones y 360, evaluar retiro gradual de pseudoproveedores.

El rename de UI `Marca -> Proveedor en Bsale` es conceptualmente correcto para productos Bsale cuando el dato persistido sea el de Bsale. No debe aplicarse indiscriminadamente a productos manuales ni a todos los módulos donde `brand` conserva semántica real de marca.

## 15. Confirmación de alcance

Durante esta auditoría sólo se hicieron lecturas de archivos, esquema/payloads y consultas SELECT/API GET. No se modificó código, no se modificaron datos, no se crearon proveedores, no se reasignaron productos/mappings, no se eliminaron ni desactivaron pseudoproveedores y no se crearon aliases.
