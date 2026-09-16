# Auditoría y Diseño de Recepción de Webhooks de Pagos Bsale (Fase GC-01B)

## 1. Resumen Ejecutivo
Esta auditoría evalúa la viabilidad técnica y operativa de implementar webhooks de Bsale para recibir notificaciones en tiempo real sobre la creación, modificación y anulación de pagos. Se concluye que los webhooks son el mecanismo ideal para solucionar la "ceguera histórica" del actual sync incremental de 14 días. Sin embargo, dado que Bsale no provee firmas criptográficas fuertes y los eventos pueden perderse, los webhooks deben usarse estrictamente como señales de actualización (pings) y no como portadores de verdad financiera. La reconciliación nocturna (CV-1D) sigue siendo obligatoria.

## 2. Evidencia Oficial Bsale
La documentación oficial de Bsale y su portal de desarrolladores (Bsale Labs, docs.bsale.dev) confirman la existencia del ecosistema de webhooks.
* **URLs:** `https://docs.bsale.dev/`, `https://bsalelabs.com/`
* **Soporte:** Se permiten webhooks para documentos, productos, stock y **pagos**.

## 3. Eventos Exactos Soportados y Semántica
Bsale envía notificaciones HTTP POST a la URL suscrita.
* **Acciones (`action`):** `POST` (Creación) y `PUT` (Actualización).
* **Ausencia de DELETE:** Bsale **no envía notificaciones DELETE**. Cuando un documento o pago es anulado o eliminado, Bsale dispara un evento `PUT`, y es responsabilidad del receptor consultar el estado del recurso para notar que su campo `state` cambió (generalmente a `1` indicando inactivo/anulado).

## 4. El Caso Crítico (Modificación Histórica)
**Escenario:** Pago creado hace 45 días, anulado hoy en Bsale.
* **¿Bsale genera webhook?** SÍ. Se gatillará un evento `PUT` hoy.
* Esto soluciona la ceguera del cron actual, ya que MYM recibirá hoy una notificación que indica que el recurso histórico cambió, permitiendo su actualización inmediata sin importar cuándo fue creado originalmente.

## 5. Payload Real
El payload estándar de Bsale contiene la siguiente metadata base:
```json
{
  "action": "PUT",
  "topic": "payment",
  "resource": "payments",
  "resourceId": 12345,
  "cpnId": "IDENTIFICADOR_INSTANCIA_BSALE"
}
```
* **NO DOCUMENTADO:** No se garantiza la presencia de timestamps específicos ni un ID de evento único inmutable en el payload base.

## 6. Seguridad y Autenticidad
* **NO DOCUMENTADO:** Bsale no documenta el uso de firmas criptográficas (HMAC) o cabeceras secretas inyectables desde el panel de control estándar.
* **Mitigación Crítica Propuesta (Zero-Trust):** El endpoint de MYM **nunca** debe modificar saldos usando los datos que lleguen en el payload del webhook. El webhook debe ser tratado exclusivamente como un aviso o "ping".
* **Flujo Seguro:** Al recibir el webhook, MYM utilizará el `resourceId` para ejecutar un `GET /v1/payments/{id}.json` usando su propio token seguro (`BSALE_ACCESS_TOKEN`). Esa respuesta es la que se persistirá. Si el webhook era falso o malicioso, el GET traerá la verdad, previniendo inyección financiera.

## 7. Política de Retries y Garantías
Bsale realiza reintentos automáticos si el endpoint receptor no devuelve un status `2xx`, pero:
* Los eventos no garantizan orden cronológico estricto (puede llegar un PUT antes de un POST por latencia de red).
* Existe riesgo de eventos duplicados.
* Existen caídas posibles del ERP (Railway) o rate limits que agoten los retries de Bsale.

## 8. Arquitectura MYM y Reutilización de Código
* **Autenticación:** El sistema usa `src/lib/bsale/client.ts` (`BSALE_ACCESS_TOKEN`) para conectarse de manera segura a Bsale mediante la función `bsaleFetch()`.
* **Ruta Recomendada en MYM:** `POST /api/integraciones/bsale/webhooks/payments`
* **Desempeño:** La ruta debe responder `200 OK` inmediatamente, antes de consultar a Bsale, para evitar timeouts y no bloquear hilos valiosos en Vercel/Node.

