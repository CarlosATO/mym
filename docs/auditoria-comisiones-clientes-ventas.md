# Auditoria de Clientes y Ventas: Comisiones

**Alcance:** auditoria read-only del repositorio y de la empresa activa `d1000000-0000-0000-0000-000000000001`.

**Fecha del perfil de datos:** 2026-08-20.

**Conclusión corta:** el cálculo vigente es por línea de factura Bsale pagada completamente, con base neta, y persiste el resultado al crear el borrador. La fuente actual de proveedor es `product_supplier_mappings` activo/preferido. La resolución a `parent_supplier_id` aparece en una migración intermedia, pero la migración posterior que agregó notas de crédito recrea las funciones de preview usando nuevamente el proveedor operativo crudo. La UI/acción aplica una normalización posterior para mostrar y hacer un fallback limitado de reglas de proveedor. Brand/Supplier links no participan en el cálculo.

## 1. Mapa de componentes

### Entrada y acciones

- `src/app/dashboard/comercial/comisiones/page.tsx`: autentica al usuario, lee el nombre de rol y monta el panel.
- `src/app/actions/comercial/commissions.ts`: barrel público de acciones y tipos.
- `src/app/actions/comercial/commissions/auth.ts`: autentica usuario/empresa y crea cliente Supabase con service role en schema `comercial`.
- `src/app/actions/comercial/commissions/settings.ts`: vendedores, configuración general, grupos y proveedores buscables.
- `src/app/actions/comercial/commissions/rules-management.ts`: creación, actualización, desactivación, archive/restore y batches de reglas.
- `src/app/actions/comercial/commissions/rules-search.ts`: búsqueda de productos y cálculo de nombre de proveedor para la UI.
- `src/app/actions/comercial/commissions/simulation.ts`: llama el RPC de preview y normaliza su respuesta.
- `src/app/actions/comercial/commissions/settlements.ts`: crea borrador, consulta, emite, cancela, anula y exporta PDF/XLSX.
- `src/app/actions/comercial/commissions/sync.ts`: consulta salud de sincronización Bsale y permite sync manual sólo a `SUPER_USUARIO`.

### UI y navegación

- `/dashboard/comercial/comisiones`: `src/app/dashboard/comercial/comisiones/page.tsx`.
- `src/modules/comercial/comisiones/commissions-panel.tsx`: simulación, borradores, emitidas, anuladas y configuración.
- `src/modules/comercial/comisiones/components/simulation/simulate-tab.tsx`: selección de vendedor/período y resultado.
- `src/modules/comercial/comisiones/components/settlements/settlement-views.tsx`: listados y detalle de liquidaciones.
- `src/modules/comercial/comisiones/components/configuration/commission-configuration.tsx`: tabs Vendedores, General, Grupos y Reglas.
- `commission-rules-wizard.tsx`: creación guiada de reglas.
- `commission-groups-config.tsx`: grupos/campañas de productos.
- `src/modules/comercial/lib/navigation.ts`: rutas y menú.
- `src/lib/pdf/generate-commission-settlement-pdf.ts`: exportación PDF.

### Base de datos

- `comercial.commission_settings`.
- `comercial.commission_seller_profiles`.
- `comercial.commission_groups` y `comercial.commission_group_products`.
- `comercial.commission_rules`.
- `comercial.commission_settlements` y `comercial.commission_settlement_lines`.
- `comercial.vw_commission_sellers`.
- `comercial.vw_commission_invoice_line_base`.
- RPCs `get_commission_eligible_invoice_lines`, `resolve_commission_rule`, `preview_default_commission_settlement`, `preview_commission_settlement`, `create_commission_settlement_draft`, `cancel_commission_settlement_draft`, `issue_commission_settlement` y `annul_commission_settlement`.

### Migraciones determinantes

