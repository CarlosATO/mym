# COMV2-01A: Arquitectura y Modelo de Datos V2

**Estado:** diseño ajustado para aprobación. No implementado.

**Alcance:** definir Comisiones V2 dentro del schema dedicado `comisiones`,
completamente separado de `comercial.commission_*`. No se crean migraciones ni
se modifica el sistema legado en esta fase.

## 1. Decisiones base V1

- La identidad de producto es `bsale_variant_id`. SKU es dato descriptivo o
  histórico, nunca clave de resolución.
- Familia es `bsale_product_type_id`; `bsale_product_type_name` se conserva como
  snapshot.
- Proveedor se resuelve así: producto -> `bsale_brand_id` -> Brand Supplier
  Link -> Supplier `REAL`.
- No hay fallback a `product_supplier_mappings`, pseudoproveedores ni SKU.
- Sólo facturas completamente pagadas por el cliente son elegibles.
- El cálculo es por línea y usa el neto Bsale de la línea.
- Una liquidación pertenece a un solo vendedor.
- No existe `GENERAL` como regla operativa V1.
- No existen reglas por SKU/variant como mecanismo normal. Las excepciones
  explícitas se modelan aparte y requieren justificación.
- Un porcentaje `0%` es un valor configurado explícitamente, no ausencia de
  regla ni fallback.
- `ISSUED` es inmutable. Toda corrección posterior usa un settlement
  `ADJUSTMENT`.
- Servicios o líneas sin `variant_id` quedan visibles en preview y excluidos de
  cálculo V1 con incidencia de catálogo.
- El sistema legado sigue operativo y no se migran inicialmente sus reglas ni
  liquidaciones.

## 2. Modelo lógico simplificado

```text
integraciones.bsale_documents -----------------------+
integraciones.bsale_document_details ----------------+--> v2_sales_lines
integraciones.bsale_document_sellers ----------------+       |
comercial.vw_customer_invoice_receivables -----------+       |
integraciones.bsale_document_references --------------+       | pago completo
                                                              v
adquisiciones.products -- bsale_variant_id --> producto + Brand
                                               |
                                               +--> Brand Supplier Link
                                                        |
                                                        v
                                                   Supplier REAL
                                                        |
                                               bsale_product_type_id
                                                        |
                                                        v
comisiones.seller_profiles --------------------------+
comisiones.commission_plans -------------------------+--> resolución de plan
comisiones.commission_plan_family_rates -------------+    y cálculo V2
comisiones.commission_plan_tiers --------------------+
comisiones.commission_plan_exceptions ---------------+
                                                        |
                                                        v
                                               comisiones.settlements
                                                        |
                                                        v
                                               settlement_lines
                                                        |
                            +---------------------------+------------------+
                            v                                              v
                      line_locks                              credit_note_adjustments
                            |                                              |
                            +--------------------------+-------------------+
                                                       v
                                                 audit_events
```

El motor debe tener una única resolución compartida por preview, creación de
borrador, emisión, auditoría y exportaciones. TypeScript no puede cambiar
después el proveedor o la regla resuelta por SQL.

## 3. Fuentes Bsale y tipos confirmados

El contrato vigente revisado en las migraciones define:

### `integraciones.bsale_documents`

- `id uuid PK`: identidad interna de la fila.
- `company_id uuid`.
- `bsale_id int`: ID estable del documento Bsale, único por empresa.
- `number int`, `document_type_id int`, `emission_date date`.

### `integraciones.bsale_document_details`

- `id uuid PK`: identidad interna de la línea. Este es el tipo correcto para
  `source_document_line_id` en V2.
- `company_id uuid`.
- `bsale_id int`: ID Bsale del detalle, único por empresa.
- `bsale_document_id int`: ID Bsale del documento padre.
- `line_number int`, `quantity numeric(14,3)`, `net_amount numeric(14,2)`.
- `variant_id int NULL`, `variant_code text`, `variant_description text`.

Por tanto, V2 no debe declarar `source_document_line_id` como `uuid` por
analogía con el sistema antiguo sin documentar su origen. En el contrato real
confirmado es `integraciones.bsale_document_details.id uuid`. También se deben
guardar los IDs Bsale numéricos del documento, detalle y variante para
auditoría e integración.

### `integraciones.bsale_document_sellers`

- `id uuid PK` interno.
- `bsale_document_id bigint` y `seller_bsale_id bigint`.
- `document_type_id integer`, `document_number bigint`, `seller_name text`.
- `is_primary boolean`.

