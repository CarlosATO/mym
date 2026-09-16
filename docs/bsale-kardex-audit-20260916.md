# Auditoria Kardex Bsale: historico de stock 60d

Fecha de lectura: 2026-09-16. Tenant MYM, empresa `d1000000-0000-0000-0000-000000000001`, CASA MATRIZ (`office_id=1`). Ventana inclusiva: 2026-07-19 a 2026-09-16. Todas las consultas fueron `GET`; no se modificaron datos, esquema ni frontend.

## Conclusion

**VIABLE CON LIMITACIONES.** Bsale expone las piezas necesarias para una reconstruccion operativa, pero no existe un Kardex unico ni un saldo diario historico consultable. La reconstruccion solo es demostrable cuando se capturan conjuntamente recepciones, consumos, despachos, devoluciones y documentos/anulaciones, con sus estados y orden efectivo. Con las fuentes actualmente sincronizadas no es responsable afirmar 60 dias completos para ningun SKU.

El snapshot directo debe seguir siendo la evidencia de mayor nivel. La auditoria no reemplaza `integraciones.bsale_stock_daily_snapshots`.

## 1. Fuentes y endpoints

| Fuente | Endpoint real | Filtros relevantes | Identificador/cantidad/fecha | Resultado tenant |
|---|---|---|---|---|
| Stock actual | `GET /v1/stocks.json` | `officeid`, `variantid`, `code`; max 50 | `variant.id`, `quantity`, `quantityReserved`, `quantityAvailable`; sin fecha historica | 1.237 filas CASA MATRIZ |
| Recepcion | `GET /v1/stocks/receptions.json` | `admissiondate` es dia exacto, `officeid`; max 50 | `id`, `admissionDate`, `office.id`; detalle `quantity`, `variant.id`, `variantStock` | 216 encabezados en 60d |
| Detalle recepcion | `GET /v1/stocks/receptions/{id}/details.json` | paginacion max 50 | cantidad positiva; `variantStock` | incluido en 1.828 detalles de recepcion/consumo |
| Consumo | `GET /v1/stocks/consumptions.json` | `consumptiondate` es dia exacto, `officeid`; max 50 | `id`, `consumptionDate`, `consumptionTypeId`, `updateStock`, `office.id`; detalle como arriba | 68 encabezados en 60d |
| Despacho | `GET /v1/shippings.json` | `shippingdate`, `officeid`, `documentid`, `state`; max 50 | `shippingDate`, `state`, `received`, `office.id`; detalle `quantity`, `variant.id`, `variantStock` | endpoint 200; 25.529 total para office 1 |
| Detalle despacho | `GET /v1/shippings/{id}/details.json` | paginacion max 50 | cantidad de salida y `variantStock` posterior | 2.594 detalles al seguir despachos de los documentos de muestra |
| Devolucion | `GET /v1/returns.json` | `returndate`, `officeid`, `referencedocumentid`, `creditnoteid`; max 50 | `returnDate`, `office.id`, referencias; detalle `quantityDevStock`, `variantStock` | endpoint 200; 3.599 total para office 1 |
| Detalle devolucion | `GET /v1/returns/{id}/details.json` | paginacion | cantidad devuelta a stock y `variantStock` | debe incluirse para saldo neto |
| Documentos/ventas | `GET /v1/documents.json`, `GET /v1/documents/{id}/details.json` | `emissiondaterange`, `officeid`, `documenttypeid`, `state`; max 50 | `document.id`, `document_type.id`, `office.id`, `state`, detalle `variant.id`, `quantity`; fecha de emision/generacion | documentos son necesarios para enlazar despachos; no todos descuentan stock |
| Tipos de consumo | `GET /v1/stock_consumption_types.json` | paginacion | `cntId`, nombre/codigo | 4 tipos en tenant |

La documentacion confirma que un documento de despacho siempre genera salida de stock cuando la variante controla stock. Los documentos de venta solo descuentan si se despachan, por lo que no se deben sumar ciegamente como salida junto con `shippings`.