- `20260722100000_seller_commissions_model_phase_1a.sql`: modelo y restricciones.
- `20260722100100_seller_commissions_initial_historical_cutoff.sql`: corte histórico al 2026-06-25.
- `20260722100200_seller_commissions_eligibility_views.sql`: elegibilidad base.
- `20260722110000_seller_commissions_rules_preview.sql`: prioridad y cálculo con reglas.
- `20260722120000_commission_rules_operational_metadata.sql` y `20260722123000_commission_rules_archive_metadata.sql`: nombres, batches y archive.
- `20260722124000_resolve_effective_supplier_in_commission_preview.sql`: intento de normalización a parent.
- `20260723120000_add_line_level_credit_notes_to_commission_previews.sql`: versión posterior que recrea ambos previews y agrega NC.
- `20260723130000_commission_settlement_draft_functions.sql` y `20260723132000_annul_issued_commission_settlement.sql`: persistencia y estados.
- `20260819120000_bsale_brand_references.sql` y `20260819130000_bsale_brand_supplier_links.sql`: arquitectura Brand nueva, sin integración al cálculo de comisiones.

## 2. Arquitectura funcional real

El flujo efectivo es:

1. Bsale se sincroniza en `integraciones.bsale_documents`, `bsale_document_details`, `bsale_document_sellers`, `bsale_document_payments` y tablas de referencias.
2. Sólo documentos tipo `5` son facturas comisionables.
3. `vw_customer_invoice_receivables` agrega pagos y resuelve estado de cobranza.
4. `bsale_document_sellers.is_primary = true` identifica al vendedor Bsale de la factura.
5. El SKU de `bsale_document_details.variant_code` se busca contra `adquisiciones.products.sku`, case-insensitive en la función final vigente.
6. El producto se vincula al mapping activo/preferido de `adquisiciones.product_supplier_mappings`.
7. Se obtiene el grupo vigente desde `commission_group_products`, si existe.
8. Se selecciona una regla aplicable por fecha, vendedor, alcance y rango; si no hay, se usa `commission_settings.default_commission_percent`.
9. Se calcula comisión por línea y se presenta en preview.
10. Al crear borrador se guardan líneas y se bloquean con `eligibility_locked_at`; al emitir se asigna correlativo.

No existe una fuente separada de venta para comisiones: el preview consulta tablas sincronizadas y vistas de cuentas por cobrar; no usa reportes comerciales agregados.

## 3. Fuente de ventas y unidad comisionable

La unidad es la **línea de factura** (`bsale_document_details.id`), no el documento completo.

Campos principales:

- Documento: `integraciones.bsale_documents.bsale_id`, `number`, `document_type_id`, `client_id`, `total_amount`, `emission_date`.
- Detalle: `bsale_document_details.id`, `variant_code`, `variant_description`, `quantity`, `net_amount`.
- Vendedor: `bsale_document_sellers.seller_bsale_id`, `seller_name`, `is_primary`.
- Pago: `bsale_document_payments.amount_applied`, `payment_record_date`.
- Cliente: `vw_customer_invoice_receivables.bsale_client_id`, `customer_id`, `client_name`.

Elegibilidad actual:

- `document_type_id = 5`.
- Vendedor primario con perfil activo y `is_commissionable = true`.
- Factura totalmente pagada: `receivable_status = 'PAGADA'` y `pending_amount = 0`.
- `last_payment_date` dentro del período.
- Fuera del período histórico y desde `first_eligible_date`.
- No bloqueada previamente por una línea persistida.
- Cliente no interno y `customer_reporting_profiles.is_commissionable = true`.
- SKU/producto y proveedor resueltos.

La vista de cuentas por cobrar redondea total y pagos a CLP y considera pendiente cero cuando el residuo redondeado está dentro de tolerancia de 1 peso.

## 4. Fórmula matemática

La fórmula codificada es:

`commission_amount = ROUND(net_amount * commission_percent / 100, 0)`

Donde:

- `net_amount` es el neto de la línea Bsale.
- `commission_base_amount` se copia igual a `net_amount`.
- No se usa costo, margen, utilidad, precio de lista, bruto ni IVA.
- La cantidad sólo participa en reglas `RANGE_BY_QUANTITY`; no multiplica la comisión.
- El porcentaje está limitado entre 0 y 100.
- La configuración vigente observada es `1,1%`, base `NET`, pago completo requerido.