La liquidación selecciona el vendedor primario. Si hay más de uno primario o no
hay uno inequívoco, la línea es visible como incidencia y no se liquida.

### `integraciones.bsale_document_references`

El contrato de referencias vigente es por documento, no por línea:

- `id uuid PK` interno.
- `bsale_id bigint`, `bsale_document_id bigint`.
- `referenced_document_id bigint`.
- `referenced_document_number text`.
- `referenced_document_type_id bigint`.
- `reference_code text`, `reference_reason text`, `reference_date date`.

La tabla no entrega una `credit_note_line_id` relacionada directamente con una
línea de factura. Para NC, V2 debe enlazar la NC al documento original mediante
estos IDs Bsale y resolver el detalle por `variant_id`/detalle Bsale. Si queda
más de una coincidencia posible, la NC queda `PENDING`; no se adivina usando
SKU.

## 4. Tablas finales propuestas

No se incluyen tablas de bonos en el schema inicial. No se incluyen
`rule_policies`, `rule_scopes` ni prioridades genéricas.

### 4.1 `comisiones.settings`

Configuración transversal por empresa.

Columnas clave:

- `id uuid PK`.
- `company_id uuid NOT NULL FK core.companies(id)`.
- `currency_code char(3) NOT NULL DEFAULT 'CLP'`.
- `base_amount_type text NOT NULL DEFAULT 'NET'`.
- `requires_full_payment boolean NOT NULL DEFAULT true`.
- `first_eligible_full_payment_date date NOT NULL`: fecha de cutover V2.
- `active boolean NOT NULL`.
- timestamps y usuarios de mantenimiento.

Unique: `(company_id)`. La fecha de cutover es explícita y no se deduce de la
última liquidación del sistema antiguo.

### 4.2 `comisiones.seller_profiles`

Perfil operacional del vendedor en V2.

Columnas clave:

- `id uuid PK`.
- `company_id uuid NOT NULL FK`.
- `seller_bsale_id bigint NOT NULL`.
- `seller_name text NOT NULL`.
- `is_commissionable boolean NOT NULL DEFAULT false`.
- `seller_type text`, `active boolean`, `notes text`.
- timestamps y usuarios.

Unique: `(company_id, seller_bsale_id)`. El nombre del vendedor se vuelve
snapshot en cada línea emitida.

### 4.3 `comisiones.commission_plans`

Plan base versionado de un proveedor REAL. Es la unidad principal de reglas.

Columnas clave:

- `id uuid PK`.
- `company_id uuid NOT NULL FK`.
- `supplier_id uuid NOT NULL FK adquisiciones.suppliers(id)`.
- `plan_code text NOT NULL`.
- `version_no integer NOT NULL`.
- `plan_type text NOT NULL`: `FAMILY_FIXED_PERCENT` o
  `SUPPLIER_SALES_TARGET`.
- `valid_from date NOT NULL`, `valid_to date NULL`.
- `status text NOT NULL`: `DRAFT`, `ACTIVE`, `RETIRED`, `CANCELLED`.
- `active boolean NOT NULL`.
- `supersedes_plan_id uuid NULL FK commission_plans(id)`.
- `reason text`, timestamps y usuarios.

Restricciones de negocio:

- El proveedor debe ser `REAL` y activo al publicar.
- Un Supplier REAL tiene como máximo un plan base V2 activo para una fecha.
- No puede existir solapamiento de vigencias entre planes activos del mismo
  `(company_id, supplier_id)`, independientemente de `plan_type`.
- `valid_to` es opcional para un plan abierto.
- Un plan publicado no se edita destructivamente; se crea una versión nueva.

Unique: `(company_id, plan_code, version_no)`. La ausencia de un índice de
exclusión para rangos no elimina la validación transaccional de publicación.

### 4.4 `comisiones.commission_plan_family_rates`

Familias y porcentajes individuales de un plan `FAMILY_FIXED_PERCENT`.

Columnas clave:

- `id uuid PK`.
- `company_id uuid NOT NULL FK`.
- `plan_id uuid NOT NULL FK commission_plans(id) ON DELETE RESTRICT`.
- `family_bsale_product_type_id integer NOT NULL`.
- `family_name_snapshot text NOT NULL`.
- `percentage numeric(7,4) NOT NULL` con rango `0..100`.

Unique: `(company_id, plan_id, family_bsale_product_type_id)`. Un porcentaje
`0.0000` es válido y significa explícitamente que esa Familia no genera monto,
pero sí queda clasificada por el plan.

