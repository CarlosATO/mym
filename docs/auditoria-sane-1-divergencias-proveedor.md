# SANE-1: Auditoría de divergencias de proveedor

**Alcance:** lectura del repositorio, consultas `SELECT` y consultas GET read-only a Bsale.

**Empresa:** `d1000000-0000-0000-0000-000000000001`.

**Fecha de observación:** 2026-08-20.

## 1. Método y precisión del universo

El universo se reconstruyó como los productos que participan en líneas de comisiones persistidas o en reglas activas, tienen `products.bsale_brand_id` con un link aprobado, y cuya resolución de mapping/parent no coincide con el supplier del Brand link.

La resolución mapping usada para esta auditoría es:

`product_supplier_mappings.is_active = true AND is_preferred = true -> supplier -> parent_supplier_id si existe`.

Resultado: **32 productos**.

Importante:

- Sólo **6/32** tienen un mapping preferred activo que apunta a un supplier distinto del Brand link.
- **26/32** no tienen mapping preferred vigente. En esos casos la resolución mapping es `NULL`, no otro proveedor competidor.
- Por eso se mantienen en SANE-1, pero no deben tratarse como 26 conflictos entre dos proveedores. Son casos de Brand con mapping ausente o no preferred.

Para cada variante se consultó la fuente técnica existente en el proyecto:

`GET /variants/{bsale_variant_id}.json?expand=product,product_type`

La respuesta Bsale estuvo disponible para las 32 variantes y confirmó el mismo `brand.id` almacenado en `products.bsale_brand_id`. La API no se usó para escribir y no se dependió de `brand.name`; el nombre proviene del supplier link interno.

## 2. Clasificación

| Categoría | Cantidad | Criterio aplicado |
|---|---:|---|
| A — BRAND PARECE CORRECTO | 32 | Brand API coincide con snapshot, el product type es coherente y la cohorte del Brand converge al supplier vinculado. En los 6 conflictos, el mapping es un pseudoproveedor histórico sin parent REAL. |
| B — MAPPING/PARENT PARECE CORRECTO | 0 | No hay evidencia de que el supplier mapping represente mejor al proveedor comercial actual. |
| C — BRAND LINK PARECE INCORRECTO | 0 | No se encontró Brand correcto vinculado al REAL equivocado. |
| D — AMBIGUO | 0 | No queda un caso sin evidencia suficiente dentro del universo auditado. |

La categoría A es una clasificación de priorización, no una autorización de corrección automática. Requiere validación de negocio antes de modificar mappings o links.

## 3. Tabla completa

Abreviaturas en la columna mapping: `A/P` = activo/preferred, `A/N` = activo/no preferred, `I/P` = inactivo/preferred. `SIN PREFERRED` significa que no existe mapping activo/preferred; puede haber mappings históricos o activos no preferred.

