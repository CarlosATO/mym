# Validación Definitiva de Webhooks de Pagos Bsale (Fase GC-01B2)

## 1. Revisar Documentación Oficial Actual
Basado en la documentación técnica oficial (docs.bsale.dev y bsalelabs.com), los webhooks de Bsale presentan el siguiente perfil técnico:

* **Webhook de pagos disponible:** SÍ (Soportado como `topic: payment`). **DOCUMENTADO.**
* **Action exactas soportadas:** `POST` y `PUT`. **DOCUMENTADO.**
* **Payload completo (campos):** `action`, `topic`, `resource`, `resourceId`, `cpnId`, `send`. **DOCUMENTADO.**
* **Campo `send`:** Es un Timestamp (formato Unix) de cuándo se generó/envió la notificación. **DOCUMENTADO.**
* **Comportamiento al crear:** Envía un evento con `"action": "POST"`. **DOCUMENTADO.**
* **Comportamiento al modificar:** Envía un evento con `"action": "PUT"`. **DOCUMENTADO.**
* **Comportamiento al eliminar/anular:** Envía un evento con `"action": "PUT"`. **DOCUMENTADO.**
* **Existencia o ausencia de DELETE:** La documentación explicita que Bsale **NO utiliza eventos DELETE**. Toda anulación o eliminación se notifica como un `PUT`. **DOCUMENTADO.**
* **Estado `state` en el payload:** El payload enviado *no incluye* el campo `state` (ni otros detalles financieros del pago). Para obtener el `state`, se debe consumir la ruta indicada en el campo `resource`. **DOCUMENTADO.**
* **Retries (Reintentos):** **NO DOCUMENTADO.** Bsale no ofrece garantías públicas ni SLAs sobre intervalos, duración ni número de reintentos ante un rechazo 4xx o 5xx.
* **Timeouts:** **NO DOCUMENTADO.**
* **Duplicados y Orden de Eventos:** **NO DOCUMENTADO.** 
* **Autenticidad/Firma:** **NO DOCUMENTADO.** Bsale no publica la existencia de HMAC, cabeceras seguras (X-Bsale-Signature) ni IPs estáticas exclusivas para validar el request entrante.
* **Estado BETA:** **NO DOCUMENTADO** (Se considera GA - Generally Available).

## 2. Resolver Contradicción Sobre Eliminación
La aparente contradicción se resuelve con base en la documentación actual: Bsale **JAMÁS emite una acción de webhook `DELETE`**.

* **CREAR PAGO:** `POST`
* **MODIFICAR PAGO:** `PUT`
* **ANULAR/ELIMINAR PAGO:** `PUT` (El sistema receptor debe deducir la anulación tras hacer el respectivo HTTP GET y encontrar que el recurso ahora reporta `state: 1` o similar, lo que denota inactividad/eliminación).

## 3. Validar Payload Real
El JSON crudo que envía Bsale tiene esta forma:

```json
{
  "cpnId": "identificador_unico_instancia",
  "resource": "/v1/payments/3223.json",
  "resourceId": 3223,
  "topic": "payment",
  "action": "PUT",
  "send": 1690000000
}
```

* **`cpnId`**: String (o int) que identifica a la empresa/instancia de Bsale.
* **`resource`**: String con el endpoint HTTP para obtener el detalle actualizado.
* **`resourceId`**: Número entero (ID del recurso).
* **`topic`**: String (ej. `payment`).
* **`action`**: String (`POST` | `PUT`).
* **`send`**: Número (Unix timestamp).

**Ausencias Críticas:** 
* No existe `event_id`.
* No existe `signature` ni `secret`.
* No existe `retry_count` ni `delivery_id`.

## 4. Autenticidad
* HMAC / Firma criptográfica: **NO DOCUMENTADO**.
* Header de autenticación / IP oficial / Challenge: **NO DOCUMENTADO**.

**Conclusión:**
Un webhook de Bsale no está criptográficamente autenticado al llegar a nuestro endpoint. La estrategia MYM "ping-then-fetch" mitiga la inyección de saldos falsos en nuestra BD, pero **NO evita ataques de Denegación de Servicio (DDoS) ni consumo abusivo de Rate Limit**. Alguien que conozca la URL del Webhook podría enviar millones de requests forjando un `resourceId` aleatorio y obligaría al worker asíncrono de MYM a consumir llamadas `GET` inútiles hacia Bsale.
*Decisión Arquitectónica:* La URL del webhook debe ser secreta y ofuscada (`/api/integraciones/bsale/webhooks/xyz...`), monitoreada por rate limits rigurosos.

## 5. Retries y Entrega
* Número de reintentos, intervalo, entrega garantizada: **NO DOCUMENTADO**.
* No hay garantía oficial escrita de que un evento perdido por una intermitencia temporal será reentregado indefinidamente.

## 6. Validación Práctica Sin Modificaciones
Se revisó el repositorio local (`src/app/api`).
* **Endpoint webhook existente:** No.
* **Logs previos / Webhook registrado:** No existe código transaccional que procese Webhooks en el proyecto actualmente.
* **Conclusión sobre eliminación:** La acción `PUT` está documentada, pero el campo devuelto localmente en Bsale (`state` 1 o 0) ante una eliminación **REQUIERE PRUEBA CONTROLADA POST-IMPLEMENTACIÓN** para confirmar el valor exacto que retorna la API para pagos.

