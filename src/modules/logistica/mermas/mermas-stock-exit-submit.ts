export type StockExitSubmitMode = "LEGACY_DESTRUCTION" | "BSALE_REGULARIZATION"
export type RegularizationOutcome = "SENDING" | "RECONCILIATION_REQUIRED" | "LOCAL_APPLICATION_PENDING"

export function resolveStockExitSubmitMode(type: "SALIDA_DESTRUCCION" | "SALIDA_REGULACION"): StockExitSubmitMode {
  return type === "SALIDA_REGULACION" ? "BSALE_REGULARIZATION" : "LEGACY_DESTRUCTION"
}

export function blocksRegularizationSubmit(status: RegularizationOutcome | null) {
  return status === "SENDING" || status === "RECONCILIATION_REQUIRED"
}

export function regularizationOutcomeMessage(status: RegularizationOutcome) {
  if (status === "SENDING") return "La operación ya fue enviada y continúa en proceso. No vuelvas a registrarla."
  if (status === "RECONCILIATION_REQUIRED") return "La recepción requiere revisión antes de continuar. No registres otra salida."
  return "La recepción fue creada en Bsale, pero PetGroup no completó la salida local."
}
