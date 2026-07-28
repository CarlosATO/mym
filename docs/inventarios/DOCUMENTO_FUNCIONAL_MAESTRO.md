# Documento Funcional Maestro - Modulo Inventarios

## 1. Proposito del documento

Este documento define oficialmente el funcionamiento esperado del modulo Inventarios de PetGrup. Sera la base para disenar posteriormente la arquitectura, el modelo de datos, las reglas de seguridad, la logica backend, la interfaz web, la aplicacion Android, la integracion con Bsale y la exportacion por Excel.

No debe interpretarse todavia como una especificacion tecnica de tablas, componentes o endpoints.

## 2. Filosofia del modulo

El modulo Inventarios busca transformar una toma de inventario empirica, lenta y propensa a errores en un proceso estructurado, recurrente, controlado, auditable, escalable, trazable y seguro.

El problema que busca resolver no es unicamente contar productos. Debe permitir planificar inventarios, asignar responsabilidades, dividir fisicamente la bodega, evitar dobles conteos, registrar avance, capturar incidencias, consolidar cantidades automaticamente, administrar reconteos, investigar diferencias, identificar perdidas, valorizar faltantes y sobrantes, generar evidencia historica y preparar el resultado oficial para Bsale.

El objetivo final es mejorar la exactitud del inventario, detectar perdidas de mercaderia y permitir que MYM realice inventarios de forma mas frecuente y profesional. PetGrup administrara todo el proceso. En esta primera etapa Bsale seguira siendo la fuente oficial de stock y el sistema donde finalmente se cargara el resultado aprobado.

## 3. Principios fundamentales

- El modulo sera nativo de PetGrup; no sera un sistema independiente.
- Utilizara autenticacion, empresas, usuarios, roles y auditoria existentes.
- En la primera version Bsale sera la fuente oficial de stock; el Kardex local no sera la fuente oficial del inventario.
- La aplicacion Android solo capturara datos: nunca modificara stock ni se conectara directamente con Bsale.
- Los ajustes y exportaciones se realizaran exclusivamente desde el portal web.
- Ningun conteo sera eliminado fisicamente; toda correccion conservara el historial anterior.
- La logica debe quedar preparada para reutilizarse posteriormente.
- En la primera version el resultado se entregara mediante Excel compatible con Bsale. La sincronizacion directa con Bsale solo se evaluara en una fase posterior.

## 4. Alcance de la primera version

La primera version permitira inventarios generales y parciales; una unica sucursal logica de Bsale; una unica bodega oficial de stock Bsale; conteo por SKU; codigo de barras; busqueda manual; asignacion por zonas; conteos multiples del mismo SKU en diferentes zonas; reconteos; incidencias; productos danados o vencidos; fotografias; consolidacion; valorizacion; aprobacion; exportacion Excel y conciliacion posterior contra Bsale.

No incluira lotes, vencimientos operativos por lote, FEFO, dispositivos autorizados, sincronizacion directa de la toma mediante API, uso del Kardex local como stock oficial, creacion automatica de productos ni modificacion directa de otros modulos.

## 5. Ciclo de vida de una jornada

### 5.1 Estados de una jornada

| Estado | Descripcion |
| --- | --- |
| `DRAFT` | Jornada creada; aun puede configurarse. |
| `PREPARED` | Tiene bodega, alcance, snapshot, zonas, usuarios y asignaciones; esta lista para iniciar. |
| `COUNTING` | El conteo fisico esta en ejecucion. |
| `UNDER_REVIEW` | Finalizaron las tareas principales y el supervisor revisa diferencias, incidencias, reconteos, costos y resultado final. |
| `APPROVED` | La jornada fue aprobada y queda inmutable. |
| `EXPORTED` | Se genero el archivo oficial para Bsale. |
| `RECONCILED` | El inventario fue cargado en Bsale y validado contra el stock oficial. |
| `CANCELLED` | La jornada fue cancelada por un usuario autorizado; nunca se elimina fisicamente. |

