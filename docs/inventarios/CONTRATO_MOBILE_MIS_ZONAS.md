# Contrato Mobile: Mis Zonas Activas

**Endpoint / Consumidor**
- Mobile Android App (Tomador físico)
- Conexión vía Supabase Client (REST) autenticado (`auth.uid()`).

**Firma**
`inventarios.list_my_active_counting_zones() RETURNS jsonb`

**Parámetros**
Ninguno.

**Seguridad y Aislamiento**
- **Usuario Autenticado:** Resuelto internamente a través de `inventarios.require_actor()`.
- **Aislamiento:** La consulta cruza `inventarios.task_assignments` forzando `user_id = v_actor_id`. Es imposible por diseño solicitar zonas asignadas a otro tomador, ya que el motor de BD omite cualquier registro que no pertenezca al usuario de la sesión actual.
- **Participante Activo:** Verifica que `session_participants.user_id = v_actor_id` y `revoked_at IS NULL`.
- **Permisos Administrativos:** No se exigen permisos del portal. La seguridad es puramente contextual.
- **Search Path:** Seguro a nivel `pg_catalog` (Hardened `SECURITY DEFINER`).

**Filtros Operacionales**
- Sección: `status = 'COUNTING'`.
- Zona: `is_enabled = true`.
- Asignación: `released_at IS NULL`.
- Tarea: `status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED')`. 
- Tarea (Exclusiones): `cancelled_at IS NULL`, `superseded_at IS NULL`, `invalidated_at IS NULL`.

**Estados Incluidos (Tareas)**
Se incluyen las zonas cuyas tareas están asignadas, en progreso, pausadas o incluso completadas (siempre que la sección siga en conteo, permitiendo al usuario ver su progreso histórico dentro del corte).

**Ordenamiento**
1. Antigüedad de la sección (`s.created_at ASC`)
2. Prioridad operativa (`z.priority ASC`)
3. Código de zona (`z.zone_code ASC`)

**Payload Esperado**
```json
{
  "actor": {
    "id": "uuid",
    "display_name": "Nombre Apellido"
  },
  "zone_count": 2,
  "zones": [
    {
      "session_id": "uuid",
      "session_label": "#2 Inventario Prueba - BODEGA DE RESPALDO",
      "inventory_id": "uuid",
      "inventory_name": "Inventario Prueba",
      "site_id": "uuid",
      "site_name": "BODEGA DE RESPALDO",
      "zone_id": "uuid",
      "zone_code": "Z1",
      "zone_name": "Zona 1",
      "task_id": "uuid",
      "task_status": "ASSIGNED",
      "location_count": 2
    }
  ]
}
```

**Ejecución QA Realizada**
- **CASO A (Carlos):** Evaluado, retorna únicamente las zonas de Carlos (Zona 1, Zona 3) sin fugas de datos de otros usuarios.
- **CASO B (Ana):** Evaluado, retorna únicamente Zona 2 y Zona 4. Aislamiento comprobado.
- **CASO C (Usuario válido sin asignaciones):** Resuelve un `[]` y `zone_count = 0` limpio y sin error de BD.
- **CASO D (No autenticado):** Captura excepción nativa de `require_actor()` rechazando acceso.
- **Reversión QA:** Sin residuos. Cambios de estado en transacciones efímeras.

**Futuras Dependencias (M2)**
- Fetch del `snapshot` e información del stock teórico para poder abrir y empezar a contar físicamente en una zona y ubicación específica.