No se encuentra una columna específica de descuento usada por comisiones. Por tanto, el efecto observable de un descuento es el neto que Bsale dejó en `dd.net_amount`; no hay una regla adicional para descuento global, promoción u obsequio.

Precio cero produce comisión cero si la línea supera las demás condiciones. No hay tratamiento explícito para “venta autorizada”.

## 5. Reglas y resolución

Los alcances son `GENERAL`, `SUPPLIER`, `GROUP` y `PRODUCT`. Los tipos son:

- `FIXED_PERCENT`.
- `RANGE_BY_AMOUNT`, evaluado sobre acumulado por alcance.
- `RANGE_BY_QUANTITY`, evaluado sobre acumulado por alcance.

La prioridad efectiva del RPC es, en este orden:

1. Producto (`4`).
2. Grupo (`3`).
3. Proveedor (`2`).
4. General (`1`).
5. Dentro del mismo alcance, regla específica de vendedor antes que regla para todos.
6. `priority` descendente.
7. `valid_from` más reciente.
8. `id` como desempate final.

No se acumulan porcentajes. Se elige una sola regla por línea.

Las reglas variables acumulan mediante ventanas sobre las líneas del preview:

- producto: por `product_id`;
- grupo: por `commission_group_id`;
- proveedor: por `supplier_id`;
- general: todas las líneas.

Las validaciones de escritura impiden solapamiento de objetivo, vendedor, rango y vigencia entre reglas activas. La base de datos no impone por sí sola una exclusión equivalente para `commission_rules`; la validación está en la acción de servidor.

## 6. Proveedor actual y pseudoproveedores

### Resolución de código

La consulta final vigente en `20260723120000_add_line_level_credit_notes_to_commission_previews.sql` usa:

`product -> product_supplier_mappings -> supplier`

con `psm.is_active = true AND psm.is_preferred = true`.

La función final recreada por esa migración retorna `psm.supplier_id` y `supplier.business_name` directamente. No consulta `products.bsale_brand_id` ni `bsale_brand_supplier_links`.

### Parent REAL

La migración `20260722124000_resolve_effective_supplier_in_commission_preview.sql` reemplazó temporalmente el resultado por `COALESCE(parent_supplier.id, psm.supplier_id)` y el nombre del parent. Sin embargo, la migración posterior que recrea los previews para NC vuelve a seleccionar `psm.supplier_id` directamente. Por orden de migraciones, el contrato vigente de SQL no conserva esa normalización.

La acción TypeScript `simulation.ts` sí realiza una normalización posterior para presentación: consulta el supplier de cada línea, toma `parent_supplier_id` si existe y reescribe `supplier_id`/`supplier_name` en `baseLines`. Después aplica un fallback sólo para reglas `SUPPLIER` + `FIXED_PERCENT` que no hayan sido resueltas por el RPC.

Consecuencia: la regla SQL principal y la corrección TypeScript no son una única resolución uniforme. Las reglas de producto, grupo y reglas variables no reciben ese mismo fallback de proveedor.

### Mappings

- Se filtran mappings activos.
- En el preview final se exige además `is_preferred`.
- La función final no tiene `ORDER BY/LIMIT` para resolver múltiples preferred. Si hay más de uno, puede duplicar líneas y hacer ambiguo el proveedor.
- Las búsquedas UI sí ordenan preferred y luego `updated_at`, y se quedan con el primero.
- No hay fallback a mapping activo no preferred en el preview final.
- Sin mapping, la línea queda fuera de elegibilidad por el `JOIN` interno.
- Pseudoproveedor sin parent se conserva como proveedor operativo; no se convierte a REAL.

## 7. Comparación con Brand/Supplier links

La arquitectura nueva es:

`products.bsale_brand_id -> integraciones.bsale_brand_supplier_links -> supplier REAL`

Los links son manuales, únicos por empresa/Brand, requieren supplier REAL activo y dejan auditoría propia en `portal.audit_logs`.

No participan hoy en el preview ni en la creación de liquidaciones.

### Perfil observado

