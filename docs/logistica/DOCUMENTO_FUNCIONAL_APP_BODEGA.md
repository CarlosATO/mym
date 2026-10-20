# DOCUMENTO FUNCIONAL MAESTRO
# APP BODEGA PETGROUP

**Estado:** EN CONSTRUCCIÓN

**Bloques documentados:**
- Preparación / Picking
- Auditoría

---

## 1. Principio Operativo

La App debe registrar siempre la **realidad física de lo preparado**.

Debe distinguir permanentemente:
* **Cantidad solicitada**
* **Cantidad preparada**
* **Cantidad pendiente/faltante**

Ejemplo:
* Solicitado: 10
* Preparado: 8
* Faltante: 2

Nunca modificar la cantidad solicitada original para hacerla coincidir con la cantidad preparada.

---

## 2. Toma de Nota de Venta

Una Nota de Venta pendiente puede ser tomada por un bodeguero. Al pasar de
`PENDING_ROUTE_PREP` → `IN_PREPARATION` se adquiere el control exclusivo en la
misma transacción: `assigned_user_id`, `locked_by_user_id` y `locked_at`.

Reglas cerradas:

* Una NV en preparación tiene un solo preparador activo.
* El lock se adquiere atómicamente al iniciar preparación; dos usuarios que
  intenten tomarla simultáneamente no pueden ganar ambos.
* Otros usuarios autorizados pueden leer y consultar la NV, pero no modificar
  cantidades, excluir líneas, generar incidencias ni mover la tarjeta.
* La escritura operacional exige ser el propietario del lock, validado en DB.
* Volver a Pendiente o enviar a Auditoría libera el lock, conserva
  `assigned_user_id` y mantiene snapshot, cantidades, incidencias e historial.
* Las tarjetas legacy `IN_PREPARATION` sin responsable quedan en sólo lectura
  hasta que un usuario con `logistica.preparation.manage` las tome.
* El lock no expira por tiempo ni por desconexión; se libera sólo con una
  acción explícita.
* Un usuario con `logistica.preparation.authorize_exception` puede realizar
  takeover de una preparación ajena con motivo obligatorio. El cambio queda
  trazado en `sales_order_preparation_movements` sin borrar historial.
* La sincronización Bsale no modifica ni libera locks.

---

## 3. Información Mínima al Abrir una NV

La pantalla de preparación deberá mostrar como mínimo:
* Número/Folio NV
* Cliente
* Cantidad de líneas
* Cantidad total de unidades
* Estado
* Productos
* SKU
* Nombre producto
* Cantidad solicitada
* Cantidad preparada
* Cantidad pendiente
* Ubicación física sugerida cuando exista

---

## 4. Ubicaciones WMS

La App debe utilizar la información disponible en PetGroup para sugerir dónde buscar el producto.

Un producto puede existir en:
* Una ubicación
* Varias ubicaciones
* Ninguna ubicación conocida

La ausencia de ubicación no debe impedir preparar manualmente el producto si este es encontrado físicamente. Existe un fallback denominado `UBICACIÓN NO INFORMADA` que no bloqueará la preparación.

---

## 5. Validación Mediante Código de Barras

Para preparar un producto, el trabajador debe escanear su barcode. Existen tres casos posibles:

### CASO A — Barcode pertenece al producto solicitado
Resultado: **PRODUCTO CORRECTO**. La App permite registrar la cantidad.

### CASO B — Barcode desconocido
Si el código escaneado no está asociado actualmente a ningún producto PetGroup, se muestra confirmación:
> Código no reconocido.
> ¿Desea asociar este código al producto solicitado?

Debe indicar claramente:
* Barcode escaneado
* SKU
* Producto solicitado

Opciones: `ASOCIAR CÓDIGO` | `CANCELAR`

Si confirma, el barcode se agrega como código adicional válido, no reemplaza el original, tiene efecto inmediato y permite continuar preparando.

### CASO C — Barcode ya pertenece a otro producto
Resultado: **PRODUCTO INCORRECTO**.
Ejemplo: La Nota de Venta solicita Producto A, el código escaneado pertenece a Producto B.
Bloqueo obligatorio. No permitir reasignar automáticamente, sobrescribir ni continuar.

### Regla de Múltiples Códigos
Un mismo producto puede tener el barcode original Bsale más múltiples barcodes adicionales. Todos continúan siendo válidos. Agregar uno nuevo no elimina, reemplaza ni invalida los existentes. Un barcode activo no debe pertenecer simultáneamente a dos productos.

