# Arquitectura Funcional - Inventory Engine

## 1. Objetivo del Inventory Engine

Inventory Engine es un producto funcional reutilizable para administrar inventarios fisicos estructurados, recurrentes, auditables y multiusuario. Resuelve la planificacion, ejecucion, control, consolidacion, valorizacion, aprobacion, exportacion y conciliacion de una jornada de inventario.

No es un ERP, un sistema de movimientos de stock ni un conector de un proveedor especifico. No reemplaza la fuente oficial de stock, no modifica stock directamente y no depende de Bsale. MYM es la primera implementacion del producto; el motor debe servir posteriormente a otras empresas y conectarse a Bsale, SAP, Odoo, Excel u otros proveedores sin alterar su logica central.

Su filosofia es separar el proceso de inventario de las fuentes externas de datos. El Engine administra evidencia, decisiones y resultado oficial; los conectores entregan o verifican informacion externa.

## 1.1 Inventory Engine dentro del ERP

Inventory Engine no sera un sistema independiente. Sera un dominio funcional nativo de PetGrup, compartira la misma base de datos PostgreSQL/Supabase del ERP y su persistencia se ubicara en el esquema `inventarios`.

El Engine conserva sus limites funcionales propios, pero participa de la arquitectura, autenticacion, empresas, permisos, auditoria y navegacion compartidas del ERP.

## 2. Principios arquitectonicos

### Fuente unica de verdad

Durante una jornada, el Snapshot Operacional inmutable es la referencia de stock, catalogo, costos y ubicaciones. La version aprobada es la unica expresion oficial del resultado del Engine. La fuente de stock externa sigue siendo responsabilidad del proveedor configurado para la empresa.

### Separacion de responsabilidades

Cada dominio funcional tiene una responsabilidad unica. El ciclo de vida de una jornada, la captura de conteos, las incidencias, los reconteos, la consolidacion, la valorizacion, la exportacion, la conciliacion y la auditoria no se mezclan.

### Auditoria completa

Toda accion relevante, correccion, transicion, resolucion, rechazo, exportacion, confirmacion y conciliacion debe conservar evidencia historica. Ningun dominio elimina historiales ni reemplaza datos silenciosamente.

### Snapshot inmutable

El Snapshot Operacional se forma antes de iniciar el conteo y nunca cambia. Las modificaciones posteriores de catalogo, ubicaciones, stock o costos externos no alteran la referencia utilizada por la jornada.

### Multiempresa y configuracion por empresa

El Engine opera en el contexto de una empresa. Cada empresa puede configurar proveedor de inventario, sucursal, bodega, reglas operativas, exportaciones y permisos sin cambiar el motor compartido.

### Ownership Rule

Cada esquema es propietario unicamente de su propia informacion:

- `core`: usuarios, empresas y permisos.
- `adquisiciones`: productos, proveedores, costos y bodegas.
- `logistica`: ubicaciones, layouts, Kardex y movimientos.
- `integraciones`: sincronizacion y conectores.
- `inventarios`: jornadas, snapshots, tareas, conteos, incidencias, reconteos, consolidacion, valorizaciones, exportaciones y conciliaciones.

Ningun dominio modifica directamente entidades maestras pertenecientes a otro esquema.

### Consumo de datos maestros

Inventory Engine consume datos de otros dominios mediante referencias. No duplica permanentemente productos, usuarios, ubicaciones, bodegas ni empresas. Cuando debe preservar contexto historico, utiliza el Snapshot Operacional de la jornada.

### Filosofia de integracion

Inventory Engine consume informacion del ERP y no administra informacion maestra. Su responsabilidad comienza cuando se inicia una jornada de inventario.

### Escalabilidad funcional

El Engine soporta inventarios generales, parciales y futuros tipos de conteo sin acoplar su proceso a una bodega, dispositivo, ERP, formato de intercambio o cliente particular.

### Componentes reutilizables

Los dominios que resuelven problemas transversales, como incidencias, evidencia, versionado, exportacion y auditoria, deben poder consumirse por otros productos PetGrup sin transferirles reglas propias de inventario.

### Integraciones desacopladas

El Engine conoce contratos funcionales de proveedores, no Bsale ni otra plataforma concreta. Cada conector traduce operaciones externas hacia y desde esos contratos.

### UI independiente del motor

El portal web y Android son clientes del Engine. Presentan informacion y solicitan operaciones autorizadas; no contienen reglas de consolidacion, aprobacion, exportacion o conciliacion.

### Android como cliente del motor

Android es el cliente operativo de captura. Puede abrir tareas autorizadas, registrar conteos, condiciones, incidencias y evidencias. Nunca modifica stock ni se conecta directamente con un ERP externo.