- Productos: 3.645; activos: 1.243.
- Mappings: 3.752; activos: 3.704.
- Suppliers: 306; REAL: 27; `BSALE_OPERATIVE`: 279.
- Brand candidates: 22; links aprobados: 21.
- Estado de Brand candidates: 21 `LINKED`, 1 `PENDING`, 0 `CONFLICT`.
- Productos involucrados en líneas persistidas o reglas activas: 921.
- De esos 921: 773 con Brand, 148 sin Brand, 770 con Brand LINKED y 3 asociados al Brand PENDING.
- Comparando el supplier actual normalizado al parent contra el link Brand, 770 pudieron compararse: 738 coinciden y 32 difieren.

La cifra de 738/32 es impacto analítico, no cambio operacional. No implica que Brand deba reemplazar al mapping.

## 8. Reglas existentes y perfil de datos

Perfil de la empresa activa:

- Reglas totales: 269.
- Reglas activas/no archivadas: 164.
- Reglas archivadas: 103.
- Reglas activas por alcance: 152 PRODUCT y 12 SUPPLIER; 0 GROUP y 0 GENERAL almacenadas.
- Reglas activas por tipo: 164 FIXED_PERCENT; 0 por monto; 0 por cantidad.
- Reglas activas por supplier: 12 REAL, 0 BSALE_OPERATIVE.
- Productos distintos referenciados por reglas activas: 152.
- Perfiles de vendedor: 5; vendedores visibles en documentos primarios: 8.
- Vendedores comisionables y activos observados: Bsale 15 y 41.
- Liquidaciones: 6; 1 `ISSUED` y 5 `CANCELLED`.
- Líneas persistidas: 21.393: 14.763 `HISTORICAL_MARK`, 6.429 `INVOICE`, 201 `CREDIT_NOTE`.
- En líneas persistidas con supplier: 6.491 supplier REAL, 14.376 `BSALE_OPERATIVE` con parent, 525 `BSALE_OPERATIVE` sin parent.
- Productos involucrados con mapping actual preferred: 835 con operative parent, 59 con operative sin parent y 27 sin mapping resoluble. El conjunto incluye líneas históricas, liquidaciones normales y productos de reglas activas.

No se observaron reglas activas almacenadas directamente contra `BSALE_OPERATIVE`; sí existe una dependencia amplia de pseudoproveedores en las líneas históricas y normales.

## 9. Ventas, descuentos, NC y devoluciones

### Descuentos y promociones

No hay campos ni ramas específicas para descuento en comisiones. Se usa el neto de detalle tal como está sincronizado. Promociones, bonificaciones, regalo o precio cero sólo afectan indirectamente el neto/cantidad recibido.

### Notas de crédito

La versión posterior de preview agrega líneas `CREDIT_NOTE` por cada detalle de NC:

- Busca referencia al número de factura original.
- Documento NC: `document_type_id = 2`.
- Matchea SKU NC contra SKU de la factura original.
- Usa cantidad y neto negativos (`-ABS(...)`).
- Mantiene vendedor y referencia a factura original.
- Exige que la NC tenga `emission_date <= p_period_to`.
- Calcula comisión negativa con el porcentaje/regla que resulte del preview.

La NC es line-level y puede reducir la liquidación. No existe una rama separada explícita para una devolución distinta de una nota de crédito Bsale referenciada.

### Anulación

Anular una liquidación emitida cambia su estado a `CANCELLED`, conserva correlativo y libera `eligibility_locked_at` de líneas `INVOICE`/`CREDIT_NOTE`. Esto permite que vuelvan a ser elegibles en otro preview. No modifica la liquidación histórica.

## 10. Vendedor y cliente

### Vendedor

La identidad operacional es `seller_bsale_id` numérico de Bsale. No existe mapping por email ni usuario ERP en este dominio. El perfil interno se relaciona por `(company_id, seller_bsale_id)` y agrega tipo, activo, comisionable y notas.

La vista toma sólo `bsale_document_sellers.is_primary = true`. Un vendedor sin perfil se considera no comisionable; un perfil inactivo también. Se observan vendedores en documentos sin perfil, además de perfiles desactivados.

### Cliente

El cliente participa sólo como filtro de elegibilidad:

- `customer_reporting_profiles.is_internal_account = true` excluye.
- `customer_reporting_profiles.is_commissionable = false` excluye.
- Ausencia de perfil implica `is_internal_account = false` e `is_commissionable = true`.