### Trazabilidad de Nuevos Barcodes
Toda asociación creada desde la App identificará al menos: barcode, producto, `bsale_variant_id`, usuario, fecha/hora, origen de la asociación (`WAREHOUSE_PICKING`), y la Nota de Venta donde fue detectado.

---

## 6. Registro de Cantidades

La cantidad preparada puede ser registrada acumulativamente por ubicación y conservar desde dónde fue tomada.

### Caso cantidad exacta
* Solicitado: 10
* Preparado: 10
Resultado: `COMPLETO (10 / 10)`

### Caso cantidad inferior
* Solicitado: 10
* Preparado: 8
Resultado: `FALTANTE (8 / 10)` (Faltan: 2).
Requiere motivo (`SIN STOCK FÍSICO`, `NO ENCONTRADO EN UBICACIÓN`, `PRODUCTO DAÑADO / NO UTILIZABLE`, `OTRO`). `OTRO` requiere comentario. La diferencia no detiene la preparación del resto de la NV.

### Caso cantidad cero
Acción: `NO ENCONTRADO` sin escaneo ficticio. Requiere motivo.
* Solicitado: 10
* Preparado: 0
* Faltante: 10

### Cantidad superior a la solicitada
No permitir sobre-preparación.
Resultado: `CANTIDAD SUPERIOR A LA SOLICITADA`. Nunca permitir `prepared_quantity > requested_quantity`.

---

## 7. Diferencia vs Error Humano

Una diferencia documentada durante la preparación genera una incidencia auditable y se clasifica como `FALTANTE / DISPONIBILIDAD`, **NO** como `ERROR DE PREPARACIÓN`.
Un `ERROR DE PREPARACIÓN` ocurre cuando lo declarado por el bodeguero difiere de lo hallado posteriormente por el auditor.

---

## 8. Finalizar Preparación

Cada línea debe quedar confirmada antes de enviar la tarjeta a Auditoría. Una línea con `prepared_quantity = NULL` sigue pendiente aunque visualmente el input muestre 0, por lo que el sistema bloquea el avance e informa cuántas líneas faltan por confirmar.

Mostrará un resumen:
* Productos completos y con faltantes
* Unidades solicitadas, preparadas y faltantes

Si existen diferencias, mostrar advertencia:
> Esta preparación contiene diferencias.
> [X] productos presentan faltantes.
> La Nota de Venta será enviada a Auditoría con estas diferencias registradas.

Confirmación: `ENVIAR A AUDITORÍA`.
Conceptualmente: `IN_PREPARATION` → `IN_AUDIT`.

---

## 9. Fotografía Operacional (Congelado al Entrar a Preparación)

Debe registrarse:
* Qué pidió la NV
* Qué producto se preparó
* Cuánto se preparó
* Dónde se preparó
* Qué faltó y motivo
* Quién preparó
* Cuándo inició y finalizó
* Barcodes descubiertos durante el proceso

---

## 10. Métricas Futuras Derivadas de Picking

El diseño permitirá medir:
* Tiempo espera antes de tomar NV
* Hora inicio y fin de preparación
* Duración total picking
* Tiempo por línea
* Cantidad líneas y unidades preparadas
* Faltantes y motivos
* Productos no encontrados
* Uso de múltiples ubicaciones
* Barcodes nuevos detectados
* Productividad por preparador

---

## DECISIONES FUNCIONALES CERRADAS

1. Flujo completo de Auditoría.
2. Qué ocurre cuando Auditoría encuentra una cantidad distinta.
3. Devolución al preparador.
4. Reauditoría de líneas corregidas.
5. Política exacta de incidencias y fotografías.

---

## DECISIONES PENDIENTES

1. Emisión administrativa de cambios en Bsale ante faltantes. PetGroup no modifica, elimina, anula ni recrea documentos Bsale en este bloque; el administrador realizará los cambios manualmente.
2. Regla de facturación cuando preparado < solicitado.
3. NV modificada mientras está siendo preparada. El snapshot propio de PetGroup permanece congelado y el espejo Bsale continúa sincronizándose.
4. NV anulada mientras está siendo preparada.
5. Política de sustitución comercial de productos.
6. Estado definitivo posterior a Auditoría.
7. Escalamiento por múltiples ciclos de corrección.

### Reglas actuales de cantidades e incidencias

