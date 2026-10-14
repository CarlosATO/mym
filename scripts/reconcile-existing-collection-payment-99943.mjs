// Controlled fixture contract: reconciliation is read-only and never submits a payment.
export const result = { postExecuted: false }
export const request = {
  method: 'GET',
  path: '/payments/99943.json',
}