### Ningun cliente modifica stock directamente

El Engine no escribe stock a un proveedor. La salida es un resultado oficial versionado y, en la primera etapa, un archivo compatible con Bsale. Toda carga externa se verifica por conciliacion.

## 3. Dominios funcionales

### 3.1 Inventory Session

Responsable unicamente de crear jornadas, controlar su ciclo de vida, preparar, iniciar, llevar a revision, aprobar (`inventarios.approve_inventory_session`), cerrar, registrar rectificaciones posteriores y conciliar oficialmente. La aprobacion congela el resultado en `official_versions` y `official_version_items`.

Define el contexto funcional de empresa, alcance, responsable, proveedor, sucursal y bodega. Coordina dominios, pero no cuenta productos, no calcula costos, no genera archivos ni toma decisiones de auditoria.

### 3.2 Snapshot

Responsable unicamente de crear el **Snapshot Operacional** al iniciar una jornada. Preserva productos, stock, costos, ubicaciones, reglas vigentes, configuracion utilizada y usuarios asignados cuando corresponda. Representa exactamente el estado del sistema al inicio y nunca cambia.

No modifica productos, costos, ubicaciones ni fuentes externas. No recalcula datos desde el proveedor durante la jornada.

### 3.3 Assignment

Responsable de tareas, usuarios, zonas, asignaciones y estados operativos. Gestiona asignacion, apertura, pausa, cierre, reapertura, reasignacion, invalidacion y cancelacion de tareas conforme a autorizaciones funcionales.

Garantiza las reglas de exclusividad por zona y por usuario. No conoce stock teorico, costos, diferencias, valorizaciones ni el resultado global.

### 3.4 Counting

Responsable de conteos, cantidades, aportes, captura movil, busqueda de productos y condiciones fisicas. Internamente utiliza `inventarios.get_effective_count_entries` para resolver las cadenas de correccion y determinar el aporte efectivo de cada raiz, y `inventarios.get_applicable_recount_decisions` para determinar las decisiones de recuento aplicables por alcance (zona, producto, tarea, ciclo). Distingue cantidades fisicas, disponibles, danadas, vencidas, bloqueadas y otras condiciones segun las reglas aprobadas.

No conoce costos, valorizaciones, diferencias contra Bsale ni decisiones de aprobacion. Conserva cada aporte y cada correccion sin sustituir historia.

### 3.5 Incident

Responsable de incidencias, fotografias, otras evidencias y su resolucion. Registra categoria, contexto, severidad, estado, responsable, observacion y evidencia sin alterar directamente el conteo ni el resultado oficial.

Informa a Session, Assignment, Recount y Consolidation cuando una incidencia limita una transicion o requiere decision autorizada.

### 3.6 Recount

Responsable de solicitudes de reconteo, asignacion de reconteos, ejecucion ciega, nivel de confianza, seleccion del resultado definitivo y justificacion de la decision.

No expone stock teorico, costos ni conteos previos al contador de reconteo. No consolida ni valoriza resultados por si mismo.

### 3.7 Consolidation

Responsable de consolidar aportes validos, aplicar decisiones de reconteo, excluir conteos invalidados y generar resultados oficiales de conteo, cobertura y diferencias.

Nunca permite edicion directa de los totales. Sus resultados se derivan de conteos, estados de tareas, incidencias y decisiones autorizadas. Entrega resultados al dominio de Valuation y a Inventory Session para revision y aprobacion.

### 3.8 Valuation

Responsable de utilizar los costos congelados para valorizar faltantes, sobrantes, productos danados, productos vencidos y el impacto economico del resultado consolidado.

No modifica cantidades ni determina el resultado fisico. No obtiene costos actuales durante la jornada: utiliza la referencia congelada por Snapshot.

### 3.9 Export

Responsable de generar versiones de salida, archivo Excel compatible con el proveedor, archivos complementarios, historial, hash y trazabilidad de generacion y descarga.

Solo puede exportar una version aprobada. Nunca modifica inventario, stock, conteos, consolidacion ni la fuente externa.

### 3.10 Reconciliation

Responsable de verificar el proveedor externo despues de la carga, comparar sus datos contra la version aprobada, registrar coincidencias, diferencias, justificaciones y validacion final.

No edita la version aprobada ni corrige el proveedor. Su unica consecuencia funcional es cerrar oficialmente la jornada cuando se cumpla el criterio de conciliacion autorizado.

### 3.11 Audit

Responsable unicamente de registrar eventos. Captura quien, cuando, desde que cliente y con que contexto realizo acciones, transiciones, correcciones, rechazos, sincronizaciones, exportaciones y conciliaciones.