## 9. Estrategia de Idempotencia y Multitenancy
* **Multiempresa:** Bsale envía un `cpnId` que corresponde a la cuenta/instancia. El webhook debe mapear el `cpnId` hacia el `company_id` local (posiblemente vía configuración o `companies_metadata`). **Mecanismo fail-closed:** Si no se encuentra `company_id` asociado, retornar 200 y descartar.
* **Idempotencia:** Se garantiza al consultar Bsale. Múltiples eventos sobre el mismo `resourceId` simplemente gatillarán varios `GET` y sobrescribirán el registro (Upsert), garantizando un estado eventualmente consistente (`Eventual Consistency`).

## 10. Persistencia: Registro de Eventos
Se recomienda crear una pequeña tabla *append-only* en Supabase: `integraciones.bsale_webhook_events`.
* **Columnas:** `company_id`, `resource_type`, `resource_id`, `action`, `received_at`, `status` (PENDING, PROCESSED, ERROR).
* **Motivo:** Permite devolver HTTP 200 rápidamente al servidor de Bsale y desacoplar el consumo (evitando romper rate limits propios si llegan 1000 webhooks simultáneos).

## 11. Flujo Recomendado de Procesamiento
1. **Recepción (Síncrona):** Bsale hace POST. MYM resuelve `company_id` a partir de `cpnId`. Inserta el payload en `bsale_webhook_events`. Responde HTTP 200.
2. **Consumo (Asíncrono/Worker):** Un job lee los eventos PENDING.
3. **Fetching:** Ejecuta `bsaleFetch('/payments/' + resource_id)`.
4. **Mutación:** Actualiza/inserta el pago en el espejo local (`integraciones`).
5. **Resolución:** Marca el evento como PROCESSED.

## 12. Coexistencia con el Sync Actual de 14 Días
**NO chocarán.**
El sync actual funciona agrupando fechas de registro. El webhook modificará pagos individuales. Si ambos actúan sobre el mismo pago, el Upsert (por `bsale_id`) simplemente lo sobrescribirá con el mismo dato correcto, sin generar duplicados.

## 13. ¿Seguimos Necesitando Reconciliación?
**SÍ, rotundamente.**
Los webhooks sufren del problema de "evento perdido" (si MYM está en mantenimiento o la red de Bsale falla). La reconciliación periódica (diseñada en CV-1D a través del endpoint `unpaid_documents`) es la red de seguridad obligatoria para detectar asimetrías financieras que escaparon a los webhooks.

## 14. Riesgos
* **P0 - Spoofing (Falsificación):** Un atacante externo inunda el endpoint simulando ser Bsale. (Mitigación: Tratado como ping. El `GET` autenticado posterior absorberá el ataque y confirmará la falsedad, aunque podría causar agotamiento de Rate Limit si no se agregan bloqueos por IP de Bsale).
* **P1 - Pérdida de eventos:** Falta de alta disponibilidad. (Mitigación: Reconciliación nocturna obligatoria).
* **P2 - Asignación Empresa:** Un `cpnId` no configurado en multiempresa descarta operaciones silenciosamente.

## 15. MVP Futuro Dividido en Bloques (Sin implementación actual)
1. **GC-01C1 — Registro y Receptor:** Migración SQL de `bsale_webhook_events` y creación del endpoint API POST de recepción rápida (sin procesamiento).
2. **GC-01C2 — Procesador Asíncrono de Pagos:** Función y worker/cron que lee eventos de pagos, hace el `GET` a Bsale e impacta las tablas transaccionales.
3. **GC-01C3 — Observabilidad:** Monitoreo y dashboards para fallos en el procesamiento del evento.

## 16. Recomendación Final
Los webhooks de Bsale son un complemento perfecto (Real-time y captura de modificaciones históricas) para nuestro ecosistema de sincronización, siempre que se traten bajo la estrategia "Zero-Trust" (ping-then-fetch) propuesta. 

---
*Fin de la auditoría. Este bloque ha sido generado sin modificar código, rutas, migraciones ni bases de datos.*
