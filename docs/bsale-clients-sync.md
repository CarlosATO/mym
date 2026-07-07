# Sincronización de Clientes Bsale

El puente de Bsale Clients es el primer conector integrado a la infraestructura `Sync Core`.

## Reglas y Protecciones Estrictas
- **Solo Lectura (GET)**: Esta sincronización NUNCA escribe datos tributarios, comerciales, ni de contacto hacia Bsale. Solo absorbe los cambios y clientes nuevos.
- **Notas Administrativas Protegidas**: El campo `notes` en PetGrup es local y administrativo. La sincronización hace un `upsert` parcial inteligente que NUNCA pisará las notas creadas desde la plataforma de PetGrup.
- **Sin Exposición PII**: Los endpoints y actions devuelven únicamente metadatos genéricos (cuentas, estados). Los datos PII no se imprimen ni se filtran en los logs de sync.

## Modos de Gatillo
1. **Cron Job Externo (cada 30 min)**: `/api/integraciones/bsale/clients/sync` configurado para ser llamado mediante POST/GET autorizando con `CRON_SECRET`.
2. **Server Action (UI)**: Un usuario autorizado puede presionar el botón de "Forzar sincronización" en la pantalla de Clientes del módulo Comercial.
3. **CLI (Scripts)**: Corriendo `npx tsx scripts/sync_bsale_clients.ts`. Se puede ejecutar con banderas como `--dry-run` para pruebas sin afectar datos, o `--apply` para producción.

## Monitoreo
En el UI de Clientes, existe un _Banner de Sincronización_ en la cabecera que consulta dinámicamente si el proceso está `isLocked` (EN PROCESO) o en estado OK, permitiendo al usuario conocer su última sincronización sin navegar a paneles de configuración complejos.