No toma decisiones, no habilita transiciones y no modifica datos funcionales.

## 4. Relaciones entre dominios

La relacion de ownership y consumo dentro de PetGrup es:

```text
PetGrup ERP
|
+-- core
+-- adquisiciones
+-- logistica
+-- comercial
+-- integraciones
`-- inventarios
```

`inventarios` consume referencias e informacion desde los demas dominios cuando una jornada lo requiere, pero solo es propietario de sus propias entidades. Ninguno de los dominios de PetGrup modifica directamente las entidades de `inventarios` salvo mediante los limites funcionales autorizados del Engine.

Inventory Session crea y gobierna el contexto de la jornada. Solicita a Snapshot crear el Snapshot Operacional antes de iniciar y a Assignment preparar tareas. Assignment habilita a Counting exclusivamente para tareas autorizadas. Counting comunica aportes y condiciones a Consolidation, e informa incidencias a Incident.

Incident puede requerir resolucion antes de que Session permita avanzar. Recount utiliza conteos y diferencias para generar una nueva evidencia ciega; entrega su decision a Consolidation. Consolidation calcula el resultado funcional sin editar los aportes. Valuation recibe solo resultados consolidados y costos congelados del Snapshot.

Tras aprobacion, Export recibe una version oficial inmutable y genera las salidas. Reconciliation consulta al conector externo, compara contra la misma version y comunica el resultado a Inventory Session. Audit recibe eventos de todos los dominios sin devolver decisiones.

Los limites obligatorios son:

- Counting no conoce costos, diferencia teorica ni resultados de otros contadores.
- Assignment no decide resultados fisicos ni valorizaciones.
- Incident no altera conteos ni consolidados.
- Recount no decide aprobacion ni consulta Bsale.
- Consolidation no admite cambios manuales de total.
- Export no escribe stock ni modifica resultados.
- Reconciliation no modifica la version aprobada.
- Audit no contiene logica de negocio decisoria.

## 5. Flujo general del Engine

1. Un usuario autorizado crea Inventory Session y define empresa, alcance, proveedor, sucursal, bodega, responsable, zonas y participantes mediante referencias a los dominios propietarios.
2. Session solicita al Inventory Provider los datos necesarios y Snapshot crea el Snapshot Operacional de productos, ubicaciones, stock, costos, reglas, configuracion y asignaciones aplicables.
3. Assignment crea y prepara tareas de zona; Session pasa a preparada cuando sus precondiciones se cumplen.
4. Un autorizado inicia la jornada. Assignment habilita tareas y Android puede operar como cliente de Counting.
5. Los contadores abren una zona autorizada, registran aportes y condiciones; Incident conserva evidencias y excepciones.
6. Al cerrar zonas, Assignment restringe su edicion. Consolidation incorpora solo los aportes validos conforme a reglas de la jornada.
7. El supervisor revisa cobertura, diferencias, incidencias y resultados. Recount gestiona evidencia adicional cuando sea requerida.
8. Consolidation genera el resultado definitivo; Valuation aplica costos congelados y Session pasa a revision.
9. Un actor autorizado aprueba una version oficial inmutable si no existen bloqueos funcionales.
10. Export genera el archivo compatible con el proveedor y los reportes complementarios de la version aprobada.
11. La carga en el proveedor se confirma fuera del Engine durante la primera etapa. Reconciliation consulta el Inventory Provider, compara contra la version aprobada y registra el resultado.
12. Cuando coincida o exista justificacion autorizada, Session se cierra como conciliada. Las rectificaciones posteriores conservan la version original y siguen el proceso funcional autorizado.

## 6. Componentes reutilizables

Los siguientes dominios o capacidades estan preparados para reutilizarse en otros productos PetGrup:

- **Incident:** categorias, severidad, resolucion y relacion contextual de incidencias.
- **Evidence:** fotografias y otros respaldos asociados a empresa, usuario, proceso y fecha.
- **Audit:** eventos inmutables de acciones, intentos, rechazos y cambios de estado.
- **Export:** generacion de archivos, versionado, hash, descargas y trazabilidad.
- **Versioning:** version oficial inmutable, revisiones posteriores y relacion entre versiones.
- **Assignment:** distribucion y control de tareas humanas con exclusividad operativa.
- **Reconciliation:** comparacion entre resultado interno aprobado y fuente externa.

La reutilizacion no debe transferir a otros productos reglas especificas de zonas, conteos o inventario fisico.

## 7. Integraciones externas

El Engine nunca depende directamente de Bsale. Depende de un contrato funcional denominado **Inventory Provider**.

```text
Inventory Engine
        |
        v
