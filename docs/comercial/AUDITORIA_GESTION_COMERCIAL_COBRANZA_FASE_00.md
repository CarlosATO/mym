# Auditoría Fase GC-00 — Gestión Comercial, Clientes, Ventas y Cobranza

## 1. Revisar Estado Actual del Módulo Comercial

### Capacidades Funcionales
- **Inicio Actual (`/dashboard/comercial/page.tsx`)**: Actualmente es una pantalla estática ("Panel Comercial - Resumen general"). No tiene indicadores operacionales ni métricas en el root del módulo.
- **Sidebar y Navegación**: Administrado por `comercial-submenu.tsx`, da acceso a Clientes, Cobranza, Comisiones y Análisis.
- **Clientes (`/dashboard/comercial/clientes`)**: Cuenta con un panel explorador avanzado (`customers.ts` y `customers-panel.tsx`) que trae métricas en tiempo real de ventas, tickets promedios, riesgos y calidad.
- **Cliente 360 (`client-360-drawer.tsx`)**: Un drawer modal que muestra un perfil exhaustivo de un cliente (Resumen, Compras, Documentos, Productos, Cobranzas).
- **Cobranza (`/dashboard/comercial/cobranza`)**: Cuenta con `receivables-panel.tsx`, que carga un dashboard de cartera de clientes (invoiced, paid, pending, net_cash_gap, buckets de aging).
- **Comisiones**: Presente (v1 y v2), con lógicas complejas de reglas (`rules-search.ts`).
- **Permisos y Seguridad**: Usa `module.comercial.view`, `system.admin` y políticas RLS para visibilidad.
- **Fuentes SQL**: Las acciones leen de las vistas `comercial.vw_receivables_reporting_summary`, `comercial.customers`, e `integraciones.bsale_documents`.

## 2. Auditar Cobranza Actual

Toda la información ya se extrae en `src/app/actions/comercial/customers.ts` (`CommercialCustomerReceivablesSummary`):

| Dato | Fuente Original | Transformación (Server Action) | Consumidor (UI) |
|---|---|---|---|
| Facturado | `vw_receivables_reporting_summary` | `total_invoiced` | `ReceivablesPanel` |
| Pagado | `vw_receivables_reporting_summary` | `total_paid` | `ReceivablesPanel` |
| Pendiente | `vw_receivables_reporting_summary` | `total_pending` | `ReceivablesPanel` |
| Vencido | `vw_receivables_reporting_summary` | `overdue_amount` | `ReceivablesPanel` |
| Facturas Pendientes | `vw_receivables_reporting_summary` | `pending_invoices_count` | `ReceivablesPanel` |
| Facturas Vencidas | `vw_receivables_reporting_summary` | `overdue_invoices_count` | `ReceivablesPanel` |
| Pagos Parciales | `vw_receivables_reporting_summary` | `partial_payment_invoices_count` | `ReceivablesPanel` |
| Último Pago | `vw_receivables_reporting_summary` | `last_payment_date` | `ReceivablesPanel` |
| Última Factura | `vw_receivables_reporting_summary` | `last_invoice_date` | `ReceivablesPanel` |
| Días Promedio Pago | `vw_receivables_reporting_summary` | `avg_days_to_pay` | `ReceivablesPanel` |
| Máximo Atraso | `vw_receivables_reporting_summary` | `max_days_overdue` | `ReceivablesPanel` |
| Aging | Buckets generados localmente | `agingBucketIndex` | `ReceivablesPanel` (Gráfico) |
| Risk Status | `vw_receivables_reporting_summary` | `risk_status` | Cliente 360 / Explorador |
| Payment Behavior | `vw_receivables_reporting_summary` | `payment_behavior_label` | Cliente 360 |
| Vendedor | `vw_receivables_reporting_summary` | `seller_name` / `reporting_seller_name`| Cliente 360 |
| Clasificación | `vw_receivables_reporting_summary` | `customer_classification` | Panel Clientes |
| Cuentas Int/Ext | `vw_receivables_reporting_summary` | `is_internal_account`, `exclude_from_external_reports` | `ReceivablesPanel` (Filtros Scope) |
| Evolución Mensual | Query de Ventas/Pagos | `CommercialCustomerReceivablesMonthly` | `ReceivablesPanel` (CompactChart) |

