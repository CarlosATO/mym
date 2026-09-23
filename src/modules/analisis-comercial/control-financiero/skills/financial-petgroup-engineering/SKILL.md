# Financial PetGroup Engineering

## Alcance

Este skill es específico de la arquitectura de PetGroup y aplica únicamente cuando el trabajo corresponda a `Análisis Comercial -> Control Financiero`.

No redefine la arquitectura de otros módulos.

## Arquitectura objetivo

```text
Frontend: Next.js / React / TypeScript de PetGroup
Backend financiero: Python + FastAPI
Persistencia: Supabase PostgreSQL existente
```

Reglas:

- Next.js es dueño de la experiencia de usuario.
- Python es dueño de la lógica financiera.
- PostgreSQL es la fuente persistente de verdad.
- No crear una segunda base de datos.

## Estado actual

La auditoría inicial determinó que actualmente:

- no existe backend FastAPI;
- no existe SQLAlchemy;
- no existe Alembic;
- no existe schema `finanzas`;
- no existe dominio bancario general;
- no existe CxP general;
- existen fuentes parciales de ventas, compras, cobros, inventarios y costos.

No inventar como existente lo que todavía no existe.

## Multiempresa

PetGroup resuelve empresa activa mediante:

```text
active_company_id
+
core.user_company_access
```

Reglas obligatorias:

- No utilizar `COMPANY_ID` fijo.
- No confiar en `company_id` enviado por el frontend.
- Toda entidad financiera operativa tendrá `company_id`.
- La empresa activa debe validarse contra acceso real.
- Las consultas consolidadas deben ser explícitas.
- La consolidación solo incluye empresas autorizadas.

Secuencia esperada:

```text
JWT
-> usuario
-> empresa solicitada o activa
-> core.user_company_access
-> permiso funcional
-> consulta por company_id
-> auditoría
```

Existe código antiguo de Análisis Comercial que utiliza un `COMPANY_ID` fijo. Control Financiero no debe copiar ese patrón ni corregirlo fuera de una tarea explícita.

## Propiedad empresarial de las fuentes

Todo dato financiero debe quedar asociado inequívocamente a una empresa desde el momento en que ingresa al sistema.

La separación entre empresas no debe resolverse posteriormente mediante filtros visuales, nombres escritos en descripciones, coincidencias de razón social, texto libre, heurísticas o deducciones posteriores cuando exista una fuente previamente identificada.

La propiedad empresarial debe provenir de la fuente o conexión registrada.

Patrón conceptual:

```text
Fuente externa
-> conexión/configuración
-> empresa propietaria
-> dato financiero
```

Ejemplos:

```text
Conexión BSale AMIMASCOTA
-> company_id AMIMASCOTA
-> documentos AMIMASCOTA

Cuenta bancaria AMIMASCOTA
-> company_id AMIMASCOTA
-> movimientos AMIMASCOTA

Archivo bancario asociado a una cuenta AMIMASCOTA
-> company_id AMIMASCOTA
-> movimientos AMIMASCOTA
```

La separación AMIMASCOTA/CAYLO es una propiedad estructural del dato, no un filtro de presentación.

## Fuentes configurables

Conceptualmente, las integraciones financieras deben poder identificar como mínimo:

- empresa propietaria;
- sistema fuente;
- conexión o cuenta fuente;
- identificador externo estable;
- estado de la integración.

No crear tablas todavía.

Patrón conceptual de trazabilidad:

```text
company_id
source_system
source_connection_id
source_record_id
```

Agregar otros identificadores cuando el caso de uso lo requiera:

- `source_document_id`;
- `source_import_id`;
- `bank_account_id`;
- `counterparty_id`;
- `counterparty_company_id`;
- `intercompany_group_id`.

No exigir que todas las tablas utilicen todos estos campos.

## BSale

Cada conexión o contexto BSale debe pertenecer inequívocamente a una empresa.

No inferir posteriormente la empresa mediante nombre de cliente, razón social, RUT, descripción o contenido del documento si la conexión fuente ya identifica la empresa.

Cuando se diseñe la integración BSale se debe auditar:

- conexión propietaria;
- `company_id`;
- external IDs;
- sincronización;
- idempotencia;
- cobertura histórica.

No decidir todavía entre API directa y tablas sincronizadas.

## Cuentas bancarias

Cada cuenta bancaria debe pertenecer a una empresa.

```text
bank_account
-> company_id
-> movimientos
```

Dos empresas pueden utilizar el mismo banco, pero nunca compartir identidad de cuenta dentro del modelo financiero.
La propiedad se determina por la cuenta, no por el texto del movimiento.

## Importaciones Excel bancarias

Una importación de una cartola de una cuenta conocida debe vincularse antes del procesamiento a empresa, cuenta bancaria, sistema/banco y archivo/importación.

Todos los movimientos válidos heredan ese contexto.

Si un archivo contiene datos de más de una empresa o no permite identificar inequívocamente la propiedad:

- no ingresar directamente al modelo financiero canónico;
- utilizar staging;
- resolver la asignación mediante reglas deterministas;
- dejar registros no resueltos pendientes;
- no adivinar la empresa.

## Staging

Las fuentes ambiguas o incompletas pueden pasar por una capa temporal de staging.

El staging debe permitir:

- conservar el dato original;
- preservar el identificador de origen;
- registrar la fuente;
- detectar duplicados;
- asignar empresa;
- validar;
- rechazar o dejar pendiente.

Solo después de una asignación válida pueden ingresar al modelo financiero canónico.
No implementar staging todavía.

## Intercompany y consolidación

Un movimiento intercompany debe conservar la empresa propietaria de cada registro.

Ejemplo conceptual:

```text
AMIMASCOTA OUT contraparte CAYLO
CAYLO IN contraparte AMIMASCOTA
```

Estas dos operaciones pueden vincularse mediante un identificador común conceptual, `intercompany_group_id`.
No eliminar físicamente ninguna de las dos patas.

En vista individual cada empresa conserva su movimiento. En vista consolidada, las operaciones intercompany relacionadas pueden neutralizarse.

Consolidado no es una empresa. No crear `company_id = CONSOLIDADO` ni ningún identificador de empresa ficticia equivalente.
La consolidación debe ejecutarse como una consulta explícita sobre múltiples empresas autorizadas:

```text
empresas autorizadas
-> AMIMASCOTA
-> CAYLO
-> consulta consolidada
-> eliminaciones intercompany
-> resultado consolidado
```

## Seguridad

FastAPI debe validar explícitamente:

- JWT;
- usuario;
- expiración;
- empresa;
- acceso;
- permiso;
- filtros `company_id`;
- prevención de acceso cross-company.

La fuente puede ayudar a determinar `company_id`, pero nunca sustituye la autorización. La secuencia esperada es:

```text
JWT
-> usuario
-> empresa/fuente solicitada
-> validar acceso en core.user_company_access
-> validar permiso
-> resolver company_id de la fuente
-> consulta/proceso
-> auditoría
```

No confiar en `company_id` o `source_connection_id` enviados por el browser sin validar que el usuario tenga acceso a la empresa propietaria.

Si utiliza una conexión PostgreSQL privilegiada:

- no asumir que RLS protege automáticamente;
- `auth.uid()` puede no existir en contexto SQL;
- `service_role` no reemplaza autorización;
- no exponer consultas arbitrarias.

Preferir un usuario PostgreSQL dedicado con privilegios mínimos.

## Acceso a PostgreSQL

Dirección deseada:

```text
FastAPI
-> SQLAlchemy
-> PostgreSQL Supabase
```

En producción se requiere considerar SSL, pooling controlado, timeouts, transacciones explícitas y límites de conexión.

Idealmente:

- schemas históricos: lectura según privilegios requeridos;
- `finanzas.*`: lectura y escritura según responsabilidades del backend financiero.

No implementar todavía.

## Ownership de migraciones

```text
Schemas existentes de PetGroup -> Supabase migrations
Nuevo dominio finanzas.*       -> Alembic
```