No hay reglas de comisión por cliente, tipo, ciudad/comuna, canal, lista de precios, segmento, B2B ni grupo comercial. Esos datos aparecen en la vista de cobranza, pero no entran en `resolve_commission_rule`.

## 11. Vigencia e historia

La configuración inicial fija:

- `historical_cutoff_date = 2026-06-25`.
- `first_eligible_date = 2026-06-26`.
- `require_full_payment = true`.

El corte histórico se materializa en settlement `HISTORICO` con líneas `HISTORICAL_MARK` bloqueadas. Un trigger impide modificar settlement y líneas históricas.

Las nuevas ventas no guardan una comisión calculada al sincronizarse. La comisión se calcula dinámicamente al preview y se congela cuando se crea el borrador, porque las líneas guardan porcentaje, monto, regla, proveedor/nombre, neto y metadata.

Por tanto:

- antes de crear borrador, cambiar regla/configuración puede cambiar el preview de una venta elegible;
- después de crear borrador, la línea queda bloqueada y el resultado queda persistido;
- emitir no recalcula las líneas;
- cancelar/anular libera el bloqueo y un futuro preview puede recalcular con reglas actuales;
- ventas históricas anteriores al corte no se recalculan ni generan comisión, sólo quedan marcadas.

## 12. Persistencia y estados

Estados reales de `commission_settlements`:

- `DRAFT`: creado desde preview; líneas bloqueadas.
- `ISSUED`: emitido con correlativo `LIQ-YYYY-NNNNNN`.
- `CANCELLED`: cancelado/anulado; conserva registro y motivo.

No existen estados separados `CALCULATED`, `REVIEWED` o `PAID` para la comisión. `ISSUED` representa la liquidación emitida, no un pago financiero externo.

Transiciones implementadas:

- DRAFT -> ISSUED.
- DRAFT -> CANCELLED por cancelación.
- ISSUED -> CANCELLED por anulación.
- HISTORICAL permanece ISSUED y protegido.

El resultado persistido contiene snapshot de neto, porcentaje, monto, regla, proveedor, vendedor, cliente, SKU, fecha de pago y referencias Bsale. El nombre de supplier va también en `metadata`.

## 13. UI, exportaciones y consumidores

Pantallas actuales:

- Simulación por vendedor/período.
- Borradores, con detalle, cancelación y exportación.
- Emitidas, con detalle, PDF/XLSX y anulación.
- Anuladas, con detalle y exportación.
- Configuración de vendedores.
- Configuración de comisión general.
- Grupos/campañas de productos.
- Reglas guiadas por proveedor, grupo o producto.
- Indicador de salud de sincronización Bsale.

La UI de reglas busca proveedores reales, no pseudoproveedores. Sin embargo, la consulta de productos y la visualización de detalles todavía inspeccionan mappings y pueden mostrar proveedor operativo y/o parent según el componente.

Consumidores identificados: panel de comisiones, PDF, XLSX y vistas de clientes que muestran si un cliente es comisionable. No se encontró otro cálculo de comisión independiente.

## 14. Permisos y auditoría

La protección observada es:

- autenticación de usuario;
- empresa activa y `core.has_company_access` en tablas/RPCs;
- `SUPER_USUARIO` para sync manual;
- RLS de tablas de comisión por acceso a empresa.

No se identifican permisos granulares específicos como `comisiones.view`, `comisiones.rules.edit`, `comisiones.approve` o `comisiones.pay`. En consecuencia, el código de acciones no distingue funcionalmente ver, editar, emitir o anular más allá de autenticación/acceso a empresa.

Auditoría existente:

- Campos `created_by`, `updated_by`, `issued_by`, `cancelled_by`, timestamps y motivo de cancelación.
- Protección de histórico mediante triggers.
- Snapshot de líneas en settlement.
- El link Brand -> supplier tiene auditoría explícita en `portal.audit_logs`.

No hay auditoría explícita de historial de versiones para cambios de porcentaje/regla. Los updates guardan el último `updated_by`/`updated_at`, pero no un before/after completo. Tampoco hay evento específico de “recalculo”; el recálculo ocurre como consulta o nueva liquidación.