| # | Producto interno | SKU / descripción | Estado | Bsale product/variant | Product type | Mapping actual | Pseudoproveedor / parent REAL | Brand / supplier link | API Bsale | Clasificación |
|---:|---|---|:---:|---|---|---|---|---|---|:---:|
| 1 | `31d74778-88c7-473c-b7b2-ec49e2f9b1ab` | `S08040200` / BANDEJA GATO BETTA SMALL CON MARCO 43X31X12 | Inactivo | `1848/2601` | ACWS/HIGIENE | SIN PREFERRED; `44ce10f7` I/P, `17a4b7c0` A/N | Sin resolución | Brand 30 -> ANIMAL CARE - ACWS S.A. / RUT 76936850-7 | 30 / ACWS/HIGIENE | A |
| 2 | `b812232c-793a-4354-9019-2a292fdfd720` | `LVL254` / COLLAR ISABELINO GLAM 10CM | Activo | `2760/4403` | MARBEN/HIGIENE | `5a13ba7b` A/P; `f65ef47a` A/N | GLAM/HIGIENE; sin parent | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 3 | `805eefb8-366b-4d03-a8af-6e8c3c0fa9f5` | `LVL256` / COLLAR ISABELINO GLAM 15CM | Activo | `2760/4405` | MARBEN/HIGIENE | `c88faccb` A/P; `b5a8e8f4` A/N | GLAM/HIGIENE; sin parent | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 4 | `7c587967-f46d-4659-87b4-ea48470bbb0d` | `LVL259` / COLLAR ISABELINO GLAM 30CM | Activo | `2760/4408` | MARBEN/HIGIENE | `29caf784` A/P; `4a758537` A/N | GLAM/HIGIENE; sin parent | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 5 | `fd6b02bb-a793-44bf-9a34-57b54dd3bbbc` | `71093` / HAPPYPETS CEPILLO RENOVADOR PELAJE GATO T.S | Activo | `3941/6709` | MARBEN/HIGIENE | `5ea73085` A/P | GLAM/HIGIENE; sin parent | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 6 | `acdefa82-d409-4a95-a1c0-22dbdcb84ad7` | `518475` / BEWIDOG LATA RICO EN CORAZON DE AVE 400GR | Activo | `3817/6416` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `0c1bc3d4` A/N, `b2bbb214` I/P | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 7 | `e5770530-e2ef-497c-9197-6f9c9083cbd0` | `518425` / BEWIDOG LATA RICO EN POLLO 400GR | Activo | `3836/6641` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `78a4cc44` I/P, `c0e02404` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 8 | `90e3ebec-37c2-4d32-8ab0-83a39c23f3ae` | `518455` / BEWIDOG LATA RICO EN CORDERO 400GR | Activo | `3834/6640` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `aaf76401` A/N, `5cb81c47` I/P | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 9 | `16f622ae-678e-44cd-bd5a-69da0a58fb7a` | `518465` / BEWIDOG LATA RICO EN RES 400GR | Activo | `3835/6642` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `a25f91df` I/P, `dfd2780b` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 10 | `e8181892-4282-4147-9223-4aa91d980f89` | `518445` / BEWIDOG LATA RICO EN TERNERA 400GR | Activo | `3833/6643` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `0813e2fa` I/P, `f077c187` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 11 | `8a0a31de-5725-44af-b824-8f46cf80bf8b` | `USA901` / IB CHURU CAT MEAL TOPPER TUNA 14GR | Activo | `4034/6686` | LUDIPEK/SNACK | SIN PREFERRED; `eae74ec4` A/N, `83805db9` I/P | Sin resolución | Brand 51 -> SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA / RUT 76661486-8 | 51 / LUDIPEK/SNACK | A |
| 12 | `18e93ede-fdc8-4a2b-a8cb-6fd8a5d549d6` | `LVL253` / COLLAR ISABELINO GLAM 7.5CM | Activo | `2760/4402` | MARBEN/HIGIENE | SIN PREFERRED; `63ab3b77` A/N, `bba8bf78` I/P | Sin resolución | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 13 | `5ee524e1-bdcf-4a14-8e01-fe3318843d1b` | `LVL255` / COLLAR ISABELINO GLAM 12.5CM | Activo | `2760/4404` | MARBEN/HIGIENE | SIN PREFERRED; `dd4df896` I/P, `ebfa345d` A/N | Sin resolución | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 14 | `2df08532-d74c-4941-9836-ea790d53964c` | `60923` / BEBEDERO MANUAL DE PASEO 500ML | Activo | `2480/3882` | MARBEN/BEBEDEROS | `ddf2a110` A/P | GLAM/BEBEDEROS; sin parent | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/BEBEDEROS | A |
| 15 | `57cfa992-5de8-4af3-9f3b-2f9e14a52e9b` | `USA861` / IB CHURU DASHI DELIGHTS CHICK/TUNA 70GR | Activo | `4270/6952` | LUDIPEK/SNACK | SIN PREFERRED; `d38fe596` I/P, `30c2be9e` A/N | Sin resolución | Brand 51 -> SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA / RUT 76661486-8 | 51 / LUDIPEK/SNACK | A |
| 16 | `9686c0e3-7667-433c-b669-1adeae77f0c3` | `518835` / BEWIDOG LATA RICO EN VENADO 800GR | Activo | `3832/6437` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `603f4cbb` I/P, `3d7ede71` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 17 | `00ac5de7-7561-405d-9e44-8edb11187020` | `PW14608` / PAWISE JUGUETE FUNNY CHEW RING COLORES | Activo | `4088/6750` | HAGEN/JUGUETES | SIN PREFERRED; `35d091cb` A/N, `1d983f86` I/P | Sin resolución | Brand 37 -> HAGEN CHILE S.P.A. / RUT 78708490-7 | 37 / HAGEN/JUGUETES | A |
| 18 | `41f15468-26e5-4702-ac83-148023e7c893` | `74982830119237` / COLLAR ISABELINO GLAM 35CM | Activo | `2760/6467` | MARBEN/HIGIENE | SIN PREFERRED; `8f81fa8d` I/P, `d42374bc` A/N | Sin resolución | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 19 | `0a23a917-ce19-4832-9b66-eccf7af75a8a` | `CS039` / HAPPYPETS CEPILLO RENOVADOR PELAJE PERRO TM | Activo | `3942/6710` | MARBEN/HIGIENE | `85cd515d` A/P | GLAM/HIGIENE; sin parent | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 20 | `ca602ce5-b279-446a-85d3-ff88147c1e17` | `USA903` / IB CHURU CAT MEAL TOPPER CHICKEN 14GR | Activo | `4033/6685` | LUDIPEK/SNACK | SIN PREFERRED; `0bf68c7c` I/P, `5a510bf2` A/N | Sin resolución | Brand 51 -> SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA / RUT 76661486-8 | 51 / LUDIPEK/SNACK | A |
| 21 | `398949ed-b082-4083-b410-ef3ac25f8c58` | `746216` / BEWICAT LATAS MEATININIS RICO EN AVE 400GR | Activo | `3816/6417` | BEWICAT/ ALIMENTO HUMEDO | SIN PREFERRED; `8d1fbde1` I/P, `90d5659d` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWICAT/ ALIMENTO HUMEDO | A |
| 22 | `2a32418f-6b1b-4816-8037-c4c4012f2b7d` | `LKD650` / IB CHURU DOG VARIETY CHICKEN 14GR 50 TUBES | Activo | `4051/6703` | LUDIPEK/SNACK | SIN PREFERRED; `d861a05f` I/P, `03fef582` A/N | Sin resolución | Brand 51 -> SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA / RUT 76661486-8 | 51 / LUDIPEK/SNACK | A |
| 23 | `6cd2cdaa-8def-4e38-89d1-1009143de2a7` | `LVL258` / COLLAR ISABELINO GLAM 25CM | Activo | `2760/4407` | MARBEN/HIGIENE | SIN PREFERRED; `92a7b948` I/P, `dcf36123` A/N | Sin resolución | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 24 | `e88096c6-6c5f-4c6e-a6af-f90ddd2ee73c` | `LVL257` / COLLAR ISABELINO GLAM 20CM | Activo | `2760/4406` | MARBEN/HIGIENE | SIN PREFERRED; `6fdf58a6` I/P, `aea1737c` A/N | Sin resolución | Brand 50 -> SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / RUT 76100687-8 | 50 / MARBEN/HIGIENE | A |
| 25 | `774e6696-e2fd-4a72-ac7b-76a76324096f` | `746236` / BEWICAT LATAS MEATINIS RICO EN SALMON 400GR | Activo | `3815/6415` | BEWICAT/ ALIMENTO HUMEDO | SIN PREFERRED; `551ab3c0` I/P, `fa2dbd93` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWICAT/ ALIMENTO HUMEDO | A |
| 26 | `06fc381e-aeb3-4a78-9d03-070440473c48` | `518845` / BEWIDOG LATA RICO EN TERNERA 800GR | Activo | `3833/6438` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `a492774a` I/P, `b9df7922` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 27 | `e332de2e-73b4-4d23-98b2-0bc9fd6ca1ee` | `746226` / BEWICAT LATAS MEATININIS RICO EN VENADO 400GR | Activo | `3837/6442` | BEWICAT/ ALIMENTO HUMEDO | SIN PREFERRED; `6412f7e4` I/P, `4170d89b` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWICAT/ ALIMENTO HUMEDO | A |
| 28 | `003a15ba-180b-4106-bf79-4dacdadbfa02` | `LA009` / CAMON TOALLITAS CLORHEXIDINA Y MIRRA 100 UNID | Activo | `4030/6682` | ACWS/HIGIENE | SIN PREFERRED; `edfa86c5` A/N, `545bb472` I/P | Sin resolución | Brand 30 -> ANIMAL CARE - ACWS S.A. / RUT 76936850-7 | 30 / ACWS/HIGIENE | A |
| 29 | `16b02651-e74b-463d-9bab-120af0928c17` | `518855` / BEWIDOG LATA RICO EN CORDERO 800GR | Activo | `3834/6439` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `b2664f84` I/P, `62b9511e` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 30 | `2c939555-1544-4407-8cdc-5ca13da2de7d` | `518865` / BEWIDOG LATA RICO EN RES 800GR | Activo | `3835/6440` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `8328d894` I/P, `8e11a14b` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 31 | `106cfd3e-a78d-4d2a-b38f-685428ec6c8b` | `518825` / BEWIDOG LATA RICO EN POLLO 800GR | Activo | `3836/6441` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `5c687724` I/P, `80c009f8` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |
| 32 | `31326063-f194-4120-a29a-e1988ad1fb65` | `518435` / BEWIDOG LATA RICO EN VENADO 400GR | Activo | `3832/6644` | BEWIDOG/ ALIMENTO HUMEDO | SIN PREFERRED; `aac082f8` I/P, `926b8d65` A/N | Sin resolución | Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / RUT 96642980-1 | 48 / BEWIDOG/ ALIMENTO HUMEDO | A |