Una línea de una Familia ausente en esta tabla produce `FAMILY_UNRESOLVED`; no
usa un porcentaje general.

### 4.5 `comisiones.commission_plan_tiers`

Tramos monetarios de un plan `SUPPLIER_SALES_TARGET`.

Columnas clave:

- `id uuid PK`.
- `company_id uuid NOT NULL FK`.
- `plan_id uuid NOT NULL FK commission_plans(id) ON DELETE RESTRICT`.
- `tier_order smallint NOT NULL`.
- `lower_bound numeric(18,2) NOT NULL`.
- `upper_bound numeric(18,2) NULL`.
- `percentage numeric(7,4) NOT NULL` con rango `0..100`.

Unique: `(company_id, plan_id, tier_order)`. Los tramos deben cubrir sin huecos
el dominio desde cero, sin solaparse. Se recomienda representar los límites
como `0 <= total <= superior`, luego `superior < total <= superior`, y último
`superior < total`.

### 4.6 `comisiones.commission_plan_exceptions`

Excepciones explícitas y poco frecuentes. No es un sustituto de reglas SKU.

Columnas clave:

- `id uuid PK`.
- `company_id uuid NOT NULL FK`.
- `plan_id uuid NOT NULL FK commission_plans(id) ON DELETE RESTRICT`.
- `bsale_variant_id bigint NOT NULL`.
- `family_bsale_product_type_id integer NULL`.
- `percentage numeric(7,4) NOT NULL`.
- `justification text NOT NULL`.
- `active boolean NOT NULL`.

Unique: `(company_id, plan_id, bsale_variant_id)`. Sólo se puede crear con
permiso de configuración y justificación. La excepción hereda el proveedor y
vigencia del plan. No se aceptan comodines por SKU.

### 4.7 `comisiones.settlement_sequences`

Correlativo por empresa para no depender de un código generado en frontend.

- `company_id uuid PK FK core.companies(id)`.
- `last_settlement_number bigint NOT NULL`.
- timestamps.

### 4.8 `comisiones.settlements`

Cabecera de una liquidación normal o ajuste.

Columnas clave:

- `id uuid PK`, `company_id uuid NOT NULL FK`.
- `settlement_number bigint NULL`, `settlement_code text NOT NULL`.
- `seller_profile_id uuid NULL FK`, `seller_bsale_id bigint NOT NULL`.
- `seller_name_snapshot text NOT NULL`.
- `period_from date NOT NULL`, `period_to date NOT NULL`.
- `payment_cutoff_date date NOT NULL`.
- `status text NOT NULL`: `DRAFT`, `ISSUED`, `CANCELLED`.
- `settlement_kind text NOT NULL`: `NORMAL` o `ADJUSTMENT`.
- `adjusts_settlement_id uuid NULL FK settlements(id)`.
- totales netos y de comisión en CLP.
- `issued_at/by`, `cancelled_at/by`, `cancellation_reason`.
- timestamps, usuarios y `metadata jsonb`.

Una liquidación tiene un solo vendedor. Un settlement de ajuste también tiene
un solo vendedor y debe apuntar a la liquidación emitida que corrige.

Unique recomendado: `(company_id, settlement_code)` y correlativo por empresa.
Unique parcial para un único DRAFT normal del mismo vendedor y período.

### 4.9 `comisiones.settlement_lines`

Resultado por línea y snapshot histórico.

Columnas clave:

- `id uuid PK`, `company_id uuid`, `settlement_id uuid`.
- Documento: `source_document_bsale_id bigint`,
  `source_document_number bigint`, `source_document_type_id integer`.
- Detalle: `source_document_line_id uuid NULL`,
  `source_document_detail_bsale_id bigint NULL`.
- Original: `original_invoice_bsale_id bigint NULL`,
  `original_invoice_line_id uuid NULL`,
  `original_invoice_detail_bsale_id bigint NULL`.
- Producto: `bsale_variant_id bigint NULL`, `product_id uuid NULL`,
  `sku_snapshot text`, `description_snapshot text`, `quantity numeric(18,3)`,
  `net_amount numeric(18,2)`.
- Clasificación: `bsale_brand_id integer`, `brand_name_snapshot text`,
  `real_supplier_id uuid`, `real_supplier_name_snapshot text`,
  `family_bsale_product_type_id integer`, `family_name_snapshot text`.
- Vendedor y cliente: IDs Bsale, IDs internos si existen y nombres snapshot.
- Regla: `plan_id`, `plan_version_no`, `plan_type`, `family_rate_id` o
  `tier_id`, límites y porcentaje snapshot.