Un objeto PostgreSQL tiene un único sistema propietario de migraciones.
Nunca administrar el mismo objeto mediante Supabase CLI y Alembic.

Antes de crear objetos se debe documentar ownership y revisar:

- `supabase db diff`;
- `db reset`;
- grants;
- owners;
- claves foráneas cross-schema;
- cambios de tablas históricas;
- orden de despliegue.

## Fuente única de verdad

Cada cálculo financiero tiene una única implementación canónica.

- El frontend presenta.
- El backend calcula.
- La base persiste.

No duplicar fórmulas financieras relevantes entre Python y React.

## Trazabilidad

Toda cifra gerencial debe poder recorrer:

```text
KPI
-> concepto
-> período
-> agrupación
-> registro o documento
-> fuente
```

Reglas:

- suma de Nivel 1 = total del concepto;
- suma de Nivel 2 = elemento seleccionado;
- paginación no altera KPI;
- filtros del drill-down coinciden con el resumen.

## No modificar la fuente

No corregir una lectura financiera alterando silenciosamente datos operacionales provenientes de BSale, adquisiciones, inventarios, logística u otros schemas.

Crear, cuando corresponda, capas de normalización, clasificación, ajuste y conciliación manteniendo la fuente original.

## Idempotencia

Toda integración o importación debe disponer de identificador estable, `source_id` o equivalente, prevención de duplicados y reejecución segura.

Esto es especialmente importante para BSale y futuras integraciones bancarias.

Cuando exista identificador externo, `source_system + source_connection_id + source_record_id` debe poder utilizarse conceptualmente para determinar identidad de origen.
No hardcodear todavía constraints ni índices.

## BSale

PetGroup cuenta con integración y estructuras BSale.

No decidir todavía entre API directa y tablas sincronizadas. Para cada caso se debe auditar cuál es la fuente canónica apropiada.
No realizar doble extracción innecesaria.

## Auditoría

Las operaciones financieras mutables deben poder registrar:

- usuario;
- empresa;
- acción;
- entidad;
- estado anterior;
- estado nuevo;
- timestamp;
- origen;
- correlation/request ID cuando exista.

Reutilizar la infraestructura de auditoría de PetGroup cuando sea apropiado.

## Separación de responsabilidades

Mantener separados modelos, esquemas API, servicios, repositorios/persistencia, rutas, seguridad, integración y presentación.
No agregar abstracciones sin necesidad concreta.

## No doble conteo

- Un movimiento se asigna exactamente una vez donde corresponda.
- Las transferencias internas se neutralizan sin perder trazabilidad.
- El capital no se duplica como gasto.
- La compra no se duplica como COGS.
- El intercompany no se duplica en el consolidado.
- Los subtotales son mutuamente excluyentes.

## Implementación incremental

Cada prompt futuro debe representar un bloque funcional acotado y verificable.
No implementar simultáneamente infraestructura completa, backend completo, frontend completo, migraciones grandes e integración externa completa.

## Datos reales

No ejecutar operaciones irreversibles sobre producción sin autorización explícita.
Para pruebas utilizar fixtures, datos controlados, transacciones reversibles y lecturas read-only cuando corresponda.

## Validación

Según la capa modificada, validar como mínimo:

Backend Python:

- imports;
- tests focales;
- tipos si están configurados;
- contratos;
- integridad financiera.

Frontend:

- `npm run typecheck`;
- `npm run build`.

Base de datos:

- integridad;
- aislamiento por empresa;
- constraints;
- migraciones;
- rollback cuando corresponda.

No utilizar automatización de navegador/UI salvo autorización explícita. La validación visual corresponde al usuario mediante la aplicación.

## Railway

Cuando corresponda, la arquitectura esperada es conceptualmente:

```text
Proyecto Railway
|- PetGroup Next.js
`- FastAPI financiero
```

Ambos servicios trabajarían con el PostgreSQL Supabase existente.
No configurar Railway dentro de este bloque.

## No redefinir otros módulos

Estas reglas no redefinen Logística, Inventarios, Adquisiciones, Portal ni otros módulos. Aplican exclusivamente cuando el prompt indique Control Financiero.