* `requested_quantity` se congela al crear la fotografía de preparación y nunca se sobrescribe.
* `prepared_quantity` inicia en `NULL`; el 0 visual inicial no significa 0 confirmado.
* Una cantidad exacta confirma la línea sin incidencia. Una cantidad menor o una exclusión exige motivo; `OTRO` exige observación.
* Las líneas excluidas se conservan con `prepared_quantity = 0`, incidencia `LINE_EXCLUDED` y no se consideran despacho físico.
* Confirmar explícitamente `prepared_quantity = 0` y pulsar `Excluir` son la misma operación: ambos exigen motivo, generan `LINE_EXCLUDED` con `REMOVE_LINE`, marcan `excluded_from_dispatch = true` y conservan la línea, el solicitado y el historial.
* Las incidencias confirmadas son inmutables en la práctica: una nueva confirmación deja la anterior como `SUPERSEDED` y crea el nuevo estado activo cuando corresponde.
* La tarjeta puede pasar a Auditoría con incidencias `OPEN`, pero nunca con líneas pendientes. Auditoría recibe sólo las cantidades preparadas y las incidencias quedan disponibles para la futura gestión administrativa.
* La futura reconciliación comparará snapshot, preparado esperado y Bsale observado con estados automática, no coincide o revisión manual. No se implementa aquí.
* La facturación futura no debe ignorar incidencias administrativas pendientes.

---

# BLOQUE 2 · AUDITORÍA DE NOTAS DE VENTA

## 1. Contexto Funcional Heredado de Picking
Al ingresar a Auditoría ya debe existir una fotografía operacional congelada con la cantidad solicitada, cantidad preparada, faltantes declarados, motivos, ubicaciones utilizadas, preparador, timestamps y barcodes descubiertos.
Conceptualmente el estado pasa de:
`IN_PREPARATION` → `IN_AUDIT`

La Auditoría **NO** debe modificar retrospectivamente los datos originales declarados durante Picking, sino agregar su propia capa de verificación.

## 2. Principio Central: AUDITORÍA COMPARATIVA VISIBLE
Auditoría trabaja con tres capas independientes:

* **SOLICITADO:** lo pedido originalmente por el cliente.
* **PREPARADO:** lo declarado por Bodega.
* **AUDITADO:** lo encontrado físicamente por el auditor.

El auditor ve la comparación `SOLICITADO | PREPARADO | AUDITADO` y registra el auditado de forma independiente. La comparación visible no autoriza copiar ni modificar las capas anteriores.

Reglas absolutas:

* `requested_quantity_snapshot` es inmutable desde Auditoría.
* `prepared_quantity_snapshot` es inmutable desde Auditoría.
* `audit_quantity` es un registro nuevo e independiente.
* Auditoría no modifica la NV, no modifica Preparación y no modifica Bsale.

`audit_quantity` usa tres estados de dato:

* `NULL`: línea todavía no auditada.
* `0`: el auditor confirmó físicamente cero.
* `> 0`: cantidad física encontrada.

No existe tope superior contra solicitado ni contra preparado: el auditor puede registrar un exceso físico. Un exceso genera incidencia y nunca cambia la NV.

## 3. Toma de Auditoría e Independencia
Una NV en `IN_AUDIT` puede ser tomada por un auditor mediante una operación atómica con `SELECT ... FOR UPDATE`.

* Sólo un auditor puede modificar una NV simultáneamente.
* Otros usuarios autorizados pueden consultar, pero no escribir.
* El lock de Auditoría es propio y no reutiliza el lock de Preparación.
* El lock no expira por tiempo, heartbeat, desconexión ni cierre de navegador. Se libera sólo con una acción explícita.
* **Independencia obligatoria:** el mismo usuario que preparó la NV no puede auditarla. Se usa `assigned_user_id` de Preparación como identidad del preparador final. El rechazo es: “No puedes auditar una preparación realizada por ti.”
* Un usuario con `logistica.audit.authorize_exception` puede tomar una auditoría ajena con motivo obligatorio. No existe excepción para que el preparador audite su propia NV.

## 4. Información Inicial Mostrada al Auditor
Al abrir una NV, mostrar: Folio NV, Cliente, Cantidad total de líneas, Cantidad total solicitada, Cantidad de líneas pendientes, Cantidad de líneas confirmadas, Estado de Auditoría y responsable actual del lock.

Por cada línea: SKU, Nombre producto, `SOLICITADO`, `PREPARADO` y `AUDITADO`. El auditor registra el auditado sin copiar automáticamente las otras capas.