## 15. Casos representativos

Los casos siguientes son trazas de datos actuales; no se modificó ningún registro.

### Caso A: mapping BSALE_OPERATIVE con parent REAL

- SKU observado: `P302`.
- Producto: `PETFOOD GALLETA HUESO CLASICA POLLO, 350GR RAZA PEQUEÑA`.
- Mapping preferido: `PETFOOD/SNACK` (`BSALE_OPERATIVE`).
- Parent: `PET FOOD FACTORY SPA` (`REAL`).
- SQL final del preview: supplier operativo `PETFOOD/SNACK`.
- Normalización TypeScript posterior: muestra `PET FOOD FACTORY SPA` y puede aplicar fallback de regla SUPPLIER fija.
- Regla: las reglas activas de supplier observadas están contra REAL; el SQL no las resuelve con el ID operativo. El fallback de `simulation.ts` puede asignar una regla fija REAL si coincide el parent.
- Fórmula: neto de línea por porcentaje resuelto, redondeado a CLP.

### Caso B: Brand LINKED

- SKU observado: `P302` también tiene Brand LINKED al REAL `PET FOOD FACTORY SPA`.
- La resolución Brand coincide con el parent normalizado.
- COMISIONES no consulta el link; el resultado actual sigue naciendo del mapping.
- La equivalencia es analítica, no una sustitución operacional.

### Caso C: Brand PENDING / pseudoproveedor sin parent

- SKU observado con pseudoproveedor sin parent: `82493`, `JUGUETE STRONG MORDEDOR PELOTA 9CM ROJA`, supplier `AMIGO/JUGUETES`.
- En el conjunto analizado hay 3 productos con Brand PENDING y 59 con supplier operativo sin parent; este caso debe verificarse uno a uno porque Brand PENDING y supplier sin parent no son necesariamente el mismo producto.
- COMISIONES usa el pseudoproveedor crudo si el mapping es preferred y activo; no hay REAL efectivo disponible.
- Si una regla es sólo por supplier REAL, no hay match automático.

### Caso D: producto sin Brand

- Producto observado sin Brand: `H02028170017`, `FELINNES POUCH SABOR SALMON 85GR`.
- En productos involucrados: 148 sin Brand.
- COMISIONES sigue pudiendo usar mapping activo/preferred aunque no exista Brand.
- La ausencia de Brand no excluye por sí sola la venta.

### Diferencia Brand vs resolución actual

- SKU observado: `518425`, `BEWIDOG LATA RICO EN POLLO 400GR`.
- La comparación encontró una diferencia entre la resolución actual normalizada y el supplier del Brand link.
- Hay 32 productos involucrados con diferencia en el conjunto comparado.
- No se debe migrar esta diferencia automáticamente: puede ser error de mapping, Brand, vínculo manual o producto que comparte una clasificación operacional distinta.

## 16. Riesgos clasificados

### ALTA

- **Resolución inconsistente de supplier:** el SQL final, el postproceso TypeScript y las búsquedas UI no usan exactamente el mismo algoritmo.
- **Pseudoproveedor como identidad de regla:** 14.376 líneas con operative+parent y 525 sin parent muestran dependencia material del modelo histórico.
- **Reglas REAL vs líneas operativas:** 12 reglas activas por supplier están contra REAL, mientras el SQL del preview recibe supplier operativo; el fallback sólo cubre supplier fixed y no es equivalente al motor SQL.
- **Retroactividad antes de persistir:** previews dinámicos cambian si cambia regla, mapping, parent o supplier antes de crear/emitir borrador.
- **Notas de crédito y rangos:** una NC negativa participa en acumulados; puede cambiar el rango aplicable para otras líneas del mismo preview.
- **Archive no uniforme:** una migración agregó el filtro `is_archived = false`, pero la recreación posterior del preview para notas de crédito vuelve a filtrar sólo `r.is_active`; hoy no había reglas activas archivadas en los datos perfilados, pero la semántica histórica queda frágil.
- **Múltiples preferred:** el preview final no tiene desempate `ORDER BY/LIMIT`; si los datos llegan a ese estado puede duplicar líneas o hacer no determinista la comisión.