## 6. Ciclo de vida de una tarea de zona

Estados: `ASSIGNED`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `VALIDATED`, `REOPENED`, `REASSIGNED`, `INVALIDATED` y `CANCELLED`.

Reglas:

- Solo puede existir una tarea activa por zona.
- Un usuario puede tener varias zonas asignadas, pero solo puede mantener una zona abierta simultaneamente.
- Al finalizar una zona, el contador pierde permiso de edicion.
- El supervisor puede reabrir una zona solo con motivo; toda reapertura debe quedar auditada.
- Una reasignacion no borra lo previamente contado.
- Si un conteo se invalida, sus registros se conservan como evidencia.
- Una zona cerrada solo puede volver a trabajo mediante autorizacion del supervisor.

## 7. Roles funcionales

### 7.1 Contador

Puede iniciar sesion en la App; ver sus tareas; abrir una zona asignada; escanear zona y productos; buscar productos; ingresar cantidades; corregir sus registros mientras la zona este abierta; registrar productos repetidos; reportar incidencias; tomar fotografias; pausar, reanudar y finalizar una zona.

No puede ver stock teorico, diferencias, conteos de otras zonas, costos ni valorizaciones. Tampoco puede asignar o reabrir zonas, modificar registros de otros usuarios, aprobar, exportar, cancelar la jornada ni modificar Bsale.

### 7.2 Supervisor

Puede asignar y reasignar zonas; pausar tareas; anular asignaciones; reabrir zonas; revisar avance, conteos e incidencias; solicitar y asignar reconteos; decidir el conteo definitivo y preparar la jornada para aprobacion. No debe aprobar el inventario final salvo que tenga tambien un rol superior autorizado.

### 7.3 Administrador o superusuario

Puede crear e iniciar jornadas, definir alcance, cancelar jornadas, administrar asignaciones, supervisar, resolver incidencias, aprobar, exportar, confirmar carga en Bsale, conciliar y gestionar configuracion.

### 7.4 Gerencia

Puede consultar resultados, indicadores, diferencias y valorizaciones; puede aprobar solo cuando tenga el permiso correspondiente. Gerencia no recibe automaticamente todos los permisos operativos.

## 8. Creacion de una jornada

Solo el superusuario o administrador autorizado puede crear una jornada. Debe solicitar nombre, tipo de inventario, empresa, sucursal Bsale, bodega, responsable principal, observaciones, zonas incluidas, usuarios participantes y, cuando sea parcial, productos incluidos.

La jornada no se programara inicialmente para una fecha futura: se crea y se inicia manualmente despues.

## 9. Inicio de la jornada

Cuando el superusuario presiona **Iniciar inventario**, el sistema debe validar catalogo, sincronizar o consultar Bsale, capturar el stock oficial, generar un snapshot inmutable, capturar el costo de recepcion disponible, validar zonas y asignaciones, habilitar tareas moviles y registrar fecha y hora oficial de inicio.

El snapshot no debe cambiar durante la jornada.

## 10. Organizacion fisica

La estructura fisica prevista sera:

```text
Bodega
└── Pasillo o sector
    └── Rack
        └── Nivel o altura
            └── Zona
```

Tambien pueden existir pasillos sin rack, espacios de piso, patios, zonas sin nivel y zonas especiales. Cada zona debe tener identificador unico, codigo visible, QR o codigo de barras, nombre, bodega, pasillo, rack, nivel, estado y relacion con Logistica.

Inventarios puede consultar las ubicaciones de Logistica, pero no puede modificarlas sin autorizacion explicita.

## 11. Asignacion de zonas

El supervisor selecciona una zona y la asigna a un usuario.

- Una zona no puede asignarse simultaneamente a dos usuarios y queda bloqueada al asignarse.
- Un usuario puede recibir varias zonas, pero solo abrir una a la vez.
- La App valida que el QR corresponda a la zona asignada; de otro modo debe impedir el inicio.
- El supervisor puede reasignar o invalidar un conteo. Ambos casos conservan los datos y la evidencia historica.

