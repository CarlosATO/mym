# Auditoria final: disponibilidad historica y definicion de quiebre

Fecha de lectura: 2026-09-16. CASA MATRIZ (`office_id=1`). Auditoria focalizada, basada en `docs/bsale-kardex-audit-20260916.md`; solo se hicieron lecturas a Bsale y Supabase. No hay migraciones ni cambios productivos.

## Respuesta ejecutiva

1. **`quantityAvailable` historico: Parcial.** Se puede reconstruir el componente fisico (`quantity`) con eventos de stock, pero no el componente de reservas historicas. Por tanto el disponible historico completo queda `UNKNOWN` cuando pudo existir una reserva.
2. **`quantityReserved` historico: No.** Solo se observa el valor actual en `stocks.json`. No existe endpoint de reservas probado ni el detalle de una nota de venta expone un campo de reserva.
3. **Precision temporal:** documentos tienen `generationDate` con hora; recepciones, consumos y despachos reales auditados entregan fecha efectiva a medianoche (`00:00:00Z`). No hay orden temporal deterministico entre encabezados del mismo dia. El orden de detalles puede sugerir una secuencia por `variantStock`, pero no prueba hora.
4. **Conclusion:** se puede demostrar saldo al cierre solo con snapshot directo o checkpoint suficientemente completo; no se pueden demostrar 60 dias de `quantityAvailable` ni dias completos sin disponibilidad sin marcar incertidumbre.

## Reservas actuales

Se comprobaron tres variantes con diferencia entre fisico y disponible:

| SKU | variant_id | quantity | quantityReserved | quantityAvailable | Relacion |
|---|---:|---:|---:|---:|---|
| 756266 | 6257 | 222 | 60 | 162 | `222 - 60 = 162` |
| 756216 | 6251 | 108 | 48 | 60 | `108 - 48 = 60` |
| ALK01 | 6071 | 257 | 36 | 221 | `257 - 36 = 221` |

La igualdad actual es verificable. La API devuelve 4.518 notas de venta abiertas (`documenttypeid=23`, `officeid=1`, `state=0`) en la consulta real, pero sus detalles contienen solo `quantity`, variante y referencias comerciales, no `quantityReserved`, `reservedAt`, `releasedAt` ni saldo antes/despues. El espejo Supabase tampoco encontro documentos abiertos vinculados a esas tres variantes. Esto no demuestra que no existan reservas: demuestra que no hay una relacion API observable para explicarlas.

Probes directos:

- `/stocks/reservations.json`, `/stock_reservations.json`, `/reservations.json` y `/documents/pending.json`: `404`.
- `/orders.json`: `400`, recurso inexistente.
- `/stocks.json`: entrega reserva actual, sin fecha de creacion/liberacion.
- Despachos entregan `state`, `received`, `quantity` y `variantStock`, pero no el historial de reservas que originaron la salida.

La reserva historica debe clasificarse como **NO reconstruible con precision**. A lo sumo puede inferirse parcialmente en un instante si existe snapshot de `quantity`, `quantityReserved` y `quantityAvailable`; no se puede saber cuanto tiempo estuvo vigente ni cuando se libero.

## Eventos y precision

Ejemplos reales de multiples eventos del mismo dia:

- ALK01, 2026-08-19: dos recepciones, `variantStock=151` y `351`.
- SKU 1020, 2026-08-25: tres recepciones con `variantStock=2254`, `2274`, `2294`, y un consumo posterior observado con `variantStock=2274`.
- SKU 3002, 2026-08-13: recepciones y consumos que llegan a `variantStock=0` y luego vuelven a positivo.

En los tres casos los timestamps de movimientos son `2026-..T00:00:00.000Z`. Se puede ordenar razonablemente por la secuencia devuelta dentro de un detalle y comprobar los saldos posteriores, pero no afirmar “09:00”, ni garantizar el orden entre encabezados diferentes del mismo dia. Resultado: se puede demostrar de forma segura el **saldo final del dia** solo cuando el conjunto de eventos del dia es completo; no el saldo despues de cada evento intradia con precision horaria.

