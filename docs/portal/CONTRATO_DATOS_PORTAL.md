# Contrato Mínimo de Datos del Portal MYM

## 1. Alcance

Este contrato define exclusivamente los datos de lectura necesarios para el Portal principal de MYM. El Portal es un dashboard operacional liviano; no es un módulo de análisis y no reemplaza Ventas, Cobranzas, Guías de Ruta ni Análisis Comercial.

El contrato no implementa consultas, RPC, UI ni cambios de base de datos.

El Portal solo mostrará:

- Las últimas cinco guías de ruta emitidas.
- Ventas del mes actual.
- Cantidad de facturas del mes actual.
- Ticket promedio del mes actual.
- Serie diaria de ventas del mes actual.
- Cobrado aplicado del mes actual.
- Saldo pendiente por cobrar.
- Cartera vencida.
- Serie diaria de cobros aplicados del mes actual.

No forman parte de este contrato las variaciones, tendencias, rankings, proyecciones, comparaciones históricas ni desgloses por vendedor, cliente, producto o proveedor.

## 2. Convenciones generales

### Empresa activa

Todas las lecturas deben recibir y validar la empresa activa mediante `active_company_id`, usando los mecanismos actuales de acceso empresarial (`core.user_company_access`, `core.has_company_access` y RLS cuando corresponda).

Está prohibido usar `COMPANY_ID`, UUID fijo de MYM o cualquier empresa codificada en la futura capa de lectura.

Cada consulta debe aplicar el alcance de empresa explícitamente con `company_id = active_company_id`.

### Fechas y zona horaria

La zona operativa es `America/Santiago`.

El mes actual se determina como el mes calendario de `todayInSantiago()`, utilizando sus límites civiles `YYYY-MM-01` y la fecha civil actual. No se deben convertir fechas civiles PostgreSQL a instantes UTC para determinar el día.

Para campos `date`, usar directamente el valor civil. Para `timestamptz`, utilizar la fecha civil en `America/Santiago` solo cuando el contrato lo indique.

### Montos

Los montos se expresan en pesos chilenos (CLP). La futura capa de lectura debe devolver valores numéricos; el formateo visual pertenece a la UI.

## 3. Últimas 5 Guías de Ruta

### Fuente y universo

Fuente principal: `logistica.route_guides`.

Filtro obligatorio:

```text
company_id = active_company_id
status = 'DISPATCHED'
```

Orden y límite:

```text
guide_date DESC,
guide_number DESC
LIMIT 5
```

“Emitida” significa una guía despachada (`DISPATCHED`), no un borrador.

### Campos del contrato

Cada elemento debe contener:

- `guide_id`: `route_guides.id`.
- `guide_number`: `route_guides.guide_number`.
- `guide_date`: `route_guides.guide_date`.
- `route_name_snapshot`: `route_guides.route_name_snapshot`.
- `total_invoices`: `route_guides.total_invoices`.
- `total_amount`: `route_guides.total_amount`.
- `utility`: `estimated_gross_profit` devuelto por la RPC canónica.
- `cost_status`: devuelto por la RPC canónica.
- `cost_coverage_pct`: devuelto por la RPC canónica.

La UI solo mostrará Guía, Fecha, Ruta, Facturas, Monto total y Utilidad. `cost_status` y `cost_coverage_pct` se conservan para una advertencia discreta de cobertura parcial.

### Utilidad

Fuente exclusiva:

```text
logistica.get_route_guide_profitability_v1(route_guides.id)
```

El Portal no reconstruirá ni duplicará la fórmula. Debe utilizar únicamente:

```text
utility = estimated_gross_profit
```

La RPC calcula la utilidad estimada con las ventas netas con costo cubierto menos el costo de última compra válido. Puede devolver `cost_status = 'PARTIAL'`; esto no debe convertirse en una utilidad alternativa ni ocultarse.

La lectura futura debe seleccionar primero las cinco guías y luego ejecutar la RPC únicamente para esos cinco IDs, idealmente en paralelo y dentro de una única operación de carga. No debe reutilizar el patrón actual de cargar hasta 50 guías y ejecutar una RPC por cada una.

No se incorporan `margin`, `last_purchase_cost_total`, detalle de líneas ni otros campos de rentabilidad.

## 4. Ventas del Mes

### Fuente y universo

Fuente: `integraciones.bsale_documents`.

