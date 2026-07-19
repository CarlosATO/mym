export const MOVEMENT_RULES = {
  PENDING_ROUTE_PREP: {
    IN_PREPARATION: { allowed: true, backward: false, label: 'Iniciar preparación' },
  },
  IN_PREPARATION: {
    IN_AUDIT: { allowed: true, backward: false, label: 'Enviar a auditoría' },
    PENDING_ROUTE_PREP: { allowed: true, backward: true, label: 'Volver a pendiente' },
  },
  IN_AUDIT: {
    IN_PREPARATION: { allowed: true, backward: true, label: 'Devolver a preparación' },
    PENDING_ROUTE_PREP: { allowed: true, backward: true, label: 'Rechazar / volver a pendiente' },
  }
} as const;

export function getMovementRule(fromStatus: string, toStatus: string) {
  if (toStatus === 'INVOICED_READY_FOR_ROUTE') {
    return { error: 'Este estado se asigna automáticamente al facturar.' };
  }
  if (toStatus === 'CANCELLED') {
    return { error: 'La cancelación requiere un flujo separado.' };
  }

  const rulesFrom = MOVEMENT_RULES[fromStatus as keyof typeof MOVEMENT_RULES];
  if (!rulesFrom) return { error: 'Estado de origen inválido.' };

  const rule = (rulesFrom as any)[toStatus];
  if (!rule || !rule.allowed) {
    return { error: 'Transición inválida o no permitida.' };
  }

  return { rule };
}