Documentacion consultada: [Stocks](https://docs.bsale.dev/stocks), [Documentos](https://docs.bsale.dev/documentos), [Despachos](https://docs.bsale.dev/documentos/despachos), [Devoluciones](https://docs.bsale.dev/devoluciones), [Webhooks de stock](https://docs.bsale.dev/productos-y-servicios/webhooks).

## 2. Cobertura de movimientos

| Tipo | Fuente/API | Afecta stock | Disponible | Observacion |
|---|---|---:|---:|---|
| Recepcion/entrada | `/stocks/receptions` | Si | Si | `quantity` positiva, detalle con `variantStock` |
| Consumo/merma/retiro | `/stocks/consumptions` | Si, cuando `updateStock` aplica | Si | requiere conservar `consumptionTypeId` y `updateStock` |
| Venta con despacho | `/documents` + `/shippings` | Si | Si | el despacho es la evidencia de salida |
| Guia/traslado interno | `/documents` + `/shippings`; recepcion destino bajo `/v2/stocks/receptions/shipping/{id}.json` | Si | Parcial | origen y destino requieren enlazar guia, shipping y recepcion |
| Devolucion | `/returns` + `/returns/{id}/details` | Si | Si | usar `quantityDevStock`, no cantidad comercial a ciegas |
| Ajuste/toma de inventario | recepcion/consumo con `note`, `updateStock` y tipo | Si | Parcial | no hay endpoint `/stocks/inventories` en tenant; puede materializarse como recepcion/consumo |
| Anulacion | estado de documento/despacho/devolucion y documentos relacionados | Si | Parcial | debe aplicar estado y referencia; no basta con ignorar el documento original |
| Endpoint Kardex generico | ninguno | n/a | No | probes `/stocks/dispatches`, `/stocks/inventories`, `/stocks/adjustments`, `/stocks/transfers` devolvieron 404 |

No se puede demostrar desde API que cada ajuste interno tenga una clase separada: Bsale lo representa operacionalmente dentro de recepciones/consumos. Esa es una limitacion de auditabilidad, no evidencia de que el evento no exista.

## 3. Semantica comprobada de `variantStock`

`variantStock` es el stock de la variante **despues de aplicar el detalle**.

- ALK01, recepcion 2026-07-23: `quantity=300`, `variantStock=422`; el saldo inmediatamente anterior era 122, por lo que `122 + 300 = 422`.
- ALK01, consumo 2026-07-24: `quantity=1`, `variantStock=380`; el valor es consistente con una salida posterior al movimiento.
- SKU 1020, recepcion 2026-09-15: `quantity=10`, `variantStock=1665`, coincidente con stock actual y snapshot.
- SKU 20074, recepcion 2026-09-15: `quantity=24`, `variantStock=28`, coincidente con stock actual y snapshot.

Los controles no son suficientes por si solos: hay movimientos de venta/despacho intercalados y la API entrega fecha de movimiento a nivel de dia, no un orden total con precision suficiente para resolver todos los empates.

## 4. Muestra real

`3000` no fue encontrado en la muestra activa de stock de CASA MATRIZ. La muestra auditada fue:

| SKU | variant_id | Producto | Stock Bsale | Disponible | Stock current Supabase | Snapshot 15/16 Sep | Movimientos stock | Despachos seguidos | Detalles docs |
|---|---:|---|---:|---:|---:|---|---:|---:|---:|
| 20001 | 6276 | DOGGO ASTA DE CIERVO | 9 | 9 | 9 | 9 / 9 | 0 | 4 | 8 |
| 78353602353312 | 7021 | TRAPER ARENA SANITARIA TALCO BEBE | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 |
| ALK01 | 6071 | ALASKA ADULTO | 257 | 221 | 257 | 257 / 257 | 10 (6 recep., 4 cons.) | 52 | 120 |
| 20074 | 6461 | CATGO SAZONADOR CERDO | 28 | 28 | 28 | 28 / 28 | 2 (1 recep., 1 cons.) | 1 | 4 |
| 1020 | 6199 | DIP DOG CARNE | 1.665 | 1.650 | 1.665 | 1.665 / 1.665 | 12 (11 recep., 1 cons.) | 71 | 154 |

Todos los stocks actuales directos de Bsale coincidieron con `bsale_stock_current` en la muestra: diferencia 0. Los snapshots disponibles al momento de la auditoria son solo 2026-09-15 y 2026-09-16.

## 5. Reconstruccion y dias

### Metodo A: stock actual como ancla

Es util para calcular hacia atras, pero solo es confiable si el conjunto de eventos es completo y cada evento tiene signo, estado y orden. El primer intento usando solo recepciones y consumos falla: ALK01 termina con ultimo `variantStock=353` y stock actual 257, diferencia -96, explicada por salidas posteriores no contenidas en esos endpoints. Los despachos son obligatorios.

### Metodo B: `variantStock` como checkpoints

Es mejor como control local que como fuente diaria. Hay checkpoints en detalles de recepcion/consumo/despacho, pero no uno para cada dia ni necesariamente para cada salida de documento. Sirve para validar la reconstruccion, no para rellenar silenciosamente los dias intermedios.

Conteo conservador, sin convertir ausencia en cero:

| SKU | Observed | Reconstructed demostrable | Unknown | OUT_OF_STOCK demostrable | IN_STOCK demostrable |
|---|---:|---:|---:|---:|---:|
| 20001 | 2 | 0 | 58 | 0 | 2 |
| 78353602353312 | 2 | 0 | 58 | 2 | 0 |
| ALK01 | 2 | 0 | 58 | 0 | 2 |
| 20074 | 2 | 0 | 58 | 0 | 2 |
| 1020 | 2 | 0 | 58 | 0 | 2 |

Estos conteos son una declaracion de evidencia disponible, no una estimacion de disponibilidad real. No se calculan dias `NEGATIVE` porque no existe evidencia suficiente para afirmar su ausencia o presencia en los dias sin snapshot. Por tanto no se debe calcular aun una metrica definitiva de quiebre ni venta perdida.

## 6. Cruce con ventas

El espejo contiene detalles de documentos, y para la muestra se observaron cantidades en la ventana: 20001 (14 unidades), ALK01 (986), 20074 (16), 1020 (2.235) y cero para el SKU sin actividad. Los tipos observados incluyen factura (5), guia (7), nota de venta (23) y nota de credito (2), todos activos en los registros consultados.

El cruce permite detectar dias con ventas y posterior recuperacion, pero no permite atribuir quiebre sin resolver si el documento despacho stock, si ya fue despachado, devoluciones y anulaciones. La informacion es suficiente para una implementacion posterior si se normaliza el evento efectivo de stock; no es suficiente para una cifra definitiva en esta auditoria.

## 7. Requests y rendimiento

La corrida de muestra mas completa hizo **1.827 requests**, **1.816 paginas**, recupero **1.828 detalles de recepcion/consumo**, y duro **168 segundos** (2m48s). La mayor carga provino de seguir despachos por documento; el cliente existente pagina a 50.

- Bsale permite maximo observado/documentado de 50 por pagina.
- Recepciones y consumos admiten filtro por sucursal y fecha exacta, no rango; para 60 dias se requieren hasta 120 requests de encabezados antes de sus detalles.
- `stocks.json` admite filtrar varias variantes por request via `variantid` como lista, pero no entrega historia.
- Una consulta por variante seria costosa: para ~1.237 variantes, solo stocks actuales ya requiere unas 25 paginas; por variante y por tipo multiplicaria requests y eleva riesgo de omisiones.
- La estrategia recomendada es consultar por fecha/sucursal, paginar una vez, distribuir localmente por `variant_id`, y seguir solo los detalles necesarios. Para despachos/documentos usar rangos de fecha cuando el endpoint los soporte y luego filtrar estado y sucursal localmente.

No ejecutar el backfill masivo hasta medir el volumen real de documentos/despachos del rango completo y definir concurrencia, retry, rate limit e idempotencia.

## 8. Webhooks

La documentacion de Bsale permite solicitar activacion al tenant para:

- `topic=stock`, accion `put`: payload `{cpnId, resource, resourceId, topic, action, officeId, send}`. El `resource` apunta al stock/variante y sucursal; cubre entradas, salidas, tomas de inventario, consumos y despachos, pero no es un historico almacenado por Bsale.
- `topic=document`, accion `post`: payload `{cpnId, resource, resourceId, topic, action, officeId}`. Permite leer el documento y sus datos de stock.
- Tambien existen topics de producto, variante y precio.

El webhook identifica variante/stock y sucursal para `stock`, pero no entrega en el payload la cantidad delta ni una razon de negocio completa. Debe usarse como disparador para leer el recurso y persistir un evento propio; requiere deduplicacion y reconciliacion periodica. No se comprobo activacion efectiva del tenant porque `/webhooks.json` devolvio 404 y no se hizo ninguna escritura/configuracion.

## 9. Arquitectura recomendada

1. Mantener `bsale_stock_daily_snapshots` como evidencia observada y no reemplazarlo.
2. Agregar en una fase posterior un espejo normalizado de eventos de stock, con fuente, id de encabezado/detalle, variante, sucursal, fecha efectiva, delta, `variantStock`, estado, tipo de consumo, documento relacionado y payload bruto.
3. Derivar un stock diario/resumen desde esos eventos, marcando cada punto como `OBSERVED`, `RECONSTRUCTED` o `UNKNOWN`; nunca inferir `0` por falta de eventos.
4. Cargar el snapshot directo cuando exista y usarlo como checkpoint prioritario para corregir/validar la reconstruccion.
5. Mantener el hover del card como read-model local precalculado: cero requests en UI.
6. Hacia adelante, combinar webhook de stock/documento con un job de reconciliacion por fecha/sucursal para cubrir eventos perdidos, anulaciones y traslados.

No conviene almacenar solo un resumen por SKU: impediria auditar diferencias y reconstruir despues de una anulacion. La recomendacion es **ambos**: eventos normalizados + resumen diario, convivientes con snapshots directos.
