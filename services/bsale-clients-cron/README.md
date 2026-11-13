# Cron independiente de clientes Bsale

Este servicio llama al endpoint existente y termina después de recibir su resultado. No contiene credenciales, no inicia un servidor web y no implementa otro sincronizador.

## Configuración propuesta en Railway

En el proyecto `c2c18369-4686-4db6-bad9-2020d22f340e`, ambiente `production`, crear **un servicio separado** del servicio web `mym`:

1. Origen: repositorio GitHub `CarlosATO/mym`, rama `main` que contenga estos archivos.
2. Root Directory: `/services/bsale-clients-cron`. Builder: Railpack con Node.js 20.9 o superior. El directorio no tiene dependencias externas.
3. Start Command: `node cron.mjs`. No configurar comando de predeploy, migraciones ni servidor HTTP.
4. Cron Schedule: `12,42 * * * *` (UTC), todos los días.
5. Variables del nuevo servicio:
   - `PETGROUP_BASE_URL=https://mym.datix.cl` (origen HTTPS sin ruta ni credenciales).
   - `CRON_SECRET`: el mismo valor secreto configurado en el servicio web. Usar una referencia secreta de Railway; no incluirlo en el repositorio ni en logs.
   - `CLIENTS_SYNC_TIMEOUT_MS=600000` (opcional; por defecto 600000, rango 1000–1200000).
6. Confirmar que el servicio web tenga configurado `CRON_SECRET` y que el endpoint sea accesible desde el servicio cron. No ejecutar manualmente sin autorización.

La llamada se envía mediante POST al endpoint fijo `/api/integraciones/bsale/clients/sync`. Solo un HTTP exitoso con JSON `{ "status": "SUCCESS" }` termina con código 0. `FAILED`, `SKIPPED`, HTTP no exitoso, JSON inválido, error de red o timeout terminan con código 1. No se imprime el cuerpo de la respuesta ni el secreto y no se reintenta automáticamente.

## Verificación posterior, solo lectura

Consultar `integraciones.sync_runs` filtrando `provider = 'BSALE'`, `entity = 'clients'` y la empresa operativa. Revisar `started_at`, `finished_at`, `duration_ms`, `status`, `read_count`, `error_count` y `message` para distinguir `SUCCESS`, `FAILED` y `SKIPPED`. El endpoint usa `trigger_type = 'SCHEDULED'`. Una consulta de diagnóstico posible es:

```sql
SELECT started_at, finished_at, duration_ms, status, read_count, error_count, message
FROM integraciones.sync_runs
WHERE company_id = :company_id AND provider = 'BSALE' AND entity = 'clients'
ORDER BY started_at DESC LIMIT 20;
```

Para observar la última finalización exitosa, filtrar además `status = 'SUCCESS'` y `finished_at IS NOT NULL`; descartar ejecuciones de prueba o limitadas si se realizan por otra vía. Comparar con el log del servicio cron y verificar el `last_sync_at` y `raw_payload->'commerciallyBlocked'` del cliente correspondiente con una consulta autorizada de solo lectura.

## Limitaciones operativas

- Railway programa en UTC, no garantiza precisión al minuto y omite una ejecución si la anterior sigue activa. Debe existir monitoreo externo de antigüedad del último éxito.
- La sincronización general y la llamada independiente reutilizan el lock existente de `company_id/provider/entity`; una superposición puede devolver `SKIPPED`, que este proceso registra como fallo de ejecución y no como éxito.
- El timeout cancela la espera HTTP, pero **no garantiza cancelar el trabajo que ya se esté ejecutando en el servidor web**. La lectura de clientes limita los 429 a cuatro reintentos por página y a ocho minutos en total; las operaciones de base de datos no comparten ese límite. El lock vence a los 60 minutos, por lo que una ejecución prolongada requiere supervisión.
- La sincronización de clientes exige que se persista `SUCCESS` antes de responder con éxito. Si la base de datos tampoco permite registrar el estado `FAILED`, el endpoint falla y la ejecución puede quedar como `RUNNING`; supervisar registros antiguos y errores del servicio web.
- El endpoint actual usa una única empresa configurada en código. Este servicio no cambia ese alcance ni modifica `sync_job_configs`.

## Pruebas locales sin red

Ejecutar `npm test` desde este directorio. Las pruebas usan mocks y no llaman a Bsale, Supabase ni al endpoint real.
