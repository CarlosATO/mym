# Vista previa comercial de Auditoría

`previewSalesOrderAuditCommercialAcceptance({ companyId, cardId, auditId })` exige sesión y permiso `logistica.audit.manage` para la empresa activa. Es una lectura: no acepta cambios ni modifica auditoría o incidencias.

Devuelve `{ data, error }`. Ante error, `data` es `null` y `error` identifica la causa. En una lectura válida, `data` contiene `eligible`, `differences`, `errors`, `currentBsaleId`, `previousVersionId`, `historicalTaxRateCertified: false` y `reviewedReference`. `eligible: false` indica diferencias que el comparador no permite aceptar; un error indica que no fue posible construir una vista previa verificable.

`reviewedReference` es un SHA-256 de la versión aceptada, la versión vigente y la evidencia fiscal normalizada, sin la fecha de consulta. No es autorización, ni fingerprint PostgreSQL de aprobación, ni garantiza que los datos sigan vigentes. Una futura confirmación debe autenticar nuevamente, volver a consultar Bsale, comprobar el contexto y recalcular la referencia antes de usar la RPC. La tasa histórica por línea no está certificada.

La evidencia se consulta con GET autenticado y `no-store`. Se rechazan paginaciones incompletas, identidades inconsistentes, exenciones, múltiples impuestos y asociaciones contradictorias. El documento histórico se compara con el snapshot aceptado aunque esté inactivo. Las respuestas siguen los contratos de [documentos](https://docs.bsale.dev/documentos/), [impuestos](https://docs.bsale.dev/impuestos/), [productos](https://docs.bsale.dev/productos-y-servicios/) y [variantes](https://docs.bsale.dev/variantes/).
