import { DeliveryRoute, RouteVehicle, RoutePersonnel } from '../types';
import { ComboboxOption } from '../components/route-guide-combobox';

export type CatalogEntry = DeliveryRoute | RouteVehicle | RoutePersonnel;

export function dedupOptions(items: CatalogEntry[], type?: string): ComboboxOption[] {
  if (!items || !Array.isArray(items)) return [];

  const map = new Map<string, ComboboxOption>();
  
  items.forEach(item => {
    if (type && (item as RoutePersonnel).person_type !== type) return;
    
    const label = (
      (item as RoutePersonnel).person_name || 
      (item as DeliveryRoute).route_name || 
      (item as RouteVehicle).vehicle_name || 
      ''
    ).trim();

    if (!label) return;
    
    const value = item.id;
    if (!value || typeof value !== 'string') return;
    
    const normalized = label.toUpperCase();
    if (!map.has(normalized)) {
      map.set(normalized, { value, label });
    }
  });
  
  return Array.from(map.values());
}

export function injectCurrentOption(
  options: ComboboxOption[],
  currentValue: string | null | undefined,
  currentLabelSnapshot: string | null | undefined,
  fallbackSuffix: string = '(Inactivo)'
): ComboboxOption[] {
  if (!currentValue || !currentValue.trim()) return options;
  
  const val = currentValue.trim();
  const exists = options.some(o => o.value === val);
  
  if (exists) return options;
  
  const label = currentLabelSnapshot && currentLabelSnapshot.trim() 
    ? `${currentLabelSnapshot.trim()} ${fallbackSuffix}`
    : `Desconocido ${fallbackSuffix}`;
    
  return [{ value: val, label }, ...options];
}