## 3. Auditar Cliente 360

Las capacidades de `client-360-drawer.tsx` son masivas y **deben reutilizarse**, no reconstruirse:

- **Información comercial:** Resumen ventas 90d/180d, facturas totales, tickets promedios. Reutilizable.
- **Comportamiento de compra:** Análisis 12m, evolución mensual (barras), facturas/NV/NC. Reutilizable.
- **Documentos:** Detalle por línea de producto, descuentos, impuestos. Tabla interactiva. Reutilizable.
- **Productos:** Ranking por monto/unidades, productos estancados, actividad reciente. Reutilizable.
- **Cobranza/pagos:** Gráficos de comportamiento de pagos, alertas automáticas de deuda. Reutilizable.
- **Riesgo:** Etiquetas semánticas de comportamiento (`ATRASO_RECURRENTE`, `ATRASO_LEVE`, `DEUDA_CRITICA`). Reutilizable.

## 4. Auditar las Cards del Portal

Las cards del Portal (`portal-financial-section.tsx`, `latest-route-guides.tsx`, `amimascota-card.tsx`) muestran:

- **Ventas:** Facturado mes actual (Facturas tipo 5 - NC tipo 2).
- **Cobranza:** Pagado (asignado) del mes actual.
- **Fuentes:** Acciones `getPortalSales`, `getPortalCollectionsByMode`. Documentado en `CONTRATO_DATOS_PORTAL.md`.
- **Exclusiones:** Todo es en el mes actual en America/Santiago. No considera tendencias ni proyecciones históricas.
- **Semántica:** Dinero bruto/neto según la empresa activa.
- **Permisos:** Requiere ser `system.admin` y tener `active_company_id`.

**Conclusión del Portal:** Debe mantenerse exclusivamente como resumen gerencial ejecutivo. Toda la gestión granular, listados de cobranza u operativas *NO* debe trasladarse al Portal, sino al Inicio de Gestión Comercial.

## 5. Auditar Seguridad (Service Role / Autorización)

En `src/app/actions/comercial/customers.ts`, se identifica el siguiente patrón:

- **Autenticación:** Sí.
- **Empresa:** Sí, se usa `company_id = await getActiveCompanyId()`.
- **Permiso Funcional:** **FALTA**. Las acciones de lectura en `customers.ts` no llaman a `has_permission('module.comercial.view')`.
- **Acceso a datos:** Se inicializa `comAdmin()` con `SUPABASE_SERVICE_ROLE_KEY`. Al hacer esto, **se omite completamente el RLS** (Row Level Security).

**Hallazgo P1 de Seguridad:** El uso de `service_role` filtrando solo por `company_id` permite a cualquier usuario logueado en la aplicación, mediante la manipulación de llamadas Server Actions, obtener datos comerciales si no se valida su permiso explícitamente en el action, saltándose el RLS. (No corregido en este bloque).

## 6. Auditar Confiabilidad de la Cartera (CV-1)

Basado en `docs/clientes/AUDITORIA_CARTERA_VENCIDA_FASE_00.md` y `DISENO_SYNC_CONCILIACION_CV_1A.md`:

- **Estado:** **SIGUE ABIERTO**.
- Existe un **Incidente Confirmado P0**: el endpoint actual hace polling de 14 días. Pagos modificados fuera de esta ventana quedan desincronizados permanentemente localmente, provocando montos fantasma y discrepancias en deuda.
- El diseño CV-1A (incremental + reconciliación con `unpaid_documents`) fue diseñado pero el repositorio actual no muestra evidencia de su implementación en los actions (siguen asumiendo ventanas cortas sin fallback histórico recurrente).

## 7. Auditar Capacidades WhatsApp Existentes

En `src/modules/logistica/guias-ruta/utils/route-guide-whatsapp.ts`:
- **Capacidades genéricas:** Se arman mensajes usando `wa.me` y portapapeles (`clipboard.writeText`).
- **Acoplamiento:** Altamente acoplado a despachos, rutas, rechazos de logística.
- **Integración real:** **NO HAY**. Solo se construyen URIs y textos para abrir la app web o móvil. No hay integración con WhatsApp Cloud API.