- Cálculo: `base_amount`, `percentage`, `commission_amount`, `currency_code`.
- Fechas Bsale: emisión, pago completo, NC, cálculo y emisión.
- `line_kind`: `INVOICE`, `CREDIT_NOTE`, `HISTORICAL_MARK`.
- `metadata jsonb`: motor, total proveedor usado para tramo, warnings y payload
  Bsale relevante.

`bsale_variant_id` es nullable sólo para permitir que servicios/líneas sin
variant sean visibles en una línea excluida o incidencia; no pueden entrar a un
DRAFT V1. Una línea ISSUED debe tener el snapshot mínimo exigido o no puede
emitirse.

### 4.10 `comisiones.line_locks`

Reserva temporal y bloqueo definitivo de una línea Bsale.

Columnas clave:

- `id uuid PK`, `company_id uuid`.
- `settlement_id uuid`, `settlement_line_id uuid`.
- `source_document_line_id uuid NOT NULL`: corresponde a
  `bsale_document_details.id`, tanto para factura como para NC.
- `source_document_detail_bsale_id bigint NOT NULL`.
- `line_kind text`: `INVOICE` o `CREDIT_NOTE`.
- `lock_kind text`: `RESERVATION` o `DEFINITIVE`.
- `status text`: `ACTIVE`, `RELEASED`, `CONSUMED`.
- `reserved_at`, `released_at`, `consumed_at`, usuarios y motivo.

Unique parcial: una sola reserva o bloqueo `ACTIVE` por
`(company_id, source_document_line_id)`. Al crear DRAFT se inserta
`RESERVATION`; al cancelar se libera; al emitir se convierte en definitivo en
la misma transacción.

El bloqueo de una NC es sobre su propio detalle Bsale. La relación con la
factura original vive en `settlement_lines` y `credit_note_adjustments`.

### 4.11 `comisiones.credit_note_adjustments`

Trazabilidad de cada NC, incluyendo aplicación parcial.

Columnas clave:

- `id uuid PK`, `company_id uuid`.
- `credit_note_bsale_id bigint`, `credit_note_line_id uuid`.
- `credit_note_detail_bsale_id bigint`.
- `original_invoice_bsale_id bigint`, `original_invoice_line_id uuid`.
- `original_invoice_detail_bsale_id bigint`, `related_variant_id bigint NULL`.
- `pre_issue_settlement_id uuid NULL`.
- `post_issue_adjustment_id uuid NULL`.
- `original_settlement_line_id uuid NULL`.
- `status text`: `PENDING`, `APPLIED`, `CANCELLED`.
- `original_net_amount`, `adjusted_net_amount`, `commission_amount`.
- timestamps, razón y metadata de relación.

Unique de idempotencia: `(company_id, credit_note_line_id)` por aplicación.
Una NC parcial debe registrar la proporción aplicada y no permitir que la suma
de ajustes supere el neto/importe comisionado de la línea original.

### 4.12 `comisiones.audit_events`

Auditoría append-only.

Columnas: `id`, `company_id`, `actor_user_id`, `event_type`, `entity_type`,
`entity_id`, `before_data`, `after_data`, `reason`, `request_id`, `created_at`.

Eventos mínimos: publicar/reemplazar/cancelar plan, cambiar perfil, crear o
cancelar DRAFT, emitir, crear ajuste NC, marcar NC PENDING y rechazar una
superposición o incidencia de catálogo.

## 5. Resolución de producto, proveedor y Familia

1. Leer `integraciones.bsale_document_details.variant_id`.
2. Si es `NULL`, conservar la línea visible con `PRODUCT_UNRESOLVED`; queda
   excluida en V1.
3. Resolver producto por `(company_id, bsale_variant_id)`, no por SKU.
4. Leer `adquisiciones.products.bsale_brand_id`.
5. Buscar el Brand Supplier Link vigente y único.
6. Verificar que el destino sea un Supplier `REAL` activo.
7. Leer `bsale_product_type_id` como Familia y su nombre actual para snapshot.

Las incidencias de catálogo de preview son:

- `PRODUCT_UNRESOLVED`.
- `SUPPLIER_UNRESOLVED`.
- `FAMILY_UNRESOLVED`.

La incidencia debe conservarse junto con la línea, incluso si preview la
excluye. No se usa mapping operativo como fallback. La resolución se ejecuta
en una única vista/RPC V2; no existe una corrección posterior en la acción
TypeScript.