## 4. Evidencia por Brand

| Brand | Link actual | Productos activos con preferred mapping | Supplier REAL dominante | Divergencias | Lectura |
|---:|---|---:|---|---:|---|
| 30 | ANIMAL CARE - ACWS S.A. / `76936850-7` | 150 | ANIMAL CARE - ACWS S.A. (150) | 2 | Ambos casos son ACWS/HIGIENE, API confirma Brand 30. El mapping no preferred o ausente no contradice al Brand. |
| 37 | HAGEN CHILE S.P.A. / `78708490-7` | 494 | HAGEN CHILE S.P.A. (494) | 1 | PW14608 es HAGEN/JUGUETES; la cohorte converge completamente al link. |
| 48 | SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. / `96642980-1` | 110 | SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A. (110) | 14 | 14 productos BEWIDOG/BEWICAT sin preferred mapping. Es ausencia de mapping, no evidencia contra Brand. |
| 50 | SOCIEDAD COMERCIAL MARBEN PETS LIMITADA / `76100687-8` | 70 | MARBEN (62), GLAM/HIGIENE (7), GLAM/BEBEDEROS (1) | 11 | Los 6 mappings conflictivos son pseudoproveedores GLAM sin parent, pero la API/product type dice MARBEN en los 6. Las 5 restantes no tienen preferred mapping. Brand parece la fuente comercial más consistente. |
| 51 | SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA / `76661486-8` | 184 | SOUTHERNKING (184) | 4 | Todos son LUDIPEK/SNACK sin preferred mapping; la cohorte converge completamente al link. |

