'use server';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { unstable_cache } from 'next/cache';
import { revalidateTag } from 'next/cache';
import { RouteGuide, CatalogOptions, RoutePersonnelType } from '@/modules/logistica/guias-ruta/types';
import { getActiveCompanyId } from '@/app/actions/companies';

const CACHE_TAG_CATALOGS = 'route-guide-catalogs';

// ---- Types ---------------------------------------------------------------

export interface RouteDuplicateInvoice {
  invoice_number: string;
  customer_name: string;
  existing_guide_id: string;
  existing_guide_number: string;
  existing_status: 'DRAFT' | 'DISPATCHED';
  existing_guide_date: string;
  route_name_snapshot: string;
}

export interface RouteSaveDuplicateWarning {
  type: 'DUPLICATE_INVOICES';
  duplicates: RouteDuplicateInvoice[];
}

export interface SaveRouteGuideDraftResult {
  id: string;
  guide_number: string;
  status: 'DRAFT';
  warnings: RouteSaveDuplicateWarning[];
}

export interface DispatchRouteGuideResult {
  id: string;
  status: 'DISPATCHED';
  warnings: RouteSaveDuplicateWarning[];
}

// ---- Client Factory -------------------------------------------------------

async function createLogisticaClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'logistica' },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

// ---- Queries ---------------------------------------------------------------

export async function getRouteGuides(filters?: { status?: 'ALL' | 'DRAFT' | 'DISPATCHED'; guide_number?: string }) {
  const supabase = await createLogisticaClient();
  let query = supabase
    .from('route_guides')
    .select(`
      id, company_id, guide_number, guide_date, status,
      route_name_snapshot, vehicle_name_snapshot, driver_name_snapshot, seller_name_snapshot, dispatcher_name_snapshot,
      total_invoices, total_amount, error_count, duplicate_count
    `)
    .order('guide_date', { ascending: false })
    .order('guide_number', { ascending: false });

  if (filters?.status && filters.status !== 'ALL') {
    query = query.eq('status', filters.status);
  }
  if (filters?.guide_number) {
    query = query.ilike('guide_number', `%${filters.guide_number}%`);
  }

  const { data, error } = await query.limit(50);
  if (error) throw error;
  return data || [];
}

export async function getRouteGuideById(id: string): Promise<RouteGuide | null> {
  const supabase = await createLogisticaClient();
  
  // Get company_id from user's active session or user's access
  // But RLS on route_guides handles it. We'll explicitly check it returns data.
  const { data: guide, error: guideError } = await supabase
    .from('route_guides')
    .select(`
      id, company_id, guide_number, guide_date, status,
      route_id, route_name_snapshot,
      vehicle_id, vehicle_name_snapshot,
      driver_id, driver_name_snapshot,
      seller_id, seller_name_snapshot,
      dispatcher_id, dispatcher_name_snapshot,
      notes,
      total_invoices, total_amount,
      total_cash_expected, total_check_expected,
      total_credit, total_transfer, total_unknown_payment,
      error_count, duplicate_count
    `)
    .eq('id', id)
    .maybeSingle();

  if (guideError) {
    throw new Error(`Error BD cargando cabecera de la guía: ${guideError.message}`);
  }

  if (!guide) {
    throw new Error(`Guía no encontrada en base de datos. Asegúrese de tener acceso a esta empresa. ID: ${id}`);
  }

  const { data: items, error: itemsError } = await supabase
    .from('route_guide_items')
    .select(`
      id, route_guide_id, line_number, invoice_number,
      customer_name, customer_address, commune,
      amount, payment_method_original, payment_method_normalized,
      requires_settlement, validation_status, validation_errors,
      notes, settlement_status
    `)
    .eq('route_guide_id', id)
    .order('line_number', { ascending: true });

  if (itemsError) {
    throw new Error(`Error BD cargando ítems de la guía: ${itemsError.message}`);
  }

  return { ...guide, items: items ?? [] } as RouteGuide;
}

export async function getRouteGuideCatalogOptions(): Promise<CatalogOptions> {
  const supabase = await createLogisticaClient();

  const [routesRes, vehiclesRes, personnelRes] = await Promise.all([
    supabase.from('delivery_routes').select('id, company_id, route_name, description, is_active').eq('is_active', true).order('route_name'),
    supabase.from('route_vehicles').select('id, company_id, vehicle_name, plate_number, description, is_active').eq('is_active', true).order('vehicle_name'),
    supabase.from('route_personnel').select('id, company_id, person_name, person_type, phone, email, is_active').eq('is_active', true).order('person_name'),
  ]);

  if (routesRes.error) throw routesRes.error;
  if (vehiclesRes.error) throw vehiclesRes.error;
  if (personnelRes.error) throw personnelRes.error;

  return {
    routes: routesRes.data || [],
    vehicles: vehiclesRes.data || [],
    personnel: personnelRes.data || [],
  };
}