El snapshot de Auditoría se materializa una sola vez desde `logistica.sales_order_preparation_lines`. Es idempotente y no se rematerializa si la sesión ya existe.

## 5. Validación Obligatoria Mediante Barcode
Para auditar, el trabajador debe escanear el producto físico.
* **CASO A (Correcto):** Permite registrar cantidad física.
* **CASO B (Desconocido):** Pregunta si desea asociar al producto solicitado. Si confirma, se agrega como alias (origen: `WAREHOUSE_AUDIT`) sin invalidar otros ni generar incidencia automática.
* **CASO C (Incorrecto):** Pertenece a otro producto. Bloqueo obligatorio. Constituye una posible incidencia de preparación.

## 6. Conteo Físico y Comparación
El auditor registra exclusivamente lo que existe físicamente. La validación principal es `AUDITADO vs PREPARADO`.

Estados de línea:

* `PENDING`: `audit_quantity IS NULL`.
* `CONFIRMED`: `audit_quantity = prepared_quantity_snapshot`.
* `INCIDENT`: `audit_quantity <> prepared_quantity_snapshot` o existe una incidencia no cuantitativa.

Casos funcionales:

* **Solicitado 5 / Preparado 5 / Auditado 5:** `CONFORME`.
* **Solicitado 5 / Preparado 4 / Auditado 4:** `CONFORME CON PREPARACIÓN`. El faltante contra la NV ya fue declarado por Bodega; no es error de preparación.
* **Solicitado 5 / Preparado 4 / Auditado 3:** `INCIDENCIA`. Hay diferencia entre lo declarado y lo encontrado.
* **Solicitado 2 / Preparado 2 / Auditado 3:** `INCIDENCIA POR EXCESO FÍSICO`. La NV sigue siendo 2; no se agrega la unidad al pedido ni se modifica `requested_quantity` o `prepared_quantity`.
* **Solicitado 2 / Preparado 1 / Auditado 3:** `INCIDENCIA`. Se conservan los tres valores `2 / 1 / 3`.
* **Preparado 0 / Auditado 0:** `CONFORME CON PREPARACIÓN` (incluye líneas excluidas conservadas en el snapshot).
* **Preparado 0 / Auditado > 0:** `INCIDENCIA`.

Una **incidencia física manual** (`WRONG_PRODUCT`, `DAMAGED_PRODUCT`, `PRODUCT_NOT_FOUND`, `OTHER`) siempre deja la línea `INCIDENT`, aunque `AUDITADO = PREPARADO`. No modifica el solicitado, el preparado ni la NV.
`PRODUCT_NOT_FOUND` sólo es válido con `audit_quantity = 0`; con cantidad mayor se rechaza.

## 7. Incidencias de Auditoría
Estructura independiente de las incidencias de Preparación. Catálogo inicial:

* `QUANTITY_LOWER_THAN_PREPARED`
* `QUANTITY_GREATER_THAN_PREPARED`
* `WRONG_PRODUCT`
* `DAMAGED_PRODUCT`
* `PRODUCT_NOT_FOUND`
* `OTHER` (observación obligatoria)

Las diferencias puramente cuantitativas se clasifican automáticamente según `AUDITADO vs PREPARADO`, sin pedir un motivo redundante. Cada incidencia conserva: empresa, auditoría, línea, tarjeta, línea de preparación, solicitado snapshot, preparado snapshot, auditado, diferencia, tipo, observación, estado, auditor y fecha/hora.

Estado inicial `OPEN`. El modelo soporta `RESOLVED` y `SUPERSEDED`; una corrección del propio auditor deja la incidencia anterior como `SUPERSEDED` sin borrar historial.

## 8. Evidencia Fotográfica
* **Foto obligatoria:** `WRONG_PRODUCT`, `DAMAGED_PRODUCT`.
* **Foto opcional:** `QUANTITY_LOWER_THAN_PREPARED`, `QUANTITY_GREATER_THAN_PREPARED`, `PRODUCT_NOT_FOUND`, `OTHER`.

Las imágenes no se guardan en PostgreSQL. Se usa un bucket privado `audit-evidence` con path `{company_id}/{card_id}/{audit_id}/{archivo}` y metadata en `logistica.sales_order_audit_attachments`. El backend impide el pre-cierre si falta evidencia obligatoria.

