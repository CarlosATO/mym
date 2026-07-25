import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getActiveCompanyId } from "@/app/actions/companies";
import { createClient } from "@/lib/supabase/server";

export function commissionDb() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: "comercial" },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export async function getAuthenticatedCompany() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new Error("No autorizado");

  const companyId = await getActiveCompanyId(user);
  if (!companyId) throw new Error("No hay una empresa activa");

  return { companyId, userId: user.id };
}