## 6. Elegibilidad y fallo de `create_draft`

Una línea de factura es elegible si cumple:

- documento comisionable, inicialmente `document_type_id = 5`;
- vendedor primario inequívoco, perfil V2 activo y comisionable;
- factura completamente pagada: estado pagado y saldo pendiente cero según la
  tolerancia CLP aprobada;
- fecha de pago completo posterior o igual a
  `first_eligible_full_payment_date` y dentro del período;
- cliente no interno y comisionable;
- producto/proveedor/Familia resueltos según el plan que corresponda;
- no existe lock activo ni definitivo para la línea;
- no fue aplicada antes en una liquidación o ajuste.

Preview devuelve `eligible`, `excluded` y `warnings`. Puede mostrar líneas
elegibles junto a líneas excluidas por catálogo.

`create_draft` recalcula todo en una transacción y no confía en totales o líneas
recibidos del navegador. Si existe una línea que, salvo la incidencia de
catálogo, sería elegible y tiene `PRODUCT_UNRESOLVED`, `SUPPLIER_UNRESOLVED` o
`FAMILY_UNRESOLVED`, la operación completa falla con un error de catálogo.

No se crea una liquidación parcial silenciosa. Tampoco se crean locks parciales:
si el borrador falla, se hace rollback de reservas y snapshot completo.

Una línea excluida por no estar pagada, fuera de período o por vendedor no
comisionable no provoca por sí sola el error de catálogo; debe informarse en el
resultado.

## 7. Plan por proveedor versionado

Cada Supplier REAL tiene como máximo un plan base vigente para una fecha. El
plan decide el tipo de cálculo para todo el proveedor durante su vigencia.

### `FAMILY_FIXED_PERCENT`

El plan contiene filas en `commission_plan_family_rates`. Cada Familia tiene su
porcentaje individual. Una línea toma el porcentaje de su `bsale_product_type_id`.

Ejemplo conceptual HAGEN:

```text
Proveedor REAL: HAGEN
Plan: HAGEN-BASE v1
Tipo: FAMILY_FIXED_PERCENT
Vigencia: 2026-09-01 en adelante

Familia Bsale                         Porcentaje
------------------------------------  ----------
Alimentos                             0,50%
Accesorios                            0,80%
Higiene                               0,00%
```

El `0,00%` de Higiene es intencional y auditable. Una Familia no configurada no
recibe cero automáticamente: produce `FAMILY_UNRESOLVED` y bloquea
`create_draft` si la línea era elegible.

### `SUPPLIER_SALES_TARGET`

El plan contiene filas en `commission_plan_tiers` y aplica globalmente al
proveedor. No se calcula progresivamente línea por línea.

Para cada combinación:

```text
seller + supplier REAL + período
```

se calcula primero:

```text
SUM(net_amount de todas las líneas elegibles del proveedor)
```

Ese total determina un solo tramo. El porcentaje de ese tramo se aplica a todas
las líneas elegibles del proveedor dentro del período, sin importar el orden de
las líneas. El total y el `tier_id` se guardan en cada snapshot.

Ejemplo conceptual SERVIPET:

```text
Proveedor REAL: SERVIPET
Plan: SERVIPET-BASE v1
Tipo: SUPPLIER_SALES_TARGET

Total neto vendedor + período       Porcentaje
----------------------------------   ----------
0 <= total <= 7.000.000                1,10%
7.000.000 < total <= 9.000.000         1,50%
9.000.000 < total                      1,80%
```

Si el total elegible es `$8.200.000`, todas las líneas elegibles de SERVIPET
para ese vendedor y período usan `1,50%`. No se ordenan líneas ni se asignan
porcentajes distintos dentro del mismo proveedor/período.

Las NC incluidas antes de emitir participan como negativos en el total si son
relacionables y elegibles para ese período. Una NC posterior no recalcula este
total: utiliza el snapshot de la línea emitida.

## 8. Vigencia, versionado y superposición

Los planes tienen `valid_from`, `valid_to`, `active`, `status` y `version_no`.
Retirar un plan marca `RETIRED`; no destruye filas ni histórico.

### Detección

Al crear o publicar un plan, una RPC transaccional busca otro plan activo de la
misma empresa y Supplier REAL cuya vigencia intersecte. La comparación ignora
el `plan_type`: no puede existir un plan FAMILY y otro TARGET activos para el
mismo proveedor y fecha.

También valida:

- familias repetidas en un plan;
- tramos solapados, con huecos o fuera de orden;
- porcentajes inválidos;
- excepciones repetidas;
- excepción sin justificación;
- plan que apunte a proveedor no REAL o inactivo.

