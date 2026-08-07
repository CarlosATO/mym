# Contrato Mobile: Ubicaciones de Zona de Conteo

**Endpoint / Consumidor**
- Mobile Android App (Tomador físico)
- Conexión vía Supabase Client (REST) autenticado (`auth.uid()`).

**Firma**
`inventarios.get_my_counting_zone_locations(p_zone_id uuid) RETURNS jsonb`

**Parámetros**
- `p_zone_id` (uuid): El ID de la zona seleccionada (obtenido de `list_my_active_counting_zones`).

**Seguridad y Aislamiento**
- **Usuario Autenticado:** Resuelto internamente a través de `inventarios.require_actor()`.
- **Aislamiento Estricto:** La consulta verifica en `inventarios.task_assignments` y `inventarios.session_participants` que el `p_zone_id` corresponde inequívocamente al `user_id = v_actor_id`. Cualquier discrepancia, estado inválido o intento de acceder a zonas ajenas produce una excepción explícita (`INV_ACCESS_DENIED`).
- **Permisos Administrativos:** No se exigen permisos del portal. La seguridad es puramente contextual al inventario.
- **Search Path:** Seguro a nivel `pg_catalog` (Hardened `SECURITY DEFINER`).

**Filtros Operacionales (Autorización)**
- Sección en estado `COUNTING`.
- Zona `is_enabled = true`.
- Tarea vinculada válida (sin `cancelled_at`, `superseded_at`, `invalidated_at`).
- Asignación vigente (`released_at IS NULL`).
- *Nota:* En esta fase de lectura no se muta el estado de la tarea (ej: `ASSIGNED` no pasa a `IN_PROGRESS`).

**Payload Esperado**
```json
{
  "zone": {
    "zone_id": "uuid",
    "zone_name": "Zona 1",
    "zone_code": "Z1",
    "task_id": "uuid",
    "task_status": "ASSIGNED",
    "inventory_name": "Inventario Prueba",
    "site_name": "BODEGA DE RESPALDO"
  },
  "location_count": 2,
  "locations": [
    {
      "location_id": "uuid",
      "location_code": "01-01-A",
      "location_name": "Estante Principal",
      "sort_order": 1
    }
  ]
}
```

**Fuentes de Datos**
- **Ubicaciones:** La fuente de verdad física de la ubicación congelada durante el proceso de conteo proviene de `inventarios.snapshot_locations`, enlazada mediante `inventarios.session_zone_locations`.
- **Orden (Sort Order):** Al carecer el modelo actual de una secuencia operacional estricta, las ubicaciones se ordenan determinísticamente de forma alfanumérica ascendente por código de ubicación y nombre, enumeradas a través de una función de ventana (`row_number()`).
- **Lifecycle de Ubicación:** Actualmente no existe un ciclo de vida granular a nivel de ubicación (OPEN, CLOSED, etc.), por lo que esta RPC se concentra en exponer la estructura física habilitada.

**Ejecución QA Realizada**
- **CASO A (Carlos / Zona 1):** Acceso permitido. Retorna ubicaciones de Zona 1.
- **CASO B (Carlos / Zona 3):** Acceso permitido. Retorna ubicaciones de Zona 3.
- **CASO C (Carlos intenta Zona 2):** Excepción rechazada correctamente (`INV_ACCESS_DENIED`), sin fuga de la asignación de Ana.
- **CASO D (Ana / Zona 2):** Acceso permitido.
- **CASO E (Ana intenta Zona 1):** Excepción rechazada.
- **CASO F (UUID inexistente):** Excepción controlada, manejada por validación transaccional.
- **CASO G (No autenticado):** Rechazado por política basal `require_actor()`.
- **Restricción de Estado:** Se comprobó que consultar ubicaciones NO muta `task_status`.
