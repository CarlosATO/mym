import { withSupabase } from "npm:@supabase/server@1";
import postgres from "npm:postgres@3.4.5";

const MYM_COMPANY_ID = "d1000000-0000-0000-0000-000000000001";
const MAX_DESTINATIONS = 100;
const MAX_BODY_BYTES = 40_000;

type Destination = {
  country_code: "CL";
  commune_key: string;
  address_key: string;
};

function isDestination(v: unknown): v is Destination {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  return d.country_code === "CL" &&
    typeof d.commune_key === "string" &&
    d.commune_key.length > 0 && d.commune_key.length <= 120 &&
    d.commune_key === d.commune_key.trim() &&
    typeof d.address_key === "string" &&
    d.address_key.length > 0 && d.address_key.length <= 300 &&
    d.address_key === d.address_key.trim();
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (req: Request) => {
    if (req.method !== "POST") {
      return jsonResponse({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
    }
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    let parsed: unknown;
    try {
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
      }
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    const input = parsed as Record<string, unknown>;
    if (input.company_id !== MYM_COMPANY_ID ||
        !Array.isArray(input.destinations) ||
        input.destinations.length > MAX_DESTINATIONS ||
        !input.destinations.every(isDestination)) {
      return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    // Only the trusted PetGroup backend may call this worker. It must validate the
    // active company, user permissions and source cards BEFORE submitting these keys.
    const unique = new Map<string, Destination>();
    for (const d of input.destinations as Destination[]) {
      unique.set(JSON.stringify([d.country_code, d.commune_key, d.address_key]), d);
    }
    if (unique.size === 0) {
      return jsonResponse({
        ok: true,
        code: "CACHE_LOOKUP_COMPLETE",
        company_id: MYM_COMPANY_ID,
        matched: 0,
        cached: [],
        test_only: true,
        writes: 0,
      });
    }
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrl) return jsonResponse({ ok: false, code: "DATABASE_UNAVAILABLE" }, 503);
    const sql = postgres(dbUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 7,
      idle_timeout: 1,
      max_lifetime: 30,
      application_name: "rutas_geocode_cache_lookup",
    });
    try {
      const rows = await sql.unsafe(
        "SELECT country_code, commune_key, address_key, status, " +
        "latitude::double precision AS latitude, longitude::double precision AS longitude, " +
        "accuracy_label, provider, provider_place_id, matched_address, fetched_at, expires_at " +
        "FROM rutas.lookup_geocode_cache_v1($1::uuid, $2::jsonb)",
        [MYM_COMPANY_ID, sql.json([...unique.values()])],
      );
      const cached = rows.map(r => ({
        country_code: r.country_code,
        commune_key: r.commune_key,
        address_key: r.address_key,
        status: r.status,
        coordinates: r.status === "RESOLVED" && Number.isFinite(r.longitude) &&
          Number.isFinite(r.latitude) ? [r.longitude, r.latitude] : null,
        accuracy_label: r.accuracy_label ?? null,
        provider: r.provider,
        provider_place_id: r.provider_place_id ?? null,
        matched_address: r.matched_address ?? null,
        fetched_at: r.fetched_at,
        expires_at: r.expires_at,
      }));
      // Cached RESOLVED is NOT equivalent to physical access verified;
      // the caller must apply its conservative acceptance contract.
      return jsonResponse({
        ok: true,
        code: "CACHE_LOOKUP_COMPLETE",
        company_id: MYM_COMPANY_ID,
        matched: cached.length,
        cached,
        writes: 0,
      });
    } catch {
      // No SQL, addresses, secrets or provider details are logged or exposed.
      return jsonResponse({ ok: false, code: "CACHE_LOOKUP_FAILED" }, 502);
    } finally {
      try { await sql.end({ timeout: 1 }); } catch { /* no logging */ }
    }
  }),
};
