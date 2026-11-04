# PETGROUP / MYM - MEJ-01
## Alineación funcional de incidencias de preparación y auditoría

> Documento temporal y obligatorio para cualquier trabajo posterior de MEJ-01.
> No constituye una implementación ni autoriza cambios en código, Bsale o Supabase.

## 1. Principio Fundamental

Las incidencias son un proceso paralelo al pedido original.

Una incidencia no debe impedir que los operadores terminen la preparación ni que cierren correctamente la auditoría física. Su función es informar que existe una diferencia comercial pendiente de corregir en Bsale.

La restricción se aplica antes de habilitar la facturación, no durante el trabajo físico de bodega.

## 2. Incidencias Detectadas Durante Preparación

Ejemplo:

- Bsale solicita 41 unidades.
- El operador encuentra y prepara 40.
- Declara que falta 1 unidad.

Comportamiento requerido:

1. PetGroup registra el faltante.
2. Se crea una incidencia comercial.
3. Aparece una tarjeta asociada al pedido en la columna **Incidencias**.
4. La tarjeta original permanece en **Preparación**.
5. El operador continúa trabajando normalmente con el pedido.
6. Cuando corresponda, puede finalizar la preparación y enviarlo a Auditoría.

La incidencia se genera al declarar un faltante real, no simplemente porque el pedido todavía esté en preparación.

## 3. Incidencias Detectadas Durante Auditoría

Si el auditor descubre que falta un producto o existe una cantidad inferior a la solicitada en Bsale:

1. Se registra la diferencia.
2. Se crea o actualiza la incidencia comercial correspondiente.
3. La tarjeta de incidencia aparece en la columna **Incidencias**.
4. La tarjeta original permanece en **Auditoría**.
5. El auditor puede corregir y terminar su revisión física.
6. La auditoría puede cerrarse normalmente cuando las cantidades físicas verificadas coinciden con las preparadas.

Una auditoría físicamente conforme no significa que el pedido esté comercialmente conciliado con Bsale.

## 4. Bloqueo Exclusivo de Facturación

Una tarjeta puede estar correctamente auditada y mantener una incidencia comercial pendiente.

En ese caso:

- La auditoría permanece cerrada.
- No se pierden los conteos ni el historial.
- No se retrocede artificialmente la tarjeta a Preparación.
- El pedido no puede quedar habilitado para facturación hasta conciliarse con la NV vigente.

La protección debe existir también en la prevalidación efectiva de facturación.

No es suficiente comprobar únicamente que no haya incidencias con estado `OPEN`, porque una incidencia podría haber sido resuelta incorrectamente.

## 5. Procedimiento del Administrador

El administrador accede a la columna **Incidencias**.

La tarjeta debe mostrar claramente:

- Número de Nota de Venta.
- Cliente.
- Producto y SKU.
- Cantidad solicitada en Bsale.
- Cantidad realmente preparada/auditada.
- Diferencia.
- Acción comercial requerida: reducir cantidad o eliminar línea.
- Estado de la incidencia.

El administrador:

1. Revisa la incidencia.
2. Ingresa a Bsale.
3. Modifica manualmente la Nota de Venta.
4. Reduce las cantidades o elimina las líneas faltantes.
5. Guarda la NV en Bsale.
6. Regresa a PetGroup.
7. Presiona el botón **Sincronizar**.

PetGroup nunca debe modificar la Nota de Venta en Bsale por sí mismo.

## 6. Comportamiento del Botón Sincronizar

Al presionarlo:

1. Consulta efectivamente la NV vigente desde Bsale, evitando utilizar datos locales desactualizados como prueba suficiente.
2. Identifica correctamente la versión comercial actual.
3. Compara el conjunto completo de productos y cantidades de la NV contra la preparación y auditoría física.
4. Considera líneas eliminadas, cantidades modificadas, productos repetidos e identificadores de líneas que cambian entre versiones.
5. Si todo coincide, marca la incidencia como `RESOLVED/MATCHED`.
6. Si todavía existe una diferencia o no puede demostrarse la coincidencia, conserva la incidencia `OPEN/MISMATCHED` y explica el problema.

La incidencia resuelta desaparece de la columna de incidencias activas, pero mantiene su historial.

El botón no debe aprobar incidencias de manera manual o forzada.

Si el pedido todavía está en Preparación o Auditoría, resolver la incidencia no debe adelantarlo artificialmente a facturación.

## 7. Organización de Incidencias

Para facilitar la gestión administrativa, la columna **Incidencias** debería presentar una tarjeta por pedido/NV que agrupe las líneas comerciales pendientes.

No es necesario cambiar la estructura de almacenamiento existente si ya permite varias incidencias por línea.

