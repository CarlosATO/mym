import { Metadata } from 'next';
import { RouteGuidesPanel } from '@/modules/logistica/guias-ruta/route-guides-panel';

export const metadata: Metadata = {
  title: 'Guías de Ruta | Logística | MYM',
  description: 'Gestión de despachos en ruta',
};

export default function GuiasRutaPage() {
  return <RouteGuidesPanel />;
}