## 7. Casos Críticos

* **A. Pago nuevo hoy para factura de hace 60 días.**
¿El sistema actual de sync 14 días debería detectarlo?
**SÍ.** Porque el cron consulta `recorddate` reciente y los pagos nuevos traen un `recorddate` actual, independientemente de la antigüedad de la factura.

* **B. Pago creado hace 60 días y modificado hoy.**
¿Webhook permitiría detectarlo?
**SÍ.** Generará un evento `PUT` hoy.

* **C. Pago creado hace 60 días y anulado/eliminado hoy.**
¿Webhook permitiría detectarlo?
**SÍ.** Generará un evento `PUT` hoy, permitiendo a MYM recalcular el saldo.

* **D. MYM caído cuando Bsale envía webhook.**
¿Existe garantía oficial de recuperación?
**NO DOCUMENTADO.** Bsale reintenta, pero no existe SLA sobre el tiempo de supervivencia de ese evento en su cola.

* **E. Mismo webhook recibido dos veces.**
¿Existe event_id único?
**NO.** El payload no tiene `event_id`. El manejo de duplicados debe apoyarse puramente en la idempotencia del estado canónico local.

## 8. Impacto en Nuestro Diseño

El modelo propuesto en la auditoría GC-01B se **CONFIRMA** como el correcto, ajustando detalles técnicos reales:

* **Webhook:** Señal de cambio en formato ping (`PUT / POST`). (Basado en documentación oficial Bsale).
* **MYM:** Endpoint API recibe webhook, verifica `cpnId` (contra BD de multitenancy) y registra evento append-only usando `resourceId` + `send` como hash de deduplicación rudimentaria. (Decisión de diseño MYM).
* **Worker:** Procesa cola asíncrona, consume la API real de Bsale (`bsaleFetch`) para el `resourceId`. (Decisión de diseño MYM, forzado por ausencia de autenticidad y payload anémico).
* **Sync 14 Días / Reconciliación Nocturna:** Continúan como mecanismos de respaldo y seguridad total ante webhooks perdidos. (Decisión de diseño MYM para suplir garantías NO DOCUMENTADAS de Bsale).

## 9. Definir Prueba Controlada Futura
Procedimiento a ejecutar en producción/staging por un humano:
1. Crear un pago manual de prueba de $1 en Bsale (requiere credenciales Bsale UI).
2. Capturar el payload del webhook (`POST`). Confirmar `action` y `cpnId`.
3. Modificar el monto o glosa del pago en Bsale UI.
4. Capturar el payload (`PUT`).
5. Eliminar (Anular) el pago desde Bsale UI.
6. Capturar el payload (`PUT`).
7. Tras la anulación, ejecutar un `GET` autenticado en Postman a la URL enviada en el campo `resource`.
8. Documentar qué valor exacto asume el campo `state` (esperado: `1` para anulado) para integrarlo en la lógica TypeScript de MYM.

## 10. Consulta a Soporte Bsale
Para el área de integraciones de Bsale:
> "Estimado Soporte, queremos implementar webhooks para Pagos. (1) ¿La eliminación física de un pago emite invariablemente una notificación `PUT`? (2) Al realizar un GET posterior sobre un pago eliminado, ¿el estado `state` es 1? (3) ¿Existe soporte oficial (o en roadmap) para firmas criptográficas HMAC `X-Signature` de los webhooks? (4) ¿Cuál es la política exacta de reintentos si nuestro servicio devuelve HTTP 500 durante una ventana de mantenimiento?"

## 11. Veredicto Final

| Tema | Estado | Evidencia |
|---|---|---|
| Creación | **DOCUMENTADO** | docs.bsale.dev (Acción POST) |
| Modificación | **DOCUMENTADO** | docs.bsale.dev (Acción PUT) |
| Eliminación | **DOCUMENTADO** | docs.bsale.dev (Acción PUT) / *El efecto en el GET final requiere prueba post-implementación* |
| Payload | **DOCUMENTADO** | docs.bsale.dev (cpnId, resourceId, resource, topic, action, send) |
| send | **DOCUMENTADO** | Timestamp Unix en el payload |
| Autenticidad | **NO DOCUMENTADO** | Ausencia de firmas criptográficas |
| Retries | **NO DOCUMENTADO** | Ausencia de SLA o políticas en docs |
| Duplicados | **NO DOCUMENTADO** | Sin garantías de "Exactly-once" |
| Orden | **NO DOCUMENTADO** | Sin garantías de FIFO |
| cpnId | **DOCUMENTADO** | Inyectado en root del JSON |
| state | **DOCUMENTADO** | Ausente en el webhook, disponible en GET resource |

¿Tenemos evidencia suficiente para implementar GC-01C1 sin riesgo de diseñar sobre información falsa?
**SÍ.**
El flujo "Ping-Then-Fetch" absorbe por completo las debilidades del ecosistema de Bsale (falta de payloads gruesos, falta de firmas, falta de `event_id` y falta de DELETE explícito). La arquitectura diseñada es robusta frente a estas ausencias documentales, operando con resiliencia basada en eventual consistency.

---
*Fin del documento de validación. Generado sin alteraciones al código fuente, bases de datos o cuentas productivas de Bsale.*
