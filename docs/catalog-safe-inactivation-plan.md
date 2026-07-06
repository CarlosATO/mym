# Plan de Inactivación Segura de Catálogo (Bsale → PetGrup)

Este documento detalla la regla de negocio, los resultados del análisis y la muestra de productos afectados para llevar a cabo la inactivación segura en el sistema PetGrup, asegurando que no haya impacto negativo en la operación y manteniendo la sincronización parcial con Bsale.

## Regla de Negocio

**1. Candidato seguro a inactivar en PetGrup:**
- `bsale_product_state = 1` (Inactivo) o `bsale_variant_state = 1` (Inactivo).
- **Stock actual = 0**.
- **Ventas en los últimos 180 días = 0**.
- `bsale_status_conflict = false`.
> A estos productos se les aplicará `is_active = false` y `status = 'INACTIVE'`.

**2. Producto protegido (Conflicto):**
- Bsale marca el producto o variante como inactivo.
- PERO tiene **stock > 0** o **ventas > 0** en los últimos 180 días.
> A estos productos **NO** se les modificará el estado. Permanecen como `is_active = true` y retienen su estado original (ej. `ACTIVE`). Se etiquetarán internamente con un conflicto Bsale (`bsale_status_conflict = true`).

## Criterio de Evaluación (Query/Script)

La evaluación se realizó mediante el script `bootstrap_catalog_from_bsale.ts` bajo la siguiente lógica:
- **Stock:** Acumulado disponible desde `integraciones.bsale_stock_current` usando `variant_code` o `raw_json->variant->code`.
- **Ventas (180 días):** Obtenidas desde `integraciones.bsale_document_details` cruzando con `integraciones.bsale_documents` donde `emission_date >= (hoy - 180 días)`.

## Conteos (Resultados del Dry-Run)

| Métrica | Valor |
| :--- | :--- |
| **Total productos evaluados** | 3.585 |
| **Productos inactivos en Bsale** | 2.177 |
| **Candidatos seguros a inactivar** | **2.130** |
| - Productos con stock positivo (candidatos) | 0 |
| - Productos con ventas recientes (candidatos) | 0 |
| **Conflictos protegidos** | **47** |
| **Productos activos esperados después** | **1.455** |
| **Productos inactivos esperados después** | **2.130** |

> [!IMPORTANT]
> **Confirmación de Seguridad:** Durante la aplicación (`--apply-state`), **NO** se tocará ni modificará información en la plataforma de Bsale. El cambio aplicará estrictamente a los campos locales `is_active` y `status` de la tabla `adquisiciones.products`.

## Muestra de 100 Candidatos Seguros a Inactivar

A continuación, una muestra de los 2.130 productos que serán inactivados:

| SKU | Descripción | Stock | Ventas 180d |
|---|---|---|---|
| 74528 | PELUCHE PEZ REAL - PEQUEÑO | 0 | 0 |
| 11001069 | HILLS FELINE METABOLIC Y URINARY 2.88KG - 2.88KG | 0 | 0 |
| 66200 | PELUCHE DE GATO MOUNSTRUOS - SURTIDOS | 0 | 0 |
| 101237 | BRIT CARE HYPOALLERGENIC SALMON & HERRING DOG SHOW CHAMPION - 3KG | 0 | 0 |
| B-DOR44550-2KG | ORIJEN FIT AND TRIM DOG - 2KG | 0 | 0 |
| 101222 | BRIT CARE GRAIN-FREE SALMON PUPPY - 3KG | 0 | 0 |
| 101230 | BRIT CARE HYPOALLERGENIC LAMB ADULT LARGE - 12KG | 0 | 0 |
| 100408 | BRIT CARE HYPOALLERGENIC LAMB ADULT SMALL - 3KG | 0 | 0 |
| 101233 | BRIT CARE HYPOALLERGENIC LAMB ADULT MEDIUM - 12KG | 0 | 0 |
| 100461 | BRIT CAT SNACK HAIRBALL - 50GR | 0 | 0 |
| 100581 | BRIT LATA MONO PROTEIN RABBIT - 400GR | 0 | 0 |
| 100469 | BRIT CAT SNACK TRUFFLES CRANBERRY - 50GR | 0 | 0 |
| 100582 | BRIT LATA PATE Y MEAT SALMON - 400GR | 0 | 0 |
| 101219 | BRIT CARE GRAIN-FREE SALMON JUNIOR LARGE - 3KG | 0 | 0 |
| 101240 | BRIT CARE HYPOALLERGENIC LAMB JUNIOR LARGE BREED - 3KG | 0 | 0 |
| 101225 | BRIT CARE GRAIN-FREE SALMON SENIOR & LIGHT - 3KG | 0 | 0 |
| 101239 | BRIT CARE HYPOALLERGENIC LAMB JUNIOR LARGE BREED - 12KG | 0 | 0 |
| 101231 | BRIT CARE HYPOALLERGENIC LAMB ADULT LARGE - 3KG | 0 | 0 |
| 100522 | BRIT CARE MINI YORKSHIRE - 2KG | 0 | 0 |
| 101243 | BRIT CARE HYPOALLERGENIC LAMB  PUPPY - 3KG | 0 | 0 |
| *(... y otros 2,110 SKUs sin stock ni ventas recientes)*

## Resumen de los 47 Conflictos Protegidos

Estos productos **NO** serán inactivados. Se detectó actividad reciente o existencia de stock en PetGrup a pesar de que Bsale los considera inactivos. Se etiquetarán con el motivo del conflicto para resolución manual posterior.

*Ejemplos destacados:*
- `TY00001STD`: Protegido por motivo `STOCK_POSITIVO`
- `CO66821`: Protegido por motivo `VENTA_RECIENTE`
- `CO64334`: Protegido por motivo `VENTA_RECIENTE`

*(La lista completa de los 47 conflictos se encuentra generada en [catalog-bsale-status-exceptions.md](file:///c:/Users/mympr/OneDrive/Desktop/PetGrup/mym/docs/catalog-bsale-status-exceptions.md)).*
