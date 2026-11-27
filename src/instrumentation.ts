export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startBsaleSyncQueueServerSupervisor } = await import('./lib/integraciones/bsale-sync-queue-runtime')
    startBsaleSyncQueueServerSupervisor()
  }
}