Se deben evitar incidencias duplicadas al repetir una operación o sincronización.

## 8. Diagnóstico Técnico Existente

### Creación

- `logistica.confirm_sales_order_preparation_line`

### Verificación y resolución

- `logistica.verify_open_preparation_incidents_v1`

### Elegibilidad

- `logistica.vw_sales_order_route_readiness`
- `logistica.get_sales_order_route_readiness_v1`

### Prevalidación de facturación

- `logistica.invoice_attempt_prevalidate`
- `logistica.begin_sales_order_invoice_submission`

### Cierre físico

- `logistica.finalize_sales_order_audit`

Hallazgo principal:

En el caso `REMOVE_LINE`, la lógica puede interpretar `match_count = 0` como evidencia de que una línea ya fue eliminada de Bsale.

Esto es insuficiente si la línea sigue existiendo, pero no se encuentra debido a diferencias de `detail_id`, variante, SKU o versión de NV.

Adicionalmente, el acceso a facturación depende de que no existan incidencias `OPEN` y no siempre valida nuevamente todas las cantidades contra la NV actual.

No afirmar que esta fue la causa histórica exacta de la NV #5150 sin evidencia adicional. Es el mecanismo de fallo identificado en el código.

## 9. Caso Histórico de Referencia

NV #5150:

- Bsale solicitaba 41 unidades.
- Se prepararon y auditaron 40.
- SKU `43165`: 1 solicitado, 0 preparado.
- Se creó una incidencia `LINE_EXCLUDED`, acción `REMOVE_LINE`.
- La incidencia quedó resuelta prematuramente.
- Posteriormente se corrigió la Nota de Venta en Bsale.

Este caso es únicamente evidencia histórica. No debe modificarse, reprocesarse ni usarse para pruebas con escrituras.

## 10. Reglas de Protección

- Bsale es la fuente de verdad comercial.
- PetGroup registra cantidades físicas e incidencias.
- No se recalculan precios, impuestos ni descuentos para resolver incidencias.
- No se alteran auditorías físicas correctas.
- La sincronización no modifica Bsale.
- No se consideran equivalentes líneas diferentes sin identidad demostrable.
- Las diferencias ambiguas permanecen pendientes de revisión.
- No se pierde el historial de incidencias resueltas.
- Una incidencia no se resuelve solamente porque terminó la auditoría.
- Una incidencia resuelta erróneamente no puede habilitar una factura sin nueva verificación comercial.

## 11. Implementación Posterior

La división mínima orientativa del desarrollo es:

- **MEJ-01B:** corregir la lógica de verificación y resolución comercial.
- **MEJ-01C:** reforzar la protección de elegibilidad y prevalidación de facturación.
- **MEJ-01D:** incorporar el botón **Sincronizar** y su resultado operativo.

La división es orientativa. No realizar estas implementaciones como parte de este documento.

Antes de desarrollar, cada agente debe leer este documento y trabajar solamente en el bloque funcional autorizado.

## 12. Naturaleza Temporal del Documento

Este archivo es temporal.

- No incluirlo en despliegues de producción.
- No convertirlo en documentación permanente por defecto.
- No eliminarlo mientras MEJ-01 esté en desarrollo.
- Al completar y validar funcionalmente MEJ-01, solicitar autorización para eliminarlo.
- La eliminación debe incluirse en la limpieza final del trabajo.

## 13. Observaciones Respecto del Sistema Actual

Estas observaciones describen el estado existente y no constituyen cambios aprobados:

- `finalize_sales_order_audit` valida el cierre físico y puede dejar la tarjeta en `AUDITED` sin resolver la conciliación comercial.
- `verify_open_preparation_incidents_v1` es el proceso que cambia una incidencia de `OPEN` a `RESOLVED` cuando clasifica el resultado como `MATCHED`.
- `vw_sales_order_route_readiness` deriva la disponibilidad principalmente a partir de incidencias con estado `OPEN` y de la existencia/estado de la NV vigente.
- `invoice_attempt_prevalidate` comprueba incidencias abiertas y condiciones generales de la NV, pero no constituye por sí sola una comparación completa de cada cantidad actual contra las cantidades preparadas y auditadas.
- La verificación de una NV vigente debe distinguir entre una línea realmente eliminada y una línea existente que no pudo emparejarse de forma inequívoca.
- Cualquier corrección posterior debe conservar el cierre físico, el historial y la identidad comercial de la tarjeta.

## Restricciones de Esta Referencia

- No modificar código, SQL, migraciones, UI, permisos ni pruebas basándose únicamente en este documento.
- No tocar producción, Bsale o Supabase.
- No reprocesar la NV #5150.
- No iniciar MEJ-01B, MEJ-01C ni MEJ-01D sin autorización específica.