Inventory Provider
        |
        +-- Bsale Provider
        +-- Excel Provider
        +-- SAP Provider
        +-- Odoo Provider
        +-- Otro Provider
```

El provider entrega capacidades de consulta de catalogo, stock, costos y referencias externas; puede generar o interpretar los formatos necesarios para intercambio y permite consultar el resultado externo para conciliacion. No controla el ciclo de vida de la jornada ni toma decisiones de consolidacion.

Bsale es el primer conector. Excel es el medio inicial de intercambio aprobado. Futuras integraciones pueden cambiar proveedor sin cambiar los dominios centrales ni las reglas del Engine.

## 8. Dependencias con PetGrup

Inventory Engine puede consultar los siguientes recursos compartidos de PetGrup:

- Usuarios, autenticacion, empresas, roles y permisos.
- Productos y codigos disponibles.
- Costos disponibles para el snapshot.
- Bodegas y ubicaciones de Logistica.
- Sincronizacion y conectores externos disponibles.
- Auditoria, almacenamiento de evidencia y configuracion empresarial compartida.

Estas son dependencias de lectura o consumo de servicios mediante referencias. Inventory Engine no modifica usuarios, empresas, catalogos de producto, Logistica, Bsale Sync ni otro modulo sin autorizacion explicita.

### Integracion con Logistica

Las ubicaciones utilizadas por inventarios son las mismas creadas y administradas por Logistica. Inventory Engine nunca administra ubicaciones propias: las utiliza exclusivamente como zonas operativas durante una jornada.

Al iniciar una jornada, el Snapshot Operacional conserva las ubicaciones seleccionadas y su contexto aplicable. Asi, las nuevas ubicaciones creadas por Logistica quedan disponibles para futuros inventarios, mientras que los inventarios historicos permanecen inalterables.

## 9. Arquitectura preparada para crecimiento

La separacion por dominios permite sumar capacidades sin redisenar el Engine:

- **Inventarios ciclicos:** nuevos alcances y politicas de Session sin alterar Counting o Export.
- **Lotes y FEFO:** extension de Snapshot, Counting y Consolidation para nuevas dimensiones fisicas.
- **Ubicaciones WMS:** Assignment y Snapshot pueden usar mayor granularidad de zonas sin cambiar el ciclo de jornada.
- **RFID y lectores industriales:** nuevos clientes o mecanismos de captura que alimentan Counting bajo las mismas reglas.
- **Multiples ERP:** nuevos Inventory Provider sin acoplar Bsale al Engine.
- **API publica:** un nuevo cliente autorizado del motor, sin trasladar logica de negocio al consumidor.

## 9.1 Evolucion futura

En una fase posterior, las ubicaciones de Logistica podran reflejar el inventario fisico validado, el Kardex podra convertirse en la fuente oficial de stock y la integracion con Bsale podra dejar de ser necesaria.

La separacion entre Engine, Snapshot Operacional, dominios propietarios e Inventory Provider permite esta evolucion sin redisenar el Engine ni alterar sus reglas centrales.

## 9B. Exposición via Supabase Data API (4F.1)

El schema `inventarios` se expone via PostgREST habilitándolo en `supabase/config.toml` → `api.schemas`. Esto permite invocar RPCs desde cualquier cliente autorizado sin acceso directo a tablas.

**Patrón de invocación desde el frontend:**
```
supabase.schema('inventarios').rpc('nombre_rpc', { p_param: valor })
```

**Reglas de seguridad:**
- Tablas: RLS activo, grants revocados, cero policies → sin acceso directo.
- Helpers internos: sin GRANT EXECUTE TO authenticated → solo accesibles via service_role.
- RPCs operativas: GRANT EXECUTE TO authenticated → invocables via Data API con JWT de usuario.
- Anon: todo denegado (401).
- Schema expuesto: sí, para que PostgREST pueda enrutar las RPCs.

**Smoke tests (4F.1):** 6 pruebas no destructivas con fetch nativo. Resultado: 3 PASS (anon bloqueado), 3 SKIP (sin JWT de pruebas).

## 9C. Autorización híbrida (4F.2)

Existen dos modelos de autorización independientes que se aplican en conjunto:

### Portal roles (autorización general)

- `portal.roles`: 6 roles físicos (`SUPER_USUARIO`, `GERENCIA`, `BODEGA`, `CONSULTA_DE_BODEGA`, `FINANZAS`, `VENDEDOR`).
- `portal.permissions`: permisos funcionales del módulo `inventarios` (10 usados por RPC operativas).
- `portal.role_permissions`: pares `(role, permission)` que definen qué conjunto general de operaciones puede intentar un usuario.
- `portal.has_permission(...)`: resuelve la autorización general para `auth.uid()`.

### Functional role (autorización contextual)

- `inventarios.session_participants.functional_role`: `COUNTER`, `SUPERVISOR`, `ADMINISTRATOR` o `MANAGER`.
- Es una autorización contextual por jornada, no un rol global del portal.
- No existe relación FK entre `functional_role` y `portal.roles`.
- `require_session_participant(...)` valida participación vigente y rol contextual.

### Matriz de roles (4F.2)

| Portal role | Permisos de Inventarios | Restricción contextual |
|-------------|-------------------------|------------------------|
| `SUPER_USUARIO` | 10 permisos usados por RPC operativas (asignación explícita) | No elimina controles contextuales: no cuenta sin participar, no valida sin SUPERVISOR, no aprueba sin MANAGER, no opera sin acceso a empresa |
| `BODEGA` | 9 permisos operativos (tasks.assign/execute/validate/cancel, counts.record/correct, incidents.manage, recounts.manage/decide) | COUNTER, SUPERVISOR o ADMINISTRATOR según operación |
| `GERENCIA` | `inventarios.sessions.approve` únicamente | MANAGER contextual vigente |
| `CONSULTA_DE_BODEGA` | Ninguno | — |
| `FINANZAS` | Ninguno | — |
| `VENDEDOR` | Ninguno | — |

Reglas:

- SUPER_USUARIO recibe permisos mediante filas explícitas en `portal.role_permissions`, sin herencia automática.
- BODEGA no recibe `inventarios.sessions.approve`.
- GERENCIA no recibe permisos operativos de BODEGA.
- Aprobar exige simultáneamente permiso general (GERENCIA o SUPER_USUARIO) y `functional_role = MANAGER` vigente en la jornada.
- No se crearon roles nuevos, permisos nuevos, user_permissions ni asignaciones directas a usuarios.
- La validación dinámica completa de `functional_role` (sesión existente, participante, rol incorrecto) queda pendiente hasta disponer de una jornada controlada de pruebas antes del UI productivo.

### Smoke tests (4F.2)

- Anon: tabla (PASS 401), RPC (PASS 401), helper (PASS 401).
- Authenticated (tabla, helper, sin permiso, BODEGA, GERENCIA, SUPER_USUARIO): SKIPPED por ausencia de JWT de prueba.
- Cero mutaciones: todas las pruebas usan UUIDs aleatorios y actores no autorizados.

### Reconciliación de superficie (4F.2-H1)

La superficie física final es de **32 firmas: 22 RPC operativas + 10 helpers internos**.
La cifra de 23 RPCs / 33 firmas de 4F.0 fue documentalmente incorrecta: provino de la
matriz conceptual 4E que listaba nombres de un diseño previo que nunca fueron
implementados (`create_inventory_session`, `create_count_entry`,
`reject_inventory_session`, `bulk_insert_count_entries`, etc.). La migración 4E.5 cubre
las 32 firmas (22 grants + 10 revokes de helpers) y la matriz 4F.2 asigna los 10 permisos
usados por las 22 RPCs. No existe RPC vigente sin grant ni sin permiso.

Las RPCs de ciclo de sesión (crear, preparar, iniciar, cancelar jornada) no fueron
implementadas; la única RPC de sesión es `approve_inventory_session` (UNDER_REVIEW →
APPROVED). El permiso `inventarios.sessions.start` queda reservado, sin RPC que lo use.

## 10. Decisiones arquitectonicas oficiales

1. Inventory Engine es un producto reutilizable, no un modulo aislado para MYM.
2. La base de datos se definira en ingles y la UI se comunicara en espanol.
3. Las integraciones estan desacopladas mediante Inventory Provider.
4. El Snapshot Operacional de productos, stock, costos, ubicaciones, reglas, configuracion y asignaciones aplicables es inmutable.
5. Los costos de recepcion quedan congelados para la jornada y su valorizacion.
6. Toda jornada aprobada genera una version oficial inmutable.
7. Excel es el medio inicial de intercambio con el proveedor externo.
8. Android es cliente operativo de captura; no modifica stock ni se conecta con proveedores externos.
9. El portal web administra configuracion, supervision, aprobacion, exportacion y conciliacion.
10. Bsale es el primer conector y no define la logica interna del Engine.
11. Ningun cliente ni dominio central modifica stock directamente; la carga externa se verifica mediante conciliacion.
12. Inventory Engine es propietario solo de la informacion del esquema `inventarios` y consume los maestros del ERP mediante referencias.