El universo es siempre la empresa activa, el mes calendario actual en `America/Santiago`, documentos activos y solo:

- Facturas: `document_type_id = 5`.
- Notas de crédito: `document_type_id = 2`.

Documento activo significa `state = 0`, según el contrato Bsale existente.

Las notas de venta (`document_type_id = 23`) quedan fuera.

### Ventas del mes

```text
SUM(total_amount de facturas activas tipo 5)
-
SUM(total_amount de notas de crédito activas tipo 2)
```

La fecha es `emission_date`. El resultado incluye únicamente fechas entre el primer día del mes actual y `todayInSantiago()`, ambos inclusive.

Las notas de crédito reducen el monto de ventas, pero no reducen la cantidad de facturas.

### Facturas

El indicador se llama exactamente **Facturas**.

```text
COUNT(*) de facturas activas tipo 5
```

Se consideran únicamente facturas activas tipo 5 emitidas durante el mes calendario actual. Las notas de crédito no disminuyen este conteo.

### Ticket promedio

```text
Ticket promedio = Ventas del mes / Facturas
```

Si `Facturas = 0`, el resultado es `0`.

### Ventas diarias

La serie se construye con exactamente el mismo universo de Ventas del mes:

```text
SUM(total_amount de facturas activas tipo 5)
-
SUM(total_amount de notas de crédito activas tipo 2)
```

Se agrupa por `emission_date` y solo se incluyen días del mes actual. Los días sin movimiento pueden representarse con valor `0` para completar el gráfico.

La suma de todos los días debe reconciliar exactamente con Ventas del mes. No se calculan variaciones, promedios móviles, crecimiento ni comparaciones históricas.

## 5. Cobranzas del Mes

### Cobrado del mes

“Cobrado del mes” significa exclusivamente dinero aplicado a documentos por cobrar durante el mes actual.

Fuente: `integraciones.bsale_document_payments`.

Campos:

- Monto: `amount_applied`.
- Fecha: `payment_record_date`.
- Empresa: `company_id`.

Fórmula:

```text
SUM(amount_applied)
```

Filtro:

```text
company_id = active_company_id
payment_record_date >= primer_día_del_mes
payment_record_date < primer_día_del_mes_siguiente
amount_applied > 0
payment_record_date IS NOT NULL
```

La tabla de asignaciones no posee un campo de estado propio. Por ello, “registro válido” en este contrato significa una asignación con fecha de registro y monto positivo. El estado disponible en `integraciones.bsale_payments` no debe usarse para reemplazar la tabla de asignaciones ni para sumar pagos brutos.

No se utilizará directamente `integraciones.bsale_payments.amount`, porque existen movimientos que no necesariamente están asignados a documentos.

### Pagos no asignados

Los pagos no asignados quedan fuera de `Cobrado del mes` y `Cobrado diario`. El Portal no intentará resolver, estimar ni reconciliar esos movimientos.

Esta exclusión es intencional: el KPI representa cobro aplicado a documentos por cobrar, no el total bruto de movimientos recibidos.

### Cobrado diario

Se utiliza exclusivamente para el gráfico pequeño del card de Cobranzas:

```text
SUM(amount_applied)
GROUP BY payment_record_date
```

Se aplican los mismos filtros de empresa, mes y registros válidos de `Cobrado del mes`.

La suma diaria debe reconciliar exactamente con `Cobrado del mes`. No se calculan variaciones, tendencias ni comparaciones.

## 6. Pendiente por Cobrar

Fuente canónica: `comercial.vw_receivables_reporting_summary`.

Campo:

```text
total_pending_all
```

Filtro:

```text
company_id = active_company_id
```

El valor representa el saldo total pendiente por cobrar de la empresa activa según la vista canónica. No se reconstruirá sumando manualmente documentos, pagos o clientes.

Si una futura lectura granular fuera estrictamente necesaria, debe utilizar `comercial.vw_customer_invoice_receivables`, pero no debe duplicar la fórmula de la vista resumen.

## 7. Cartera Vencida

Fuente canónica: `comercial.vw_receivables_reporting_summary`.

Campo:

```text
overdue_amount_all
```

La vista granular subyacente determina vencimiento usando:

- `expiration_date`.
- `pending_amount`.
- `days_overdue`.
- Fecha actual de PostgreSQL.

Definición de negocio:

```text
Cartera vencida = saldo pendiente de documentos cuyo vencimiento ya ocurrió
```