## 12. Flujo de trabajo en la App

### 12.1 Inicio

El usuario inicia sesion, selecciona el inventario activo y una tarea asignada, se dirige fisicamente a la zona, ordena el sector y escanea su QR. La App valida la asignacion y abre la zona. No necesita escanear nuevamente la zona por cada producto.

## 13. Conteo fisico

El usuario cuenta fisicamente, escanea un producto, la App lo identifica y muestra nombre, SKU, presentacion, codigo e imagen cuando exista. El usuario verifica el producto, ingresa cantidad, recibe una solicitud de confirmacion y continua con el siguiente producto.

Ejemplo: `Producto: Alimento para gato 10 kg`, `Cantidad ingresada: 8`, `Desea confirmar este registro?`

La App nunca debe mostrar stock Bsale, diferencias, conteos de otras zonas, costos ni valorizaciones.

## 14. Producto repetido en la misma zona

La App debe advertir: **Este producto ya fue registrado en esta zona.** Las opciones son:

- **Agregar cantidad:** genera un aporte independiente y lo suma al consolidado.
- **Corregir registro anterior:** actualiza logicamente el registro y conserva cantidad anterior, cantidad nueva, usuario, fecha y motivo.
- **Cancelar.**

Nunca se reemplaza un registro silenciosamente.

## 15. Producto repetido en otra zona

Si el mismo SKU aparece en otra zona, se registra normalmente sin advertencia, como conteo independiente. El consolidado general suma todas las zonas. Ejemplo: Zona A, SKU 100, 5 unidades; Zona B, SKU 100, 3 unidades; total fisico, 8 unidades. Ningun usuario modifica el total global.

## 16. Productos sin codigo

El usuario puede buscar por SKU, nombre, marca o descripcion, verificar visualmente y registrar la cantidad si esta seguro. Si no puede identificarlo con certeza, debe separarlo fisicamente, crear una incidencia, agregar fotografia y no asociarlo arbitrariamente.

## 17. Codigos alternativos

El sistema debe quedar preparado para mantener mas de un codigo por producto. Un codigo asociado se reconoce normalmente. Si no esta asociado, se genera una incidencia para que el supervisor la resuelva o se mapee posteriormente. No debe asumirse que un codigo desconocido corresponde a un producto conocido.

## 18. Incidencias

Incidencias iniciales: producto sin codigo, codigo desconocido, producto no identificado, producto danado, producto vencido, caja abierta, envase deteriorado, producto mezclado, producto fuera de zona, discrepancia visual y otro.

Cada incidencia puede registrar jornada, zona, producto, cantidad, categoria, observacion, usuario, fecha, fotografia, estado y resolucion.

## 19. Condicion del inventario

Los productos danados o vencidos forman parte del conteo fisico, pero no se mezclan con stock utilizable. El sistema debe distinguir cantidad fisica, disponible, danada, vencida, bloqueada y con otra condicion. La suma de condiciones debe coincidir con la cantidad fisica.

Ejemplo: cantidad fisica 10; disponible 8; vencida 2.

## 20. Fotografias

Las fotografias se almacenaran en un contenedor o bucket especifico. Cada archivo debe relacionarse con empresa, jornada, zona, tarea, usuario, producto, incidencia y fecha. No seran obligatorias por cada producto, pero si obligatorias o recomendadas en incidencias relevantes.

## 21. Cierre de zona

Antes de cerrar, la App muestra zona, cantidad de SKU, unidades registradas, incidencias, registros pendientes de sincronizacion, fotografias pendientes y advertencias. El usuario confirma expresamente. Luego pierde permiso de edicion, la zona queda `COMPLETED`, los conteos pasan al consolidado y el supervisor puede validarla o reabrirla.

## 22. Reapertura de zona