## 5. Evidencia por supplier y pseudoproveedor

### Supplier del Brand link

- ANIMAL CARE - ACWS S.A.: 2 productos, Brand 30.
- HAGEN CHILE S.P.A.: 1 producto, Brand 37.
- SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A.: 14 productos, Brand 48.
- SOCIEDAD COMERCIAL MARBEN PETS LIMITADA: 11 productos, Brand 50.
- SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA: 4 productos, Brand 51.

### Mappings que sí generan conflicto efectivo

Los 6 casos con mapping `A/P` son:

- Brand 50 / `LVL254`, `LVL256`, `LVL259`, `71093`, `60923`, `CS039`.
- Supplier operativo: GLAM/HIGIENE en cinco casos y GLAM/BEBEDEROS en `60923`.
- `parent_supplier_id`: `NULL` en los seis.
- Supplier Brand: SOCIEDAD COMERCIAL MARBEN PETS LIMITADA.
- Product type Bsale: MARBEN/HIGIENE en cinco y MARBEN/BEBEDEROS en uno.
- Bsale API: Brand 50 y product type MARBEN en los seis.

Esto es evidencia fuerte de que el mapping GLAM es una clasificación histórica/operativa que no representa el Brand comercial actual, o que requiere revisión específica. No demuestra por sí sola que el supplier real de compra sea Marben, pero sí que el mapping no está alineado con el catálogo Bsale actual.

### Pseudoproveedores

No hay ningún `BSALE_OPERATIVE` con `parent_supplier_id` informado dentro de los seis conflictos efectivos. Los 26 casos restantes no tienen pseudoproveedor resoluble porque no hay mapping preferred; algunos conservan mapping no preferred o histórico, que no participa en la resolución actual.

## 6. Caso especial: SKU 518425

- Producto: `e5770530-e2ef-497c-9197-6f9c9083cbd0`.
- Descripción: `BEWIDOG LATA RICO EN POLLO 400GR`.
- Activo: sí.
- Bsale: product `3836`, variant `6641`.
- Product type: `BEWIDOG/ ALIMENTO HUMEDO`.
- Brand actual en snapshot y API: `48`.
- Brand link: Brand 48 -> SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A., RUT `96642980-1`.
- Mapping preferred actual: ninguno.
- Mappings existentes: `78a4cc44` inactivo/preferred y `c0e02404` activo/no preferred.
- Supplier mapping/parent actual para comisiones: `NULL` por no existir active/preferred.

Resoluciones actuales:

- Fuente Brand: supplier REAL SERVICIOS FINANCIEROS Y MERCADOTECNIA S.A.
- Fuente mapping: sin supplier resoluble actualmente.

