import { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { AccessDenied } from '@/components/access-denied';
import { RouteGuidesPanel } from '@/modules/logistica/guias-ruta/route-guides-panel';

export const metadata: Metadata = {
  title: 'Guías de Ruta | WMS | MYM',
  description: 'Gestión de despachos en ruta',
};

export default async function GuiasRutaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <AccessDenied />;

  const { data: allowed } = await supabase.rpc('has_permission', {
    p_permission_code: 'logistica.route_guides.view',
  });
  if (allowed !== true) return <AccessDenied />;

  return <RouteGuidesPanel />;
}
