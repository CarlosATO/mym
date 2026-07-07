# Plan de Sincronización Hacia Bsale (Writeback) — FASE FUTURA

> **Estado actual:** Bsale es solo lectura. PetGrup replica clientes desde Bsale para análisis y administración interna.  
> **Este documento describe una fase futura, no implementada todavía.**

---

## Contexto

Hoy el flujo es unidireccional:

```
Bsale ──(GET)──► integraciones.bsale_clients ──► comercial.customers
```

Los cambios administrativos realizados en PetGrup (notas, giro, condiciones comerciales) son datos locales en `comercial.customers` y **no se sincronizan con Bsale**.

No existe escritura hacia Bsale en ningún punto de la aplicación.

---

## Por Qué No Se Implementa Ahora

1. Requiere auditar el endpoint de actualización de clientes Bsale (`PUT /v1/clients/:id`).
2. Requiere confirmar los permisos del token actual (lectura solamente vs. escritura).
3. Requiere identificar los campos permitidos y obligatorios en cada endpoint.
4. Requiere definir una política de resolución de conflictos (¿qué gana? ¿Bsale o PetGrup?).
5. Requiere crear una arquitectura de outbox para no escribir de forma síncrona.
6. Requiere un mecanismo de aprobación/revisión antes de enviar cambios.
7. Requiere pruebas con un cliente autorizado en Bsale antes de activar en producción.

---

## Plan de Implementación Futura (8 Fases)

### Fase 1 — Auditoría de Endpoints Bsale
- Revisar documentación de `PUT /v1/clients/:id`.
- Confirmar si el token actual tiene permisos de escritura.
- Mapear campos permitidos (algunos pueden ser ignorados o rechazados).
- Confirmar manejo de errores y rate limits.

### Fase 2 — Política de Conflictos
Definir qué sucede cuando:
- Bsale actualiza un cliente que PetGrup también modificó.
- PetGrup envía un campo que Bsale rechaza.
- PetGrup envía y Bsale devuelve error 4xx/5xx.

### Fase 3 — Tabla Outbox
Crear tabla de cola de cambios pendientes:

```sql
-- NO crear todavía. Solo referencia conceptual.
CREATE TABLE integraciones.bsale_client_outbox (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    customer_id     uuid NOT NULL REFERENCES comercial.customers(id),
    bsale_client_id bigint NOT NULL,
    change_payload  jsonb NOT NULL,
    status          varchar(20) NOT NULL DEFAULT 'DRAFT',
      -- DRAFT | PENDING | SENT | FAILED | CANCELLED
    requested_by    uuid NULL REFERENCES portal.users(id),
    approved_by     uuid NULL REFERENCES portal.users(id),
    sent_at         timestamptz NULL,
    error_message   text NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### Fase 4 — UI de Revisión de Cambios
- Pantalla de revisión de cambios pendientes antes de enviar a Bsale.
- Permite cancelar o aprobar cambio por cambio.
- Muestra diff entre estado PetGrup y estado Bsale.

### Fase 5 — Dry Run
- Simular el envío sin escribir en Bsale.
- Reportar qué campos serían modificados.
- Identificar rechazos potenciales.

### Fase 6 — Prueba Controlada
- Activar solo para un cliente autorizado por Carlos.
- Confirmar que Bsale refleja el cambio correctamente.
- Monitorear respuesta de Bsale.

### Fase 7 — Activación Gradual
- Abrir escritura para un grupo limitado de usuarios.
- Monitorear por al menos 5 días.

### Fase 8 — Producción
- Activar para todos los usuarios con permiso.
- Mantener outbox como registro de auditoría permanente.

---

## Campos Candidatos a Writeback

| Campo PetGrup      | Campo Bsale (tentativo)   | Riesgo |
|--------------------|--------------------------|--------|
| `business_name`    | `company`                | Alto — afecta documentos |
| `email`            | `email`                  | Medio |
| `phone`            | `phone`                  | Bajo |
| `mobile`           | `mobile`                 | Bajo |
| `address`          | `address`                | Medio |
| `city`             | `city`                   | Medio |
| `commune`          | `municipality`           | Medio |
| `business_activity`| `activity`               | Bajo |
| `credit_days`      | Requiere auditoría        | Alto |
| `credit_limit`     | Requiere auditoría        | Alto |
| `rut`              | `code`                   | Muy alto — identificador fiscal |

> Los campos RUT y razón social **no deben modificarse hacia Bsale** sin autorización explícita, ya que afectan documentos tributarios.

---

## Avisos para el Formulario de Edición

Cuando se active la fase de writeback, el formulario deberá mostrar claramente:
- Qué campos se sincronizarán con Bsale.
- Qué campos son solo administrativos en PetGrup.
- Una confirmación explícita antes de escribir en Bsale.

---

*Documento creado: 2026-07-07. Última actualización: 2026-07-07.*  
*Estado: PENDIENTE — no implementado.*