La operación no guarda silenciosamente en presencia de conflicto. Devuelve el
plan existente, rango afectado y opciones: reemplazar desde una fecha, cancelar
o revisar excepción explícita.

### Ejemplo de transición HAGEN Familia -> Meta

Estado actual:

```text
HAGEN-BASE v1
Tipo: FAMILY_FIXED_PERCENT
Vigente: 2026-09-01 .. abierto
Familias: Alimentos 0,50%; Accesorios 0,80%
```

El usuario intenta crear:

```text
HAGEN-BASE v2
Tipo: SUPPLIER_SALES_TARGET
Vigente: 2026-10-01 .. abierto
```

La validación detecta que ambos planes activos del Supplier HAGEN se
superponen desde `2026-10-01`. La UI debe ofrecer:

1. **Reemplazar desde 2026-10-01:** cerrar v1 con `valid_to = 2026-09-30`,
   publicar v2 con `supersedes_plan_id = v1`, y auditar el cambio.
2. **Cancelar:** no modificar ningún plan.
3. **Excepción explícita:** sólo si el caso es realmente una excepción a v2,
   con `bsale_variant_id` y justificación; no permite mantener dos planes base
   globales superpuestos.

Durante el reemplazo se bloquean las filas afectadas para impedir que dos
administradores publiquen versiones incompatibles concurrentemente.

## 9. Máquina de estados y bloqueos

```text
                 +-------------------+
                 |       DRAFT        |
                 | reserva temporal   |
                 +---------+---------+
                           |
              cancelar     | emitir
                           v
                    +------+------+
                    |             |
                    v             v
              CANCELLED       ISSUED
             locks liberados  locks definitivos
```

Transiciones:

- `DRAFT -> ISSUED`: valida reservas, asigna correlativo y convierte cada lock
  en definitivo.
- `DRAFT -> CANCELLED`: exige motivo y libera reservas.
- `ISSUED` es terminal e inmutable.
- `CANCELLED` es terminal.
- `ADJUSTMENT` es `settlement_kind`, no un estado adicional; tiene las mismas
  fases y referencia a la emisión corregida.

La operación de DRAFT ordena los IDs de detalle y toma locks de forma
determinística. Una unique parcial sobre `(company_id, source_document_line_id)`
con lock activo impide doble reserva. La emisión hace `FOR UPDATE`, comprueba
que cada reserva sigue perteneciendo al DRAFT y promueve todas atómicamente.

Una liquidación ISSUED nunca libera sus locks definitivos. Un error se corrige
con ADJUSTMENT y auditoría.

## 10. Notas de crédito

### NC antes de ISSUED

1. Encontrar la referencia documental mediante
   `integraciones.bsale_document_references`.
2. Resolver el documento original por `referenced_document_id` y los detalles
   por IDs Bsale/`variant_id`.
3. Si una única línea original es inequívoca, crear una línea `CREDIT_NOTE`
   negativa en el mismo preview/borrador y relacionarla con
   `original_invoice_line_id`.
4. Si es parcial, conservar la cantidad/neto de la NC y aplicar sólo la
   proporción afectada al producto/línea.
5. En `SUPPLIER_SALES_TARGET`, incluir el neto negativo en el total del
   vendedor+proveedor+período antes de determinar el único tramo.
6. Reservar el detalle de la NC con su `id uuid` real.

La NC no afecta otras líneas ni el total de otro proveedor. Si la relación no es
inequívoca, registrar `PENDING`, mostrarla y no descontarla.

### NC después de ISSUED

1. No modificar la liquidación emitida ni sus líneas.
2. Relacionar la NC con la línea original emitida.
3. Tomar el snapshot de la comisión original: proveedor, Familia, plan, versión,
   tramo, porcentaje, neto y monto. No consultar la regla vigente al momento
   de la NC.
4. Crear un settlement `ADJUSTMENT` con línea negativa trazable.
5. Para NC parcial, calcular el reverso proporcional sobre el saldo todavía no
   revertido de la línea original:

```text
proporción = neto_NC / neto_original
comisión_a_revertir = comisión_original * proporción
```

   La suma acumulada de ajustes no puede superar el monto original.
6. Emitir el ajuste mediante el flujo normal de DRAFT, reserva y ISSUED.

Si no existe una relación inequívoca, `credit_note_adjustments.status = PENDING`
y no se crea descuento automático. La NC sigue visible en informes y requiere
resolución explícita.