export const getCachedRouteGuideCatalogOptions = unstable_cache(
  async () => getRouteGuideCatalogOptions(),
  ['route-guide-catalogs'],
  { tags: [CACHE_TAG_CATALOGS], revalidate: 300 }
);

export async function revalidateRouteGuideCatalogs() {
  revalidateTag(CACHE_TAG_CATALOGS, { expire: 0 });
}

// ---- Catalog Inline Creations ---------------------------------------------

export async function createRouteVehicleInline(vehicleName: string) {
  const supabase = await createLogisticaClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Not authenticated');

  const companyId = await getActiveCompanyId();
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.');

  const { data, error } = await supabase.rpc('create_route_vehicle_inline', {
    p_company_id: companyId,
    p_vehicle_name: vehicleName,
    p_user_id: userData.user.id,
  });

  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || 'Error creando vehículo');
  await await revalidateRouteGuideCatalogs();
  return data.id as string;
}

export async function createDeliveryRouteInline(routeName: string) {
  const supabase = await createLogisticaClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Not authenticated');

  const companyId = await getActiveCompanyId();
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.');

  const { data, error } = await supabase.rpc('create_delivery_route_inline', {
    p_company_id: companyId,
    p_route_name: routeName,
    p_user_id: userData.user.id,
  });

  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || 'Error creando ruta');
  await revalidateRouteGuideCatalogs();
  return data.id as string;
}

export async function createRoutePersonInline(personName: string, personType: RoutePersonnelType) {
  const supabase = await createLogisticaClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Not authenticated');

  const companyId = await getActiveCompanyId();
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.');

  const { data, error } = await supabase.rpc('create_route_person_inline', {
    p_company_id: companyId,
    p_person_name: personName,
    p_person_type: personType,
    p_user_id: userData.user.id,
  });

  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || 'Error creando personal');
  await revalidateRouteGuideCatalogs();
  return data.id as string;
}

// ---- Draft / Dispatch Actions --------------------------------------------

export async function saveRouteGuideDraft(
  guideId: string | null,
  guideData: any,
  itemsData: any[]
): Promise<SaveRouteGuideDraftResult> {
  const supabase = await createLogisticaClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Not authenticated');

  const companyId = await getActiveCompanyId();
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.');

  if (guideId) {
    // UPDATE existing draft
    const { data, error } = await supabase.rpc('update_route_guide_draft', {
      p_company_id: companyId,
      p_guide_id: guideId,
      p_guide_data: guideData,
      p_items_data: itemsData,
      p_user_id: userData.user.id,
    });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || 'Error actualizando borrador');
    return {
      id: guideId,
      guide_number: guideData.guide_number || '',
      status: 'DRAFT',
      warnings: (data.warnings || []) as RouteSaveDuplicateWarning[],
    };
  } else {
    // CREATE new draft
    const { data, error } = await supabase.rpc('create_route_guide_draft', {
      p_company_id: companyId,
      p_guide_data: guideData,
      p_items_data: itemsData,
      p_user_id: userData.user.id,
    });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || 'Error creando borrador');
    return {
      id: data.id as string,
      guide_number: data.guide_number as string,
      status: 'DRAFT',
      warnings: (data.warnings || []) as RouteSaveDuplicateWarning[],
    };
  }
}

export async function dispatchRouteGuideAction(guideId: string): Promise<DispatchRouteGuideResult> {
  const supabase = await createLogisticaClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Not authenticated');

  const companyId = await getActiveCompanyId();
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.');

  const { data, error } = await supabase.rpc('dispatch_route_guide', {
    p_company_id: companyId,
    p_guide_id: guideId,
    p_user_id: userData.user.id,
  });

  if (error) throw error;
  if (!data?.success) {
    // Attach duplicates to the error object so the UI can render detail
    const err: any = new Error(data?.error || 'Error despachando guía');
    err.duplicates = (data?.duplicates || []) as RouteDuplicateInvoice[];
    throw err;
  }

  return {
    id: guideId,
    status: 'DISPATCHED',
    warnings: [],
  };
}

export async function deleteRouteGuideDraftAction(guideId: string) {
  const supabase = await createLogisticaClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Not authenticated');

  const { error } = await supabase.rpc('delete_route_guide_draft', {
    p_guide_id: guideId,
    p_user_id: userData.user.id,
  });

  if (error) throw error;
  return true;
}
