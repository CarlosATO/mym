# Plan para Corrección de Rendición de Rutas (Fase 3)

## Problemas Identificados

### 1. Guardar cambios no funciona (Bug en ID de fila)
- **Causa exacta**: En `route-settlement-workspace.tsx`, el panel lateral `InvoiceEditPanel` recibe como `item.id` el identificador `settlementItemId` (si existe RR) o `guideItemId` (si no existe RR). Sin embargo, la función `handleApplyEdit` siempre compara contra `r.guideItemId`. Por lo tanto, si la RR ya existe, la comparación falla, la fila local no se actualiza, `isDirty` no cambia a `true`, y el botón de Guardar permanece deshabilitado.
- **Solución**: En `RouteSettlementWorkspace`, pasar explícitamente el `guideItemId` al callback `onApply` (o asegurar que el panel use el `guideItemId` para actualizar), o modificar `handleApplyEdit` para que acepte `guideItemId` en lugar del ID mezclado.

### 2. No se puede subir PDF y bloqueo de subida en RR nueva
- **Causa 1 (Base de Datos)**: La migración `20260630000000_route_settlement_attachments.sql` solo se escribió en el disco, pero nunca se ejecutó en la base de datos real (no corrí `supabase db push`). Esto hace que la tabla y el bucket no existan.
- **Causa 2 (Flujo UI)**: El código actual de `InvoiceEditPanel` deshabilita el botón de "Subir" si no hay `persistedSettlementItemId`.
- **Solución UI**: Modificar `InvoiceEditPanel` para permitir adjuntar comprobantes en estado "staged" (en memoria) como objetos de tipo `File`. Cuando se hace clic en "Aplicar cambios", se envían estos archivos al workspace. En `RouteSettlementWorkspace`, al hacer click en "Guardar cambios", primero se crea la RR y luego se iteran las facturas modificadas para subir sus archivos staged a Storage y registrar su metadata.

## User Review Required
> [!IMPORTANT]
> - Necesito aplicar la migración en tu base de datos de desarrollo. Ejecutaré un comando de supabase o psql para aplicar `20260630000000_route_settlement_attachments.sql`. Si tu base es local, esto será rápido.
> - El flujo de "Archivos en memoria" (Staged Files) se implementará para permitir que la bandeja fluya naturalmente sin obligar a crear la RR vacía antes de adjuntar.

## Proposed Changes

### `src/modules/adquisiciones/rendicion-rutas/components/route-settlement-workspace.tsx`
- **[MODIFY]**: Actualizar `handleApplyEdit` para que reciba el `guideItemId` correcto y soporte un nuevo campo `stagedFiles: File[]` en `EditedItemFields`.
- **[MODIFY]**: En `handleSave`, después de que termine exitosamente `saveRouteSettlementChanges`, revisar si hay filas con `stagedFiles`. Para cada una, hacer el upload a Storage y llamar a `saveSettlementItemAttachment`. Finalmente limpiar `stagedFiles`.
- **[MODIFY]**: Agregar los logs temporales de desarrollo solicitados.

### `src/modules/adquisiciones/rendicion-rutas/components/invoice-edit-panel.tsx`
- **[MODIFY]**: Modificar el prop `onApply` para pasar `guideItemId` y aceptar `stagedFiles: File[]`.
- **[MODIFY]**: Permitir seleccionar archivos aunque no haya `persistedSettlementItemId`, guardándolos en un estado local `stagedFiles`.
- **[MODIFY]**: Mostrar los `stagedFiles` en la lista de comprobantes (con un ícono especial o nota de "Pendiente de guardar").

### `supabase/migrations/20260630000000_route_settlement_attachments.sql`
- **[ACTION]**: Aplicar esta migración en la base de datos.
