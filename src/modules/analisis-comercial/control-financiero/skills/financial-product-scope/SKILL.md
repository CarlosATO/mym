# Financial Product Scope

## Alcance

Estas reglas aplican exclusivamente a `Análisis Comercial -> Control Financiero`.

## Objetivo

Control Financiero transforma datos operacionales confiables en lectura financiera y gerencial trazable.

Debe responder progresivamente:

- ¿La empresa genera o pierde dinero?
- ¿Qué margen obtiene?
- ¿Cuánto efectivo tiene?
- ¿Cómo evolucionan ventas, costos y gastos?
- ¿Qué explica cada cifra?
- ¿Cómo se relacionan rentabilidad y caja?
- Cuando exista el dominio correspondiente, ¿qué obligaciones y derechos de cobro existen?

## Ubicación

```text
PetGroup
-> Análisis Comercial
-> Control Financiero
```

No crear por ahora un módulo de Portal independiente.

## Primer alcance

Vistas iniciales:

- Resumen Financiero.
- Estado de Resultados.
- Flujo de Caja.
- Capital de Trabajo.

## Capacidades

- Empresa activa.
- Consulta mensual.
- YTD.
- Comparación temporal.
- Drill-down.
- Trazabilidad hasta la fuente.
- Ventas.
- Costos.
- Producto.
- Categoría.
- OPEX.
- Intercompany.
- Financiamiento.
- Utilidad frente a caja.
- Períodos parciales.
- Movimientos pendientes.
- Eventual consolidación explícita de empresas autorizadas.

## Empresa individual y consolidado

Debe existir diferencia conceptual entre empresa activa y vista consolidada.

- No utilizar un `company_id` ficticio para representar consolidación.
- La consolidación futura opera solamente sobre empresas a las que el usuario tenga acceso.
- Intercompany se mantiene individualmente y se neutraliza en consolidación.

## Propiedad de datos por empresa

Control Financiero debe operar sobre datos cuya empresa propietaria sea conocida.

Toda fuente de datos debe asociarse a una empresa antes de alimentar cálculos financieros. Esto incluye progresivamente BSale, bancos, Excel, APIs, importaciones y otros sistemas.

La UI no debe intentar corregir o inferir la propiedad empresarial de registros ambiguos.

Los registros sin empresa confiable:

- deben quedar fuera de cálculos financieros oficiales;
- pueden permanecer en staging o pendientes;
- deben mostrar su estado de calidad cuando corresponda.

## Experiencia multiempresa

La empresa activa debe comportarse conceptualmente como en la solución financiera validada:

- vista individual por empresa;
- información aislada;
- intercompany visible individualmente;
- consolidación opcional separada.

La implementación técnica debe utilizar PetGroup:

- `active_company_id`;
- `core.user_company_access`;
- permisos.

La vista consolidada no reemplaza la empresa activa ni crea una empresa ficticia.

## Niveles del producto

Mantener separados:

1. Análisis comercial-financiero.
2. Operación financiera.
3. Contabilidad formal.

Control Financiero comienza principalmente en el nivel 1. Puede crecer hacia el nivel 2, pero no debe presentarse como contabilidad legal completa.

## Estado actual esperado

Inicialmente algunas capacidades podrán estar disponibles, parciales o pendientes de una fuente confiable.

La UI nunca debe presentar una inferencia incompleta como dato contable cierto.

## Fuera del alcance inicial

- Libro diario.
- Libro mayor.
- Balance formal.
- Plan de cuentas completo.
- Cierre contable legal.
- CxP exacta antes de construir su modelo.
- CxC exacta si las fuentes no están conciliadas.
- Inventario exacto sin política de valorización.
- Forecast sin información suficiente.
- Conciliación bancaria automática sin reglas.
- Deuda legal inferida automáticamente.
- Rentabilidad por lote sin trazabilidad real.

## Evolución

El dominio puede evolucionar a CxC, CxP, Tesorería, bancos, conciliación, intercompany avanzado, presupuesto, forecast, control presupuestario, contabilidad, balance, mayor e integración bancaria.

Cada evolución debe conservar:

```text
dato fuente
-> clasificación
-> cálculo
-> presentación
-> trazabilidad
```

## Integraciones

PetGroup dispone de integración BSale y otras fuentes operativas.

No definir todavía cómo será la arquitectura final de extracción BSale. Para cada funcionalidad se debe auditar:

- dato ya sincronizado en PostgreSQL;
- calidad;
- frecuencia;
- identificador fuente;
- cobertura histórica;
- necesidad o no de consulta directa a la API;
- idempotencia.

No duplicar datos simplemente porque exista acceso directo a una API.

## Prototipo validado

Conservar del prototipo reglas financieras, comportamiento gerencial, sistema visual, trazabilidad, separación P&L/Caja/Capital de Trabajo, multiempresa, interacción de matrices y drawer y controles de integridad.

No trasladar SQLite, estructura técnica, rutas locales, scripts ETL locales, `localhost`, `dev.sh`, nombres de archivos históricos, montos hardcodeados ni decisiones técnicas temporales usadas para reconstruir información histórica.

CAYLO puede mencionarse porque es una relación empresarial real relevante para PetGroup, pero solo como regla conceptual. No hardcodear movimientos, montos históricos ni textos bancarios como clasificación universal.

## No redefinir otros módulos

Este documento no redefine la arquitectura de Logística, Inventarios, Adquisiciones, Portal ni cualquier otro módulo. Solo aplica cuando un prompt indique explícitamente Control Financiero.