## 11. Cutover legado

No se migran inicialmente reglas, perfiles ni liquidaciones de
`comercial.commission_*`. La coexistencia es separada.

### Cutover

1. Cerrar la última liquidación en el sistema legado.
2. Verificar backlog de facturas pagadas, NC pendientes, DRAFTs y líneas
   bloqueadas del legado.
3. Aprobar una fecha `first_eligible_full_payment_date` para V2.
4. Activar los planes V2 con vigencias compatibles con esa fecha.
5. V2 considera sólo facturas cuya fecha de pago completo sea posterior o igual
   al cutoff aprobado.
6. Comparar shadow reports, sin locks V2, hasta aprobar la equivalencia.
7. Habilitar DRAFT y emisión V2 sólo después de cerrar el período de prueba.

La fecha de corte se guarda en `comisiones.settings` y se copia en cada
settlement. No se calcula como `MAX(period_to)` del sistema antiguo.

### Shadow/testing

Preview V2 puede ejecutarse en modo `SHADOW` y comparar resultados, pero no crea
filas en `comisiones.line_locks`, no crea DRAFTs y no modifica ninguna tabla
legada. No se debe usar un índice o lock compartido con
`comercial.commission_settlement_lines`: la coexistencia debe ser física y
operacionalmente independiente.

## 12. Snapshots

Una línea ISSUED conserva al menos:

- documento, folio, tipo y fechas de emisión/pago;
- `source_document_line_id uuid` y `source_document_detail_bsale_id bigint`;
- `bsale_variant_id`, SKU y descripción mostrados;
- vendedor y cliente, IDs y nombres;
- Brand, proveedor REAL y Familia;
- plan, versión, tipo, rate/tier, límites y porcentaje;
- total supplier usado para `SUPPLIER_SALES_TARGET`;
- neto base, monto comisión, moneda y metadata del motor;
- referencia a factura original y datos de NC cuando corresponda.

Los cambios posteriores en producto, Brand Link, proveedor, Familia o plan no
modifican el histórico. Las exportaciones leen snapshots, no recalculan.

## 13. Bonos, fuera del schema inicial

Se mantiene aprobado el diseño conceptual de `CLIENTES_NUEVOS` para un bloque
posterior, con estas modalidades:

- bono fijo al alcanzar meta;
- monto fijo por cliente adicional;
- porcentaje adicional sobre ventas calificadas.

No se crean tablas de bonos en la primera migración V2. Tampoco se mezclan bonos
en `commission_amount` base. Cuando se implemente el bloque, deberá tener su
propia versión, vigencia, snapshot y decisión sobre emisión conjunta o separada.

## 14. Seguridad, RLS y permisos

Todas las tablas V2 llevan `company_id NOT NULL`, RLS y políticas que exigen
acceso a empresa más permiso específico. `service_role` se reserva para RPCs
controlados y sincronización.

Permisos propuestos:

- `comisiones.v2.read`: históricos, DRAFTs, ajustes, incidencias y exportaciones.
- `comisiones.v2.simulate`: preview normal o shadow sin persistencia.
- `comisiones.v2.draft.create`: crear DRAFT y reservas.
- `comisiones.v2.draft.cancel`: cancelar DRAFT.
- `comisiones.v2.issue`: emitir liquidaciones y ajustes.
- `comisiones.v2.plans.manage`: crear, versionar, reemplazar y retirar planes.
- `comisiones.v2.history.audit`: consultar auditoría detallada.

La publicación de planes debe estar separada de la emisión cuando sea posible.
La corrección de una emisión no es una operación de anulación destructiva: usa
`issue` sobre un ADJUSTMENT, con razón obligatoria.

Los RPCs `SECURITY DEFINER` deben validar actor, empresa y permiso centralmente.
RLS es defensa adicional, no sustituto de RBAC.

## 15. RPCs/actions previstos

Nombres indicativos, no implementación:

- `comisiones.preview_settlement(company_id, seller_bsale_id, period, mode)`:
  devuelve líneas elegibles/excluidas, incidencias, planes, total por proveedor,
  tier único y resultado. `mode = SHADOW` no persiste ni bloquea.
- `comisiones.validate_plan_change(payload)`: devuelve superposiciones y
  opciones de reemplazo, sin guardar.
- `comisiones.publish_plan_version(payload)`: valida proveedor, vigencia,
  familias/tramos, reemplazo y auditoría en una transacción.
- `comisiones.create_draft(criteria)`: recalcula, falla ante incidencias de
  catálogo elegibles, crea snapshot y reservas atómicamente.