### MEDIA

- **Pseudoproveedor sin parent:** 525 líneas persistidas y 59 productos involucrados no tienen una identidad REAL para comparar.
- **Productos sin supplier resoluble:** 27 productos involucrados quedan sin mapping preferred en el perfil actual; las ventas elegibles se excluyen silenciosamente por JOIN.
- **Productos sin Brand:** 148 involucrados no pueden evaluarse contra la arquitectura nueva.
- **Brand divergente:** 32 discrepancias entre Brand link y supplier actual normalizado requieren revisión funcional.
- **Permisos amplios:** no hay RBAC granular específico para ver/editar/aprobar/anular comisiones.
- **Auditoría incompleta de reglas:** no existe historial before/after de porcentajes y vigencias.

### BAJA

- **Nombres de vendedor duplicados:** la identidad es el ID Bsale, pero la UI presenta nombre; hay variaciones de nombres de vendedores en Bsale.
- **Campo de estado de pago:** `ISSUED` es estado de liquidación, no confirmación de pago al vendedor.
- **Configuración redundante:** existen componentes antiguos de configuración además del panel actual, lo que eleva riesgo de divergencia de mantenimiento.

## 17. Preguntas y decisiones de negocio posteriores

1. ¿La fuente oficial futura debe ser mapping preferred, Brand link o una política por fecha/entidad?
2. ¿Una regla por supplier REAL debe aplicar también a productos cuyo mapping apunta a operative con ese parent?
3. ¿Qué hacer con operative sin parent: excluir, mantener regla propia o exigir resolución manual?
4. ¿Qué diferencia entre las 32 comparaciones Brand/current es correcta desde negocio?
5. ¿Una nota de crédito debe revertir la regla original congelada o reevaluarse con reglas vigentes?
6. ¿Los rangos deben acumular NC negativas o sólo ventas positivas?
7. ¿Una liquidación anulada debe liberar siempre líneas para recalcular, o conservar un ajuste compensatorio?
8. ¿Debe existir estado separado de pagada y quién puede aprobar/emitir/pagar?
9. ¿Se requiere snapshot explícito de supplier source, supplier operativo, parent y Brand al liquidar?
10. ¿Qué política debe regir cambios de reglas respecto de ventas pagadas pero aún no liquidadas?
11. ¿Se necesitan reglas por cliente/canal/segmento en una fase posterior?
12. ¿Qué permisos granulares y qué auditoría before/after son obligatorios?

## Resumen ejecutivo

1. COMISIONES calcula por línea de factura Bsale, no por documento.
2. Sólo usa facturas tipo 5 totalmente pagadas.
3. La base matemática es el neto de línea, con redondeo CLP.
4. La comisión se calcula dinámicamente en preview y se congela al crear borrador.
5. El histórico hasta 2026-06-25 queda marcado y protegido.
6. La fuente operacional vigente de proveedor es `product_supplier_mappings` activo/preferred.
7. El preview SQL final usa el supplier operativo crudo.
8. Una normalización a parent existe en una migración intermedia y en postproceso TypeScript, pero no como contrato único vigente.
9. Brand y `bsale_brand_supplier_links` no participan hoy en el cálculo.
10. Hay 269 reglas, 164 activas, todas porcentajes fijos; 152 son por producto y 12 por supplier REAL.
11. No hay reglas activas almacenadas contra BSALE_OPERATIVE.
12. El dataset persistido muestra 14.376 líneas operative+parent y 525 operative sin parent.
13. Entre productos involucrados, 770 Brands están LINKED, 3 PENDING y 148 no tienen Brand.
14. La comparación normalizada Brand/current coincide en 738 y difiere en 32.
15. Migrar proveedor sin resolver primero la semántica de parent, reglas, NC, snapshots y permisos tiene riesgo alto.

**Acciones realizadas:** sólo lecturas de repositorio y consultas `SELECT` de perfil. No se modificaron código, datos, schema, suppliers, mappings, productos, Brands, reglas, configuración, commit ni push.
