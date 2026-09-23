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

Una Nota de Venta pendiente podrá ser tomada por un bodeguero.
Conceptualmente el estado pasa de:
`PENDING_ROUTE_PREP` → `IN_PREPARATION`

La futura implementación deberá garantizar mediante mecanismos de locking que una NV es tomada por un solo preparador activo simultáneamente, debido a que el locking actual es insuficiente.

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

Una diferencia documentada durante la preparación y confirmada por Auditoría se clasifica como `FALTANTE / DISPONIBILIDAD`, **NO** como `ERROR DE PREPARACIÓN`.
Un `ERROR DE PREPARACIÓN` ocurre cuando lo declarado por el bodeguero difiere de lo hallado posteriormente por el auditor.

---

## 8. Finalizar Preparación

El botón `FINALIZAR PREPARACIÓN` puede utilizarse aunque existan faltantes. No se exige completar todas las líneas.

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

## 9. Fotografía Operacional (Congelado al Finalizar)

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

1. Modificación de NV Bsale ante faltantes.
2. Regla de facturación cuando preparado < solicitado.
3. NV modificada mientras está siendo preparada.
4. NV anulada mientras está siendo preparada.
5. Política de sustitución comercial de productos.
6. Estado definitivo posterior a Auditoría.
7. Escalamiento por múltiples ciclos de corrección.

---

# BLOQUE 2 · AUDITORÍA DE NOTAS DE VENTA

## 1. Contexto Funcional Heredado de Picking
Al ingresar a Auditoría ya debe existir una fotografía operacional congelada con la cantidad solicitada, cantidad preparada, faltantes declarados, motivos, ubicaciones utilizadas, preparador, timestamps y barcodes descubiertos.
Conceptualmente el estado pasa de:
`IN_PREPARATION` → `IN_AUDIT`

La Auditoría **NO** debe modificar retrospectivamente los datos originales declarados durante Picking, sino agregar su propia capa de verificación.

## 2. Principio Central: Auditoría Parcialmente Ciega
El auditor debe conocer: NV, cliente, SKU, producto solicitado y cantidad solicitada.
Antes de realizar su propio conteo **NO debe ver**: cantidad preparada, faltante declarado, ni resultado esperado según Picking, para evitar confirmaciones visuales automáticas.

El auditor primero escanea, cuenta, registra y confirma.
Después de confirmar la línea, el sistema muestra la comparación: `SOLICITADO` | `PREPARADO` | `AUDITADO`.

## 3. Toma de Auditoría e Independencia
Una NV en `IN_AUDIT` podrá ser tomada por un auditor.
Se debe garantizar que una NV es tomada por un solo auditor activo simultáneamente.
**Regla de independencia:** El mismo usuario que preparó una NV NO debe auditar esa misma NV (salvo excepción futura autorizada).

## 4. Información Inicial Mostrada al Auditor
Al abrir una NV, mostrar: Folio NV, Cliente, Cantidad total de líneas, Cantidad total solicitada, Cantidad de líneas pendientes, Cantidad de líneas aprobadas, Estado de Auditoría.
Por cada línea pendiente: SKU, Nombre producto, Cantidad solicitada, Estado de la línea.
No mostrar cantidades preparadas ni motivos de faltante hasta que el auditor confirme su resultado.

## 5. Validación Obligatoria Mediante Barcode
Para auditar, el trabajador debe escanear el producto físico.
* **CASO A (Correcto):** Permite registrar cantidad física.
* **CASO B (Desconocido):** Pregunta si desea asociar al producto solicitado. Si confirma, se agrega como alias (origen: `WAREHOUSE_AUDIT`) sin invalidar otros ni generar incidencia automática.
* **CASO C (Incorrecto):** Pertenece a otro producto. Bloqueo obligatorio. Constituye una posible incidencia de preparación.

## 6. Conteo Físico y Comparación
El auditor registra exclusivamente lo que existe físicamente. No copia la cantidad solicitada ni la preparada automáticamente.
Al confirmar, el sistema compara:

* **CASO 1: Preparado = Auditado = Solicitado**
  Resultado: `APROBADO`. La línea queda sellada.
* **CASO 2: Preparado = Auditado < Solicitado**
  Resultado: `FALTANTE CONFIRMADO` / `PREPARACIÓN CORRECTA`. No es un error humano, es `FALTANTE / DISPONIBILIDAD`.
* **CASO 3: Preparado > Auditado**
  Resultado: `INCIDENCIA DE PREPARACIÓN`. Hay menos físicamente que lo declarado.
* **CASO 4: Preparado < Auditado**
  Resultado: `INCIDENCIA DE PREPARACIÓN`. Hay más físicamente que lo declarado.
* **CASO 5: Producto incorrecto**
  Resultado: `PRODUCTO INCORRECTO` / `INCIDENCIA OBLIGATORIA`. La línea regresa a corrección.
* **CASO 6: Producto faltante completamente**
  Si Picking declaró > 0 y Auditor encuentra 0 → `INCIDENCIA DE PREPARACIÓN`.
  Si Picking declaró 0 y Auditor encuentra 0 → `FALTANTE CONFIRMADO` / `PREPARACIÓN CORRECTA`.

## 7. Incidencias de Auditoría
Catálogo: `CANTIDAD MENOR A LA DECLARADA`, `CANTIDAD MAYOR A LA DECLARADA`, `PRODUCTO INCORRECTO`, `PRODUCTO DAÑADO`, `PRODUCTO NO ENCONTRADO`, `OTRO` (comentario obligatorio).
La incidencia registra: NV, línea, productos involucrados, cantidades, tipo de incidencia, observación, auditor y fecha/hora.

## 8. Evidencia Fotográfica
* **Foto obligatoria:** `PRODUCTO INCORRECTO`, `PRODUCTO DAÑADO`.
* **Foto opcional:** `CANTIDAD MENOR A LA DECLARADA`, `CANTIDAD MAYOR A LA DECLARADA`, `PRODUCTO NO ENCONTRADO`, `OTRO`.

## 9. Sellado de Líneas y Devolución Focalizada
Una incidencia en una línea **NO** invalida toda la NV. Las líneas aprobadas quedan **SELLADAS** (no requieren volver a prepararse ni auditarse, no se pueden modificar, conservan su resultado).
Las líneas con incidencias regresan a corrección (Conceptualmente: `AUDITORÍA` → `CORRECCIÓN DE PICKING`).
El preparador recibe detalles de la línea, motivo, diferencia, observación y evidencia.

## 10. Corrección y Reauditoría
* **Quién corrige:** Cualquier preparador autorizado (no obliga al original). Conserva trazabilidad.
* **Qué puede hacer:** Solo actuar sobre líneas devueltas. Puede agregar/retirar unidades, reemplazar productos dañados/incorrectos, o corregir cantidad física (confirmando que no existen).
* **Reauditoría obligatoria:** Toda línea corregida regresa a Auditoría (`INCIDENCIA` → `CORRECCIÓN` → `REAUDITORÍA`). Solo se reauditan las corregidas.
* **Quién reaudita:** Cualquier auditor distinto del usuario que realizó la corrección.
* **Ciclos de corrección:** Una línea puede fallar múltiples veces. Se conserva todo el historial sin sobrescribir incidencias anteriores.

## 11. Cierre de Auditoría
* **Sin incidencias:** Si todas las líneas están aprobadas o son faltante confirmado (preparación correcta), se puede `FINALIZAR AUDITORÍA`. Muestra resumen.
* **Con incidencias:** No se permite finalizar si hay líneas pendientes de corrección.
* **Resultado funcional:** Al cerrar, se genera una fotografía definitiva de cantidades, incidencias, correcciones, usuarios, evidencias, timestamps y ciclos de retrabajo.

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
* C → INCIDENCIA DE PREPARACIÓN (vuelve a corrección).
Después: C se corrige, se reaudita, se aprueba. La NV cierra Auditoría.