- `comisiones.cancel_draft(settlement_id, reason)`.
- `comisiones.issue_settlement(settlement_id)`.
- `comisiones.resolve_credit_note(credit_note_id, original_line_id, reason)`:
  acción explícita para una NC antes pendiente.
- `comisiones.create_credit_note_adjustment(credit_note_id)`:
  usa snapshots originales y no reglas actuales.
- `comisiones.list_settlements(filters)` y
  `comisiones.get_settlement_detail(settlement_id)`.
- `comisiones.export_settlement(settlement_id, format)`: exporta snapshot.

Las futuras Server Actions son adaptadores delgados; no contienen una segunda
implementación del motor.

## 16. Frontend futuro

Ruta: `/dashboard/comercial/comisiones-v2`.

- Acceso independiente en Sidebar durante validación.
- Reutilizar `ModuleShell`, Sidebar y `OperationalTable` cuando corresponda.
- Tablas densas para preview, incidencias, planes, DRAFTs, emitidas, ajustes y
  auditoría.
- CLP como `$493.197`, porcentajes como `0,36%`, fechas y cantidades de Chile.
- Preview debe separar claramente excluidas, incidencias de catálogo, DRAFT
  reservado, ISSUED inmutable y ADJUSTMENT.

No se implementa UI en esta fase.

## 17. Referencias conceptuales al sistema actual

Se conserva como comportamiento probado:

- elegibilidad por factura completamente pagada;
- cálculo por línea y base neta;
- preview sin persistencia;
- DRAFT con reserva temporal y cancelación liberadora;
- emisión con correlativo y snapshot;
- vendedor primario Bsale;
- NC como línea negativa cuando la relación es inequívoca;
- exportaciones y estados mínimos `DRAFT`, `ISSUED`, `CANCELLED`.

No se reutiliza automáticamente:

- tablas, RPCs, vistas, acciones o permisos `comercial.commission_*`;
- resolución SKU -> producto;
- mappings operativos o pseudoproveedores;
- `commission_groups` como Familia;
- reglas genéricas por scope/priority;
- fallback GENERAL;
- recalcular una NC posterior con regla vigente;
- anular ISSUED liberando líneas;
- aceptar payload de cálculo confiado desde frontend.

## 18. Orden de implementación posterior

1. Confirmar contrato de fuentes, tipos y relaciones Bsale, incluida la
   resolución de detalles de NC.
2. Crear schema, tablas finales, RLS, RBAC y auditoría, sin migrar legado.
3. Implementar resolución única por variant -> Brand Link -> REAL -> Familia.
4. Implementar planes versionados, rates de Familia, tiers y excepciones
   explícitas, con detección transaccional de superposición.
5. Implementar elegibilidad y preview, incluyendo modo SHADOW sin locks.
6. Implementar total seller + supplier + período y selección de un único tier.
7. Implementar DRAFT, `line_locks`, cancelación, emisión y concurrencia.
8. Implementar NC pre-ISSUED y ajustes post-ISSUED basados en snapshot.
9. Ejecutar cutover: backlog, fecha, shadow y aprobación operativa.
10. Implementar exportaciones e UI V2.
11. Diseñar e implementar bonos como bloque posterior independiente.

## 19. Cierres para aprobación

1. Confirmar la fecha inicial de `first_eligible_full_payment_date` y si el
   predicado será `>= cutoff` o estrictamente `> cutoff`.
2. Confirmar que un Supplier REAL no puede tener dos planes base superpuestos,
   aun cuando sean de distinto tipo.
3. Confirmar que el total de `SUPPLIER_SALES_TARGET` incluye NC pre-ISSUED
   relacionadas y que NC post-ISSUED usa exclusivamente snapshot.
4. Confirmar el algoritmo de relación de detalle de NC cuando el documento
   original tiene varias líneas del mismo `variant_id`; si no es inequívoco,
   queda `PENDING`.
5. Confirmar si la regla de Familia ausente debe bloquear siempre el DRAFT
   aunque el monto potencial sea cero.
6. Confirmar límite de acumulación de NC parciales y tratamiento de NC que
   supera el saldo original.
7. Confirmar roles reales para simular, publicar plan, crear DRAFT, emitir,
   cancelar y consultar auditoría.
8. Confirmar que durante SHADOW no se crea ningún lock ni DRAFT V2.

Este documento no crea migraciones, no modifica código productivo, no toca
`comercial.commission_*` y no incluye tablas de bonos en el schema inicial.