No se debe construir una integración API por ahora, pero la lógica de armar URLs con `wa.me` se puede abstraer para cobranza.

## 8. Identificar el GAP Real

| Capacidad | Ya existe en ERP / App | Resuelve Bsale (No replicar) | Falta y aporta valor operacional |
|---|---|---|---|
| Deuda, pagos, facturas | Sí (Tablas/Vistas) | Sí | No |
| Aging y morosidad | Sí (Tablas/Vistas) | Sí | No |
| Datos cliente, vendedor | Sí (customers) | Sí | No |
| Riesgo y calidad | Sí (Risk Status) | No aplica | No |
| Lista priorizada cobranza | No (solo panel general) | No tiene CRM potente | **SÍ** |
| Registro última gestión | No | No | **SÍ** |
| Contador gestiones | No | No | **SÍ** |
| Lanzar WhatsApp/Correo | Logística parcial | No integrado | **SÍ** |
| Notas / Compromisos pago | No | No | **SÍ** |
| Seguimiento post 24h | No | No | **SÍ** |
| Auditoría de contactos | No | No | **SÍ** |

## 9. Proponer Frontera Funcional

- **A. Portal:** Resumen ejecutivo, KPI gerenciales, sin operabilidad profunda.
- **B. Inicio Gestión Comercial:** Dashboard que cruza las macro-cifras de venta (metas) con la cobranza del mes.
- **C. Clientes / Cliente 360:** Perfil detallado de comportamiento de compra, facturas históricas y rentabilidad. (Punto de llegada).
- **D. Cobranza Operacional:** Panel tipo CRM "To-Do List": quién debe, a quién llamar hoy, y registro rápido de promesas de pago. (Punto de partida de la operativa de cobranza).
- **E. Bsale:** Emisión tributaria de facturas, recepción de pagos e imputaciones financieras base.

## 10. Evaluar la Idea "Copiar WhatsApp"

No se puede tratar la copia de un texto al portapapeles o la apertura de un link como una gestión exitosa (COPIADO != ENVIADO).

**Semántica de Estados Propuesta:**
1. `PENDIENTE`: Cliente con deuda vencida que entra a cola de gestión.
2. `CONTACTO_INICIADO`: Se hizo clic en "Enviar WhatsApp" (abre wa.me), pero no sabemos si el operador le dio "Send".
3. `GESTIONADO_MANUALMENTE`: El operador cierra el loop y registra una nota o "Compromiso de pago".
4. `REQUIERE_SEGUIMIENTO`: Si tras 24/48h del paso 2 no hay registro formal (ni en Bsale ni notas de gestión), el sistema lo revive en la lista.

*Cálculo "requiere seguimiento sin pago":* Cruzando `fecha_ultima_gestion` (nueva tabla de gestiones) contra `last_payment_date` del resumen comercial.

## 11. Riesgos P0/P1/P2

- **P0**: La desincronización de pagos históricos (Problema CV-1 abierto). Construir operativas sobre una cartera con errores de saldos es crítico.
- **P1**: Acciones con `service_role` sin control de acceso funcional por módulo, saltando RLS.
- **P2**: Duplicar lógicas de ventas o cliente 360 en nuevos componentes.

## 12. Propuesta de Próximos Bloques

La secuencia debe abordar prerrequisitos antes de UI.

1. **FASE GC-01 (Prerrequisito de Datos - CV-1):** Implementar definitivamente la reconciliación y backfill histórico diseñado en `DISENO_SYNC_CONCILIACION_CV_1A.md` para garantizar que la cartera vencida en base de datos coincida al 100% con Bsale.
2. **FASE GC-02 (Modelo Base Operacional):** Crear el modelo de datos (Migraciones SQL) para el módulo de Gestión de Cobranza (Gestiones, compromisos, estados) y ajustar los server actions de validación de seguridad.
3. **FASE GC-03 (UI Cobranza):** Construir el inicio de Cobranza Operativa enfocado en acciones (CRM de contactos).
4. **FASE GC-04 (UI Ventas y Dashboard Comercial):** Construir la carátula principal de cruce Ventas/Cobranzas.

---
*Fin de la auditoría. Documento generado sin modificaciones al código fuente.*
