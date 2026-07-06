# RESUMEN TÉCNICO — Integración Bsale + Reposición Inteligente

> Proyecto: PetGrup / MYM Distribuidora  
> Fecha: Julio 2026  
> Propósito: Documentar toda la implementación técnica para no perder el contexto

---

## ÍNDICE

1. [Arquitectura general](#1-arquitectura-general)
2. [Migraciones de base de datos](#2-migraciones-de-base-de-datos)
3. [Sincronización Bsale](#3-sincronización-bsale)
4. [Adaptador de datos Bsale](#4-adaptador-de-datos-bsale)
5. [Análisis de reposición (UI)](#5-análisis-de-reposición-ui)
6. [Vinculación producto-proveedor](#6-vinculación-producto-proveedor)
7. [Futuro: Generar OC](#7-futuro-generar-oc)
8. [Archivos creados/modificados](#8-archivos-creadosmodificados)
9. [Comandos útiles](#9-comandos-útiles)
10. [Pendientes](#10-pendientes)

---

## 1. Arquitectura general

### Esquemas en Supabase

| Schema | Propósito |
|---|---|
| `portal` | Usuarios, roles, permisos, auditoría |
| `core` | Empresas (multi-company), acceso usuario-empresa |
| `adquisiciones` | Órdenes de compra, productos, proveedores, análisis |
| `logistica` | Recepciones, stock, kardex, guías de ruta |
| **`integraciones`** | **NUEVO** — Espejo solo lectura de Bsale |

### Flujo de datos

```
Bsale API (solo GET)
       │
       ▼
integraciones.*  ← Sincronización programada (Server Action + Cron)
       │
       ▼
  getReplenishmentDatasetFromBsale()  ← Adaptador
       │
       ▼
  buildSkuSummary() + classifySkus()  ← Motor de análisis existente
       │
       ▼
  Tabla de Reposición Inteligente (UI)
       │
       ▼
  product_supplier_mappings  ← Vinculación manual
       │
       ▼
  create_purchase_order() RPC  ← Generar OC (futuro)
```

---

## 2. Migraciones de base de datos

### `20260703200000_bsale_integration_v1.sql`

Crea **schema `integraciones`** con 15 tablas espejo de Bsale + 4 tablas nuevas en `adquisiciones`.

#### Schema `integraciones` (15 tablas)

| Tabla | Propósito | UNIQUE |
|---|---|---|
| `bsale_sync_runs` | Control de corridas de sincronización | — |
| `bsale_document_types` | Tipos de documento Bsale | `(company_id, bsale_id)` |
| `bsale_payment_types` | Formas de pago | `(company_id, bsale_id)` |
| `bsale_offices` | Sucursales/oficinas | `(company_id, bsale_id)` |
| `bsale_clients` | Clientes | `(company_id, bsale_id)` |
| `bsale_products` | Catálogo de productos | `(company_id, bsale_id)` |
| `bsale_variants` | Variantes con SKU (`code`) | `(company_id, bsale_id)` |
| `bsale_stock_current` | Stock disponible por variante | `(company_id, bsale_id)` |
| `bsale_variant_costs` | Costo promedio por variante | `(company_id, variant_id)` |
| `bsale_documents` | Documentos de venta (facturas, boletas, etc.) | `(company_id, bsale_id)` |
| `bsale_document_details` | Líneas de detalle de cada documento | `(company_id, bsale_id)` |
| `bsale_payments` | Pagos asociados a documentos | `(company_id, bsale_id)` |
| `bsale_document_references` | Referencias entre documentos (NC→factura, etc.) | `(company_id, bsale_id)` |
| `bsale_receptions` | Recepciones de stock en Bsale | `(company_id, bsale_id)` |
| `bsale_reception_details` | Detalle de recepciones | `(company_id, bsale_id)` |

#### Schema `adquisiciones` (4 tablas nuevas)

| Tabla | Propósito | UNIQUE |
|---|---|---|
| `product_supplier_mappings` | Puente SKU Bsale → producto local → proveedor | `(company_id, supplier_id, sku)` |
| `purchase_replenishment_analyses` | Análisis de reposición guardados | — |
| `purchase_replenishment_analysis_items` | Items de cada análisis | `(analysis_id, sku)` |
| `purchase_replenishment_analysis_orders` | OC generadas desde un análisis | `(purchase_order_id)`, `(analysis_id, supplier_id)` |

#### Columnas clave en `product_supplier_mappings`

```sql
product_id   uuid → products (nullable)
supplier_id  uuid → suppliers (NOT NULL)
sku          text NOT NULL
unit_cost    numeric(14,2)
is_preferred boolean
UNIQUE(company_id, supplier_id, sku)
-- Un solo preferred activo por SKU
CREATE UNIQUE INDEX uq_psm_preferred_sku ON ... WHERE is_preferred = true AND is_active = true;
```

### `supabase/config.toml`

Se agregó `integraciones` a los schemas expuestos:
```toml
schemas = ["public", "graphql_public", "portal", "adquisiciones", "core", "logistica", "integraciones"]
```

---

## 3. Sincronización Bsale

### Archivos

| Archivo | Propósito |
|---|---|
| `src/lib/bsale/client.ts` | Cliente HTTP con paginación, `normalizeSku()`, `BsaleApiError` |
| `src/lib/bsale/config.ts` | Constante `SALE_DOCUMENT_TYPE_IDS = [1, 5, 23]` |
| `src/app/actions/integraciones/bsale-sync.ts` | Server Actions de sincronización |

### Funciones exportadas

| Función | Parámetros | Lo que sincroniza |
|---|---|---|
| `syncBsaleCatalog(companyId)` | companyId | products + variants + stocks |
| `syncBsaleCosts(companyId)` | companyId | costs (concurrencia 5, retry 3) |
| `syncBsaleSales(companyId, {days?})` | companyId, days=180 | documents + details |

### Endpoints Bsale utilizados

| Endpoint | Paginación | Registros |
|---|---|---|
| `GET /v1/products.json` | limit=50, offset | 2.344 |
| `GET /v1/variants.json` | limit=50, offset | 3.585 |
| `GET /v1/stocks.json` | limit=50, offset | 1.360 |
| `GET /v1/variants/{id}/costs.json` | Individual por ID | 3.585 llamadas |
| `GET /v1/documents.json?emissiondaterange=[start,end]` | limit=50, offset | 5.549 en 180d |
| `GET /v1/documents/{id}/details.json` | Individual por doc | 33.811 detalles |

### Estrategia de sincronización

| Tipo | Frecuencia | Rango | Estado |
|---|---|---|---|
| Carga inicial | Una vez | 180 días | ✅ Manual |
| Sync incremental | Cada 30 min | 7 días | 🔄 API route pendiente |
| Sync nocturna | 03:00 AM | 30 días | 🔄 API route pendiente |
| Manual | A demanda | Configurable | ✅ Botón en UI |

### Seguridad

- `BSALE_ACCESS_TOKEN` solo en `src/lib/bsale/client.ts` (server-side)
- RLS en `integraciones.*` bloquea acceso ANON
- `service_role` puede insertar/actualizar
- Server Actions validan autenticación

### Estados del sync run

```typescript
type SyncRunStatus = 'STARTED' | 'COMPLETED' | 'PARTIAL' | 'FAILED'
```

---

## 4. Adaptador de datos Bsale

### Archivo

`src/app/actions/integraciones/bsale-dataset.ts`

### Función principal

```typescript
getReplenishmentDatasetFromBsale(
  companyId: string,
  options?: { periodDays?: number; documentTypeIds?: number[] }
) → { success, data: ReplenishmentDataset, error }
```

### Datos de entrada (desde integraciones)

| Tabla | Consulta |
|---|---|
| `bsale_products` | Todos |
| `bsale_variants` | Todos |
| `bsale_documents` | Filtrados por `document_type_id IN [1,5,23]` |
| `bsale_document_details` | Filtrando solo docs de venta |
| `bsale_stock_current` | Todos, sumados por SKU |
| `bsale_variant_costs` | Todos |
| `product_supplier_mappings` | Activos |

### Estructura de salida

```typescript
interface ReplenishmentDataset {
  sales: NormalizedSale[]   // ← mismo tipo que espera analytics.ts
  stock: NormalizedStock[]  // ← mismo tipo que espera analytics.ts
  productsCount: number
  variantsCount: number
  docsCount: number
  detailsCount: number
  dateFrom: string
  dateTo: string
  diagnostics: Record<string, any>
}
```

---

## 5. Análisis de reposición (UI)

### Archivo

`src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx`

### Ubicación

Adquisiciones → Órdenes de Compra → [Realizar Análisis] (botón junto a "Crear OC")

### Funcionalidad

| Componente | Estado |
|---|---|
| Selector período (7-182 días, múltiplos de 7) | ✅ |
| Selector cobertura (1-8 semanas) | ✅ |
| Checkbox "Incluir todo" | ✅ |
| Filtro por SKU/producto | ✅ |
| Filtro por estado (crítico/reponer/sin costo) | ✅ |
| 5 KPIs superiores | ✅ |
| Tabla con SKU, producto, stock, buckets 7d, total, promedio, sugerido | ✅ |
| **Cantidad confirmada editable** | ✅ |
| **Monto confirmado recalcula automáticamente** | ✅ |
| Indicador "Sin costo" en rojo | ✅ |
| Badge de alerta con colores | ✅ |
| Botón "Generar OC" deshabilitado | ✅ (tooltip: próximamente) |
| Subtítulo con fecha de últimos datos | ✅ |

### Fórmula del sugerido

```
avg_per_7days = total_units_in_period / num_buckets
stock_objetivo = avg_per_7days * coverage_weeks
compra_sugerida = Math.max(0, Math.ceil(stock_objetivo - stock_actual))
confirmed_cost = confirmed_qty * costo_unitario
```

### Buckets de 7 días

Los bloques son exactos de 7 días, sin traslape, usando límites `[bStart, bEnd)`:
```
Bloque 1: [hoy-28d, hoy-21d)
Bloque 2: [hoy-21d, hoy-14d)
Bloque 3: [hoy-14d, hoy-7d)
Bloque 4: [hoy-7d, hoy)
```

---

## 6. Vinculación producto-proveedor

### Estado actual

| Tabla | Registros |
|---|---|
| `adquisiciones.products` (activos) | 708 |
| `adquisiciones.suppliers` (activos) | **83** (77 únicos después de aliases) |
| `adquisiciones.suppliers` (inactivos) | **5** (basura técnica ignorada) |
| `adquisiciones.product_supplier_mappings` | **0** (vacío) |
| Productos locales con SKU que coinciden con Bsale | 120 |

### Nota sobre proveedores

Los 83 proveedores activos se crearon con `company_id = null` (globales), `rut = null`, `status = 'ACTIVE'`.  
Esto es consistente con cómo la UI actual (`suppliers-panel.tsx`) crea proveedores: también usa `company_id: null` para proveedores globales del catálogo maestro.

Para usarlos en OC reales, se necesita completar RUT y datos de contacto desde la UI de proveedores.

### Normalización de nombres (aliases)

Los nombres se extraen desde `product_type.name` de Bsale con esta regla:
1. Si contiene `/` → proveedor = texto antes del primer `/`
2. Si coincide con un alias (tabla `SUPPLIER_ALIASES`) → se usa el alias
3. Si no hay `/` ni alias → se conserva completo (marcado como dudoso)

Archivo de aliases: `src/lib/bsale/supplier-aliases.ts`

| Alias | Resuelve a | Motivo |
|---|---|---|
| `HAGEN-HIGIENE` → `HAGEN` | HAGEN | Mismo proveedor con guión |
| `HAGEN-SNACK` → `HAGEN` | HAGEN | Mismo proveedor con guión |
| `DOGGO-SNACK` → `DOGGO` | DOGGO | Mismo proveedor con guión |
| `NB-ALIMENTO` → `NB` | NB | Categoría pegada |
| `LUDIPECK` → `LUDIPEK` | LUDIPEK | Error ortográfico |
| `SOUTHPOINTALIMENTO` → `SOUTHPOINT` | SOUTHPOINT | Categoría pegada |
| `SOUHTPOINT` → `SOUTHPOINT` | SOUTHPOINT | Error ortográfico |
| `PROMERCO-SNACK` → `PROMERCO` | PROMERCO | Categoría con guión |
| `TIPO DE PRODUCTO...` → `__IGNORE__` | — | Basura técnica |
| `CARGA MASIVA...` → `__IGNORE__` | — | Basura técnica |
| `DEMO BSALE` → `__IGNORE__` | — | Basura técnica |
| `SIN TIPO` → `__IGNORE__` | — | Basura técnica |
| `INSTRUCCIONES:...` → `__IGNORE__` | — | Basura técnica |

### Top 10 proveedores por cantidad de productos Bsale asociados

| Proveedor | Productos Bsale |
|---|---|
| SERVIPET | 20 |
| HAGEN | 17 |
| ACWS | 15 |
| MARBEN | 15 |
| DANDI | 13 |
| AMIGO | 11 |
| GLAM | 10 |
| GRMOR | 10 |
| DOGSHOP | 9 |
| CAYMA | 7 |

### Para generar OC se necesita

| Campo | Origen |
|---|---|
| `supplier_id` | `product_supplier_mappings.supplier_id` → `adquisiciones.suppliers.id` |
| `product_id` | `product_supplier_mappings.product_id` → `adquisiciones.products.id` (nullable) |
| `sku` | `product_supplier_mappings.sku` |
| `unit_cost` | `product_supplier_mappings.unit_cost` |
| `quantity` | `confirmedQty` del análisis |

### Server Action pendiente

```typescript
saveProductSupplierMapping(mapping: {
  company_id: string
  product_id?: string | null
  supplier_id: string
  bsale_variant_id?: number
  sku: string
  product_name?: string
  unit_cost?: number
  is_preferred?: boolean
})
```

### UI de vinculación propuesta

Modal desde el análisis de reposición:
- Buscador de producto local
- Selector de proveedor
- Costo editable (default desde Bsale)
- Checkbox "Preferido"
- Botón "Crear producto + proveedor" para SKU sin match

---

## 7. Futuro: Generar OC

Cuando existan mappings suficientes, en el análisis:

1. Filtrar items por `supplier_id`
2. Validar que todos tengan `product_id` y `unit_cost > 0`
3. Llamar RPC `create_purchase_order(p_data, p_user_id)` con:
   - `supplier_id` del filtro activo
   - `items[]` desde los items confirmados
4. Insertar en `purchase_replenishment_analysis_orders`
5. Marcar items como `ordered`

---

## 8. Archivos creados/modificados

### Nuevos

| Archivo | Líneas | Propósito |
|---|---|---|
| `src/lib/bsale/client.ts` | ~100 | Cliente Bsale con paginación |
| `src/lib/bsale/config.ts` | ~15 | Constantes de tipos de documento |
| `src/app/actions/integraciones/bsale-sync.ts` | ~630 | Server Actions de sync (catalog, costs, sales) |
| `src/app/actions/integraciones/bsale-dataset.ts` | ~270 | Adaptador Bsale → ReplenishmentDataset |
| `src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx` | ~410 | UI de Reposición Inteligente |
| `supabase/migrations/20260703200000_bsale_integration_v1.sql` | 677 | Migración completa (integraciones + análisis) |

### Modificados

| Archivo | Cambio |
|---|---|
| `supabase/config.toml` | Agregado `integraciones` a schemas expuestos |
| `src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx` | +5 líneas (botón "Realizar Análisis" + view 'analysis') |

---

## 9. Comandos útiles

```bash
# Build y TypeScript
npm run build
npx tsc --noEmit

# Migraciones
npx supabase migration list
npx supabase db push

# Sincronización (local via script)
node -e "require('dotenv').config({path:'.env.local'}); /* llamar a syncBsaleCatalog etc */"

# Logs de Railway
railway logs --deployment
```

---

## 10. Pendientes

| Fase | Tarea | Prioridad |
|---|---|---|
| **4A** | ~~Crear proveedores~~ ✅ 82 activos | 🔴 Hecho |
| **4B** | Server Action `saveProductSupplierMapping` | 🔴 Alta |
| **4B** | Modal de vinculación en UI de análisis | 🔴 Alta |
| **4B** | Completar RUT/datos de contacto de proveedores | 🟡 Media |
| **4C** | ~~Vincular SKU / producto / proveedor (mappings)~~ | ✅ Hecho |
| **4C** | Habilitar "Generar OC" para SKU vinculados | 🟡 Media |
| **5** | API route `/api/cron/bsale-sync` | 🟡 Media |
| **5** | Sincronización incremental cada 30 min | 🟢 Baja |
| **5** | Sincronización nocturna (30 días) | 🟢 Baja |
| — | Migrar middleware a proxy (Next.js 16) | 🟢 Baja |