Evidencia: Brand API coincide con el snapshot, el product type es BEWIDOG, y los 110 productos activos con preferred mapping del Brand 48 convergen al mismo supplier REAL. Clasificación: **A — BRAND PARECE CORRECTO**, con la salvedad de que el problema operativo inmediato es mapping ausente/no preferred, no un mapping que apunte a otro REAL.

## 7. Patrones detectados

1. El universo de 32 está concentrado en cinco Brands: 48 aporta 14, 50 aporta 11, 51 aporta 4, 30 aporta 2 y 37 aporta 1.
2. Brand 48 y Brand 51 tienen convergencia total de los productos con preferred mapping hacia su supplier vinculado.
3. Brand 30 y Brand 37 también muestran convergencia total en el perfil observado.
4. Brand 50 es el único Brand con conflicto efectivo de mapping: seis preferred mappings apuntan a GLAM sin parent, mientras Bsale identifica Brand 50 y product type MARBEN.
5. La mayoría de los 32 casos son ausencia de mapping preferred: 26/32.
6. Los 26 casos sin preferred suelen conservar un mapping activo no preferred o un mapping inactivo preferred; la prioridad actual no es ambigua desde SQL, pero el origen de esa pérdida de preferred sí debe revisarse.
7. Los nombres de product type siguen el patrón del Brand en los 32 casos: ACWS, HAGEN, BEWIDOG/BEWICAT, LUDIPEK o MARBEN.
8. La API técnica confirma el Brand ID actual en todos los casos consultados; no hay evidencia de que `products.bsale_brand_id` esté obsoleto para este conjunto.

## 8. Recomendación de revisión manual

### Primer grupo recomendado: Brand 50 / GLAM vs MARBEN

Revisar primero los seis productos con mapping preferred GLAM y los cinco productos Brand 50 sin preferred. Es el único grupo donde existe una contradicción efectiva entre dos resoluciones no nulas y donde el product type/API favorece claramente MARBEN.

Orden sugerido de revisión humana:

1. `LVL254`, `LVL256`, `LVL259`, `71093`, `60923`, `CS039`.
2. `LVL253`, `LVL255`, `74982830119237`, `LVL258`, `LVL257`.
3. Después revisar los 14 productos Brand 48, los 4 Brand 51, los 2 Brand 30 y el Brand 37, principalmente para decidir si deben recuperar mapping preferred.

No se recomienda modificar todavía ningún mapping, Brand link, producto o supplier. La evidencia permite priorizar la conversación, no ejecutar la corrección.

## 9. Límites y decisiones pendientes

- El Brand link demuestra una asociación aprobada manualmente en PetGroup, no necesariamente la relación contractual de compra.
- El product type Bsale es evidencia de origen histórico del pseudoproveedor, no prueba legal de supplier comercial.
- La ausencia de mapping preferred no permite concluir qué supplier debe restaurarse.
- Los casos Brand 50 requieren validar si GLAM fue supplier real, alias de Marben o una clasificación de tipo de producto.
- Debe decidirse si un mapping activo no preferred representa una relación válida que perdió preferencia o si debe considerarse histórico.
- Ninguna categoría fue aplicada automáticamente a datos y ninguna corrección fue ejecutada.

## 10. Resumen ejecutivo

1. Se reconstruyeron exactamente 32 casos del universo SANE-1.
2. Bsale API respondió para las 32 variantes.
3. El Brand ID API coincidió con `products.bsale_brand_id` en todos.
4. Sólo 6 casos tienen mapping preferred activo apuntando a otro supplier.
5. Los otros 26 no tienen mapping active/preferred; su resolución mapping actual es NULL.
6. Los 32 se clasifican provisionalmente como A: Brand parece correcto.
7. No hay casos B, C o D con la evidencia actual.
8. Brand 50 concentra 11 casos y los 6 conflictos efectivos.
9. En esos 6, el mapping es GLAM sin parent REAL.
10. Bsale identifica Brand 50 y product type MARBEN en los 6.
11. Brand 48 concentra 14 casos, todos BEWIDOG/BEWICAT sin preferred mapping.
12. Brand 48 converge a SERVICIOS FINANCIEROS Y MERCADOTECNIA en 1.540 productos con preferred mapping.
13. Brand 51 converge completamente a SOUTHERNKING en 184 productos.
14. Brand 30 y 37 también convergen completamente con sus links.
15. El primer grupo para revisión manual es Brand 50, sin modificar aún ningún registro.

**Acciones realizadas:** consultas read-only al repositorio, Supabase y API GET de Bsale. No se modificaron Bsale, productos, Brands, links, mappings, suppliers, reglas ni configuración. No hubo commit ni push.