Solo el supervisor puede reabrir una zona cerrada. Debe solicitar motivo, registrar autorizador y fecha, conservar conteos anteriores, marcar la tarea `REOPENED` y devolver la edicion al usuario asignado. La historia nunca se elimina ni reemplaza.

## 23. Reasignacion o abandono

Si un usuario abandona una zona, el supervisor puede pausarla, reasignarla, invalidar el conteo o iniciar una nueva tarea. La reasignacion no elimina datos. Si los datos anteriores no se utilizaran, se marcan invalidados, conservan historial y el nuevo conteo queda relacionado como reemplazo.

## 24. Reconteos

Cualquier producto con diferencia puede enviarse a reconteo por decision del supervisor. Puede aceptar el primer conteo, solicitar segundo o tercero, seleccionar cantidad definitiva y justificarla.

El reconteo debe ser ciego: no muestra Bsale ni conteos anteriores, idealmente lo realiza otra persona, no calcula promedio automatico y la cantidad final siempre se selecciona explicitamente. Toda decision queda auditada.

## 25. Revision del supervisor

El supervisor debe revisar zonas asignadas, en proceso, finalizadas, reabiertas e invalidadas; SKU contados, no encontrados y adicionales; productos no identificados; diferencias; incidencias; fotografias; vencidos; danados; reconteos; correcciones; registros pendientes de sincronizacion y actividad por usuario.

## 26. KPIs de avance

El sistema debe mostrar zonas totales, asignadas, en proceso, terminadas y pendientes; porcentaje de avance; tiempo promedio por zona; tiempo total y productividad por usuario.

## 27. KPIs de cobertura

Debe mostrar SKU del snapshot, SKU contados, SKU sin conteo, SKU adicionales, porcentaje de cobertura, SKU con incidencia y SKU con reconteo.

## 28. KPIs de exactitud

Debe mostrar SKU sin diferencia, SKU con diferencia, unidades faltantes, unidades sobrantes, exactitud por SKU, por unidades y valorizada. La formula exacta se definira posteriormente en el diseno de reglas y analitica.

## 29. KPIs por condicion

Debe mostrar unidades disponibles, danadas, vencidas y bloqueadas; valor de productos danados, vencidos y total no disponible.

## 30. Valorizacion

El criterio inicial sera el costo neto de recepcion. Por SKU se mostrara stock teorico, stock fisico, diferencia, costo neto, valor faltante, valor sobrante, valor danado, valor vencido e impacto neto.

Los sobrantes no deben interpretarse automaticamente como ganancia: pueden ser errores historicos de recepcion, despacho, conteo, registro, devolucion o configuracion.

## 31. Aprobacion

Puede aprobar un superusuario, administrador autorizado o gerencia con permiso de aprobacion. El sistema impide aprobar si hay zonas sin finalizar, tareas activas, datos sin sincronizar, incidencias criticas pendientes, productos sin identificar, reconteos pendientes, diferencias sin decision, inconsistencias del snapshot o resultados incompletos.

Al aprobar, la jornada queda bloqueada, genera una version oficial, sus resultados quedan inmutables y pasa a `APPROVED`. Una jornada aprobada no se edita; toda correccion posterior genera una revision o nuevo proceso.

## 32. Exportacion hacia Bsale

La primera version utilizara Excel:

```text
Inventario aprobado
→ Generar archivo
→ Descargar archivo
→ Importar en Bsale
→ Revisar toma
→ Finalizar en Bsale
→ Ejecutar sincronizacion
→ Consultar stock Bsale
→ Comparar contra resultado aprobado
→ Conciliar
```

El archivo compatible con Bsale debe incluir como minimo SKU y stock fisico final. PetGrup tambien genera reportes complementarios con descripcion, stock teorico, stock fisico, diferencia, costo, valorizacion, condicion, incidencias y observaciones.

## 33. Archivos de salida

El modulo debe generar archivo compatible con Bsale, consolidado general, diferencias positivas, diferencias negativas, productos danados, productos vencidos, incidencias, reporte valorizado y evidencia de auditoria.