## 8.1. Bultos y Foto Global
* `package_count` es un dato físico independiente de unidades, productos y líneas. Ejemplo válido: 37 unidades, 18 productos, 2 bultos.
* Se puede registrar o modificar mientras la Auditoría está abierta.
* Sólo puede ser `>= 0` al editarlo; es obligatorio `>= 1` para finalizar la Auditoría.
* La foto global del despacho es opcional, única por sesión y distinta de las fotos por incidencia. Queda preparada para una futura comparación con la foto de entrega del transportista.

## 9. Sellado de Líneas y Devolución Focalizada (diseño futuro)
Una `INCIDENCIA DE AUDITORÍA` en una línea **NO** invalida toda la NV. Las líneas conformes quedan **SELLADAS** y conservan su resultado.
El diseño futuro contempla que las líneas con incidencia regresen a corrección (`AUDITORÍA` → `CORRECCIÓN DE PICKING`). Este bloque no implementa esa transición ni la modificación de Preparación.

## 10. Corrección y Reauditoría (diseño futuro, no implementado)
* **Quién corrige:** Cualquier preparador autorizado (no obliga al original). Conserva trazabilidad.
* **Qué puede hacer:** Solo actuar sobre líneas devueltas. Puede agregar/retirar unidades, reemplazar productos dañados/incorrectos, o corregir cantidad física (confirmando que no existen).
* **Reauditoría obligatoria:** Toda línea corregida regresa a Auditoría (`INCIDENCIA` → `CORRECCIÓN` → `REAUDITORÍA`). Solo se reauditan las corregidas.
* **Quién reaudita:** Cualquier auditor distinto del usuario que realizó la corrección.
* **Ciclos de corrección:** Una línea puede fallar múltiples veces. Se conserva todo el historial sin sobrescribir incidencias anteriores.

## 11. Pre-cierre y Finalización
Existe una validación de pre-cierre (`can_finalize`) que comprueba:

* todas las líneas auditadas;
* ninguna incidencia `OPEN`;
* `package_count >= 1`;
* evidencia fotográfica obligatoria presente en incidencias `WRONG_PRODUCT` y `DAMAGED_PRODUCT`.

El pre-cierre es informativo. La finalización vuelve a validar todo dentro de la misma transacción mediante `logistica.finalize_sales_order_audit`.

Al finalizar correctamente:

* la sesión de Auditoría pasa a `COMPLETED` y registra `completed_at`;
* se libera el lock de Auditoría (`locked_by_user_id` y `locked_at` quedan NULL);
* se conserva `assigned_auditor_user_id`;
* la tarjeta pasa de `IN_AUDIT` a `AUDITED`;
* se conserva `assigned_user_id` del preparador;
* se registra el movimiento `IN_AUDIT → AUDITED` con evento `AUDIT_COMPLETED`, `audit_id`, `package_count`, `auditor_user_id` y presencia de foto global.

`AUDITED` significa que la preparación fue auditada físicamente, sin incidencias abiertas y con cantidad final de bultos definida. No significa facturada, asignada a ruta, cargada ni entregada.

La única vía para entrar a `AUDITED` es finalizar la Auditoría. El drag & drop genérico no permite entrar ni salir de ese estado. Una Auditoría `COMPLETED` es de sólo lectura: no admite confirmar líneas, modificar bultos, agregar evidencias ni tomar lock. Las evidencias históricas siguen siendo consultables.

## 12. Métricas Futuras de Auditoría
El diseño permitirá medir:
* Tiempos: ingreso a cola, espera auditor, inicio/fin, duración total, tiempo por línea, corrección.
* Volúmenes: líneas auditadas, ciclos de retrabajo.
* Incidencias: por NV, por preparador, por tipo (cantidades, producto incorrecto/dañado), fotos.
* KPIs: % picking correcto primer intento, tasa de error de preparación, tasa de faltantes reales, productividad por auditor.

## 13. Ejemplo Funcional Completo (NV 100)
Solicitado: A=10, B=5, C=3
Picking declara: A=10, B=4, C=3
Auditor cuenta: A=10, B=4, C=2
**Resultados:**
* A → APROBADO (sellado).
* B → FALTANTE CONFIRMADO / PREPARACIÓN CORRECTA (sellado).
* C → INCIDENCIA DE AUDITORÍA (diseño futuro: vuelve a corrección).
El cierre de Auditoría sí está implementado para líneas sin incidencias abiertas. El flujo de corrección y reauditoría posterior a una incidencia sigue siendo diseño futuro.