La interpretación de la fecha actual debe ser `America/Santiago`. No se agregan tramos de mora, aging, porcentajes, cantidad de clientes morosos ni rankings.

## 8. Fecha Global del Portal

Fuente: `src/lib/datetime.ts`.

Utilidad base: `todayInSantiago()`.

Zona horaria: `America/Santiago`.

El Topbar posteriormente mostrará una fecha civil como:

```text
viernes 28 de agosto
```

La fecha no debe construirse convirtiendo `YYYY-MM-DD` a un instante UTC. Este contrato no define calendario, Popover ni interacción de UI.

## 9. Rendimiento y Forma de Lectura Futura

La futura capa de lectura debe respetar estos límites:

- Máximo cinco guías.
- Una lectura agregada para Ventas.
- Una lectura agregada para Cobranzas aplicadas.
- Una lectura resumen para Pendiente y Cartera vencida.
- Sin consultas por documento individual.
- Sin cargar datasets completos.
- Sin traer detalle de facturas ni detalle de pagos.
- Sin cálculos históricos o analíticos.

Para guías, la alternativa eficiente compatible con la fórmula canónica es:

1. Seleccionar cinco cabeceras desde `logistica.route_guides`.
2. Ejecutar `logistica.get_route_guide_profitability_v1` solo para esos cinco IDs.
3. Combinar los resultados sin modificar la fórmula.

Crear una nueva RPC batch para rentabilidad no forma parte de este contrato y requeriría un cambio posterior de BD.

## 10. Antecedentes y Limitaciones Conocidas

Estos puntos no se resuelven en este bloque:

- Existen acciones comerciales con empresa fija; la futura lectura del Portal no puede reutilizarlas sin adaptar su alcance a `active_company_id`.
- Existen pagos Bsale no asignados a documentos; se excluyen deliberadamente de los KPI de cobro.
- La cobertura de costos de algunas guías es parcial; la utilidad se conserva como estimada y se acompaña de su estado de cobertura.
- La sincronización y su frescura deben exponerse o resolverse en bloques posteriores; este contrato solo define las fuentes de lectura.

No existe otro bloqueador de datos para construir esta capa mínima, siempre que se respete la semántica de pagos aplicados y el alcance multiempresa.

## 11. Tabla de Contrato

| Elemento | Fuente | Campo fecha | Cálculo | Alcance |
|----------|--------|-------------|---------|---------|
| Últimas 5 guías | `logistica.route_guides` | `guide_date` | `status = 'DISPATCHED'`, ordenar `guide_date DESC, guide_number DESC`, `LIMIT 5` | `active_company_id` |
| Utilidad | `logistica.get_route_guide_profitability_v1(uuid)` | Fecha interna de documentos/costos de la RPC | `estimated_gross_profit` | IDs de las 5 guías activas |
| Ventas del mes | `integraciones.bsale_documents` | `emission_date` | Facturas activas tipo 5 menos notas de crédito activas tipo 2, por `total_amount` | Mes actual en `America/Santiago`, empresa activa |
| Facturas | `integraciones.bsale_documents` | `emission_date` | `COUNT(*)` de facturas activas tipo 5 | Mes actual, empresa activa |
| Ticket promedio | Resultado de Ventas y Facturas | Mes de `emission_date` | `Ventas del mes / Facturas`; cero si no hay facturas | Mes actual, empresa activa |
| Ventas diarias | `integraciones.bsale_documents` | `emission_date` | Mismo cálculo de Ventas del mes agrupado por día | Mes actual, empresa activa |
| Cobrado del mes | `integraciones.bsale_document_payments` | `payment_record_date` | `SUM(amount_applied)` de asignaciones válidas | Mes actual, empresa activa |
| Cobrado diario | `integraciones.bsale_document_payments` | `payment_record_date` | `SUM(amount_applied)` agrupado por día | Mes actual, empresa activa |
| Pendiente por cobrar | `comercial.vw_receivables_reporting_summary` | No aplica al agregado | `total_pending_all` | Empresa activa |
| Cartera vencida | `comercial.vw_receivables_reporting_summary` | `expiration_date` en vista granular | `overdue_amount_all` | Empresa activa, vencimiento interpretado en `America/Santiago` |
| Fecha Topbar | `src/lib/datetime.ts` | Fecha civil actual | `todayInSantiago()` | ERP, zona `America/Santiago` |
