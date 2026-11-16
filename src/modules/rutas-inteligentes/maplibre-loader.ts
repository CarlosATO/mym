/** Admite la exportación predeterminada UMD y la exportación ESM de MapLibre. */
export async function loadMapLibre(): Promise<typeof import('maplibre-gl')> {
  const loaded = await import('maplibre-gl')
  const library = (loaded as unknown as { default?: typeof loaded }).default ?? loaded
  if (typeof library.Map !== 'function' || typeof library.Marker !== 'function' || typeof library.LngLatBounds !== 'function') {
    throw new Error('MapLibre no está disponible')
  }
  return library
}