## 34. Conciliacion con Bsale

Despues de la carga, PetGrup ejecuta o espera la sincronizacion oficial, consulta stock Bsale, compara el resultado con la version aprobada y muestra coincidencias y diferencias. Solo cuando coincida o se justifique, pasa a `RECONCILED`.

La conciliacion deja evidencia de fecha, usuario, stock aprobado, stock Bsale, diferencias y observaciones.

## 35. Auditoria

Debe registrarse creacion, configuracion, snapshot, inicio, asignacion, reasignacion, apertura de zona, pausa, reanudacion, conteo, correccion, incidencia, fotografia, cierre, reapertura, invalidacion, reconteo, decision final, aprobacion, exportacion, confirmacion de carga, conciliacion y cancelacion.

Ningun registro historico se elimina fisicamente.

## 36. Reglas de negocio obligatorias

- Un usuario no puede abrir dos zonas simultaneamente; una zona no puede tener dos tareas activas.
- El contador no ve stock teorico ni costos.
- El snapshot es inmutable.
- Cada conteo pertenece a zona, producto, usuario y jornada; los totales son calculados y ningun usuario edita el total global.
- Una zona cerrada solo se reabre con autorizacion.
- Toda correccion conserva el valor anterior; toda reasignacion conserva historial; una asignacion anulada no elimina datos.
- Una jornada aprobada queda inmutable.
- La App no modifica Bsale ni stock; solo el portal genera el resultado oficial.
- Toda diferencia e incidencia critica debe resolverse.
- La exportacion siempre pertenece a una version aprobada.
- No se elimina fisicamente informacion del inventario.

## 37. Trabajo sin conexion

La App debe almacenar localmente conteos, incidencias, cambios, fotografias pendientes y estados. Al recuperar conexion debe sincronizar automaticamente, reintentar, evitar duplicados, detectar conflictos e informar estado.

Estados sugeridos: `SAVED_LOCAL`, `PENDING_SYNC`, `SYNCING`, `SYNCED` y `SYNC_ERROR`. Un registro no puede mostrarse como sincronizado si no llego correctamente al servidor.

## 38. Casos excepcionales

| Caso | Comportamiento esperado |
| --- | --- |
| Sin conexion | Guardar localmente y sincronizar despues. |
| Telefono sin bateria | Al reingresar, recuperar zona activa y registros locales. |
| Dos usuarios abren la misma zona | El backend rechaza la segunda apertura. |
| Codigo de zona incorrecto | La App impide continuar. |
| Producto desconocido | Crear incidencia. |
| Producto sin codigo | Permitir busqueda manual. |
| Codigo alternativo desconocido | Generar incidencia para mapeo. |
| Exportacion fallida | La jornada sigue aprobada y puede reintentarse. |
| Cambio de stock Bsale durante el conteo | Conservar snapshot original y advertir movimientos posteriores. |
| Conteo invalido | Marcarlo invalidado, nunca eliminarlo. |
| Usuario abandona | Supervisor puede reasignar o iniciar un nuevo conteo. |

## 39. Dependencia con otros modulos

Inventarios puede consultar usuarios, empresas, roles, permisos, productos, costos, sincronizacion Bsale, bodegas y ubicaciones de Logistica. No puede modificar otros modulos sin autorizacion explicita.

En particular, puede leer ubicaciones de Logistica pero no alterarla; puede consumir productos de Adquisiciones pero no modificar su catalogo; y puede consumir Bsale Sync, pero no cambiar sus procesos sin autorizacion.

## 40. Resultado esperado

El modulo debe permitir que una empresa pase de un proceso manual, desordenado y dependiente de papeles a uno planificado, movil, multiusuario, controlado por zonas, sin sobrescritura de conteos, con consolidacion automatica, reconteos, evidencia, valorizacion, auditoria y compatibilidad con Bsale.
