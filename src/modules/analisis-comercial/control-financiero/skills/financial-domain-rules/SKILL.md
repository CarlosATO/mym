# Financial Domain Rules

## Alcance

Estas reglas aplican exclusivamente a `Análisis Comercial -> Control Financiero`.
No redefinen las reglas de otros módulos de PetGroup.

## Principios fundamentales

- Estado de Resultados mide rentabilidad económica.
- Flujo de Caja mide entradas, salidas y disponibilidad real.
- Caja no equivale a utilidad.
- Resultado final no equivale a saldo disponible.
- Venta no implica necesariamente cobro.
- Compra no implica necesariamente pago.
- CxC, CxP, documentos comerciales y movimientos bancarios son conceptos diferentes.

## Estado de Resultados

Estructura conceptual:

```text
Ventas netas
- Costo de ventas
= Margen bruto
- Gastos operacionales
= Resultado operacional
- Gastos financieros
+ Otros ingresos
- Otros egresos
= Resultado final
```

Reglas:

- Trabajar por devengo.
- Consultar por período, empresa y, explícitamente, consolidado cuando corresponda.
- Comprar mercadería no significa reconocer gasto inmediatamente.
- Costo de Ventas corresponde a productos efectivamente vendidos.
- IVA recuperable no forma parte del P&L.
- Capital recibido mediante crédito no es ingreso operacional.
- Amortización de capital no es gasto financiero.
- Intereses y cargos financieros sí pueden afectar resultado cuando corresponda.
- Movimientos puramente financieros no deben alterar artificialmente la rentabilidad.

## Mercadería y costos

- Compras netas sirven para análisis de Capital de Trabajo.
- Compras menos Costo Vendido es un indicador gerencial.
- No presentarlo automáticamente como variación exacta de inventario.
- Inventario exacto requiere valorización confiable.
- COGS gerencial puede diferir del costo fuente solamente mediante ajuste explícito.
- Todo ajuste debe conservar original, delta, corregido, motivo, fuente y usuario/proceso cuando corresponda.
- Para análisis de productos no asumir que SKU por sí solo siempre identifica correctamente una entidad analítica.
- Preservar SKU, producto y variante cuando la fuente lo permita.

## Fechas y períodos

Distinguir:

- fecha fuente;
- fecha efectiva;
- período gerencial;
- eventualmente período contable.

Un documento puede pertenecer a una fecha fuente y a un período gerencial distinto.

- YTD suma solamente períodos disponibles.
- No crear meses futuros con cero como si fueran datos reales.
- Los períodos parciales deben identificarse explícitamente.
- Un mes pasado no es parcial simplemente porque el último movimiento no ocurrió el último día calendario.
- No hardcodear un mes concreto, como septiembre de 2026, como regla permanente.

## Caja

Fórmula conceptual:

```text
Saldo inicial + Entradas - Salidas = Saldo final
```

- Los movimientos bancarios representan caja.
- Transferencias entre cuentas propias no generan ni consumen caja consolidada.
- Las transferencias internas deben permanecer trazables.
- Deben neutralizarse simétricamente en la lectura gerencial consolidada.
- Neutralizarlas no puede alterar el saldo final.
- Movimientos personales pueden afectar caja sin representar gasto operacional.

Debe poder distinguirse:

- flujo bancario bruto;
- flujo gerencial externo.

## Intercompany

Control Financiero debe soportar empresa individual y eventual consolidación de empresas autorizadas.

- Movimientos intercompany permanecen visibles en vistas individuales.
- Se neutralizan donde corresponda en consolidación.
- Nunca se pierde trazabilidad.
- Una transferencia intercompany no es automáticamente una venta o gasto operacional consolidado.
- Desde la vista individual de AMIMASCOTA, CAYLO puede actuar como proveedor real y debe conservar tratamiento diferenciado.
- Mantener separadas la relación comercial/intercompany CAYLO y el financiamiento propio de AMIMASCOTA.
- No convertir descripciones bancarias históricas concretas en reglas universales.
- Si en el futuro existen mappings de descripciones bancarias, deben ser configurables y trazables.

## Conciliación y revisión

No interpretar `source_review_required = desconocido` como una categoría económica.

Distinguir:

1. Naturaleza económica identificada, con validación documental pendiente.
2. Contraparte pendiente de conciliación.
3. Movimiento sin clasificación confiable.

Los movimientos conocidos deben permanecer en su categoría aunque necesiten validación.
Los realmente pendientes deben mostrarse con cantidad y monto.

## Integridad monetaria

- Utilizar precisión decimal apropiada.
- Evitar floats binarios para cálculos financieros.
- Preservar empresa, fecha, origen, descripción, referencia y trazabilidad.
- No borrar movimientos históricos silenciosamente.
- Las anulaciones y correcciones deben conservar historia.
- Categorías financieras y centros de costo deben evolucionar hacia estructuras configurables.

## Prototipo validado

El prototipo financiero es fuente de reglas, comportamiento gerencial, sistema visual, trazabilidad, separación P&L/Caja/Capital de Trabajo, multiempresa, matrices, drawer y controles de integridad.

No trasladar SQLite, rutas locales, ETL local, `localhost`, `dev.sh`, nombres históricos, montos hardcodeados ni decisiones técnicas temporales usadas para reconstruir historia.

Casos históricos como Boulevard 4897, DPI069, SKU 2002, archivos Excel o meses concretos no son reglas permanentes.