## Definicion de dia sin stock

| Definicion | Stock fisico (`quantity`) | Stock disponible (`quantityAvailable`) |
|---|---|---|
| Cierre sin stock | **Demostrable** en snapshot directo o checkpoint final completo; `quantity=0` | **Parcial**: requiere reserva historica; demostrable solo donde existe snapshot directo de available |
| Quiebre en algun momento | **Demostrable como quiebre confirmado en el dia** si un movimiento tiene `variantStock=0`; no se conoce la hora | **No demostrable historicamente** sin `quantityReserved` por evento |
| Dia completo sin stock | **No demostrable** solo con eventos diarios; requiere snapshots/observaciones en los limites del dia | **No demostrable** por la misma razon, agravada por reservas faltantes |

Casos reales de quiebre fisico observado en el Kardex:

- SKU `3002` (`variant_id=6282`), 2026-08-13: consumo `quantity=36`, `variantStock=0`; el mismo dia aparece otro consumo con `variantStock=24`. No hay hora para afirmar cuanto duro el cero.
- SKU `2008DG` (`variant_id=7079`), 2026-08-13: consumo `quantity=24`, `variantStock=0`; luego otro consumo registra `variantStock=60`. Es una inconsistencia/secuencia operacional del mismo dia, no prueba de dia completo sin stock.
- Recuperacion posterior: SKU `ANC001` (`variant_id=6462`), `variantStock=0` el 2026-09-04 y recepcion `quantity=150`, `variantStock=150` el 2026-09-07. SKU `EC-20LA` (`variant_id=6434`), cero por consumo de 82 el 2026-09-04 y recepcion de 71, `variantStock=71`, el 2026-09-07.

Los dos primeros ejemplos no deben presentarse como “dias completos sin stock”; solo como **quiebre confirmado en algun punto del dia**. Los dias sin evidencia siguen siendo `UNKNOWN`, nunca cero.

## Recomendacion para el card

La etiqueta tecnicamente correcta para la evidencia disponible es **“Días con quiebre confirmado”**, no “Días sin stock”. Debe contar solo eventos/snapshots que prueben `quantity=0` o, para disponibilidad al cliente, `quantityAvailable=0` en el nivel de evidencia correspondiente.

- `OBSERVED`: snapshot directo; puede sostener cierre fisico y disponible.
- `RECONSTRUCTED`: saldo calculado desde eventos completos; para `quantityAvailable` solo si no hay reserva desconocida.
- `UNKNOWN`: falta de snapshot, evento, reserva o orden temporal; no cuenta como quiebre.

Si el negocio quiere “cierre sin stock”, esa etiqueta es valida para una serie de cierres diarios observados/reconstruidos, pero debe explicitarse en la UI. “Días sin disponibilidad” solo debe usarse cuando exista `quantityAvailable` observado o reconstruible con reservas.

## Venta potencial no capturada

Para venta perdida futura, el criterio primario debe ser **`quantityAvailable <= 0`**, porque representa lo que Bsale podia ofrecer despues de descontar reservas. `quantity=0` sirve para diagnostico de stock fisico, pero puede ser distinto de disponibilidad comercial; igualmente, `quantity>0` con reservas suficientes puede producir `quantityAvailable=0`.

La estimacion debe exigir ventas/demanda por intervalo y no tratar `UNKNOWN` como quiebre. Si no se puede reconstruir disponible, el resultado debe ser un rango o solo utilizar dias `OBSERVED`, no una perdida definitiva basada en stock fisico.

## Conclusion tecnica final

El historico de **stock fisico** es parcialmente viable mediante Kardex completo, snapshots y estados. El historico de **disponibilidad/reservas** no es reconstruible con precision porque Bsale solo expone la reserva actual y no sus eventos de alta/liberacion. La implementacion futura debe separar fisico de disponible, usar “Días con quiebre confirmado”, conservar `UNKNOWN`, priorizar snapshots directos y no calcular venta perdida definitiva hasta resolver la brecha de reservas.
