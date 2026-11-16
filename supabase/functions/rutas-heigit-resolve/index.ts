import { withSupabase } from "npm:@supabase/server@1";

const COMPANY_ID = "d1000000-0000-0000-0000-000000000001";
const MAX_BATCH = 10;
const BODY_LIMIT = 15000;
const PROVIDER_TIMEOUT = 8500;

const norm = (s) => String(s ?? "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu, " ")
  .replace(/\b(avda|avd|av)\b/g, "avenida")
  .replace(/\b(psje|pje)\b/g, "pasaje")
  .replace(/\s+/g, " ").trim();
const str = (s) => typeof s === "string" && s.trim() ? s.trim() : null;
const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
const json = (v, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const valid = (v) => {
  const d = obj(v);
  return !!d && d.country_code === "CL" &&
    typeof d.commune_key === "string" && typeof d.address_key === "string" &&
    d.commune_key === d.commune_key.trim() && d.address_key === d.address_key.trim() &&
    d.commune_key.length > 0 && d.commune_key.length <= 120 &&
    d.address_key.length > 0 && d.address_key.length <= 300 &&
    !/[\u0000-\u001f\u007f]/u.test(d.commune_key + d.address_key);
};

function addressOnly(d) {
  let value = norm(d.address_key);
  const commune = norm(d.commune_key);
  for (const suffix of [commune + " chile", commune]) {
    if (value.endsWith(" " + suffix)) {
      value = value.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return value;
}

// Evita repetir la comuna o el país en la consulta sin cambiar la clave recibida.
function providerQuery(d) {
  const parts = d.address_key.split(",").map((part) => part.trim());
  const commune = norm(d.commune_key);
  if (parts.length > 2 && norm(parts[parts.length - 1]) === "chile" &&
      norm(parts[parts.length - 2]) === commune) parts.pop();
  if (parts.length > 1 && norm(parts[parts.length - 1]) === commune) parts.pop();
  return parts.join(", ") + ", " + d.commune_key + ", Chile";
}

function parseCandidate(feature, destination) {
  const f = obj(feature);
  const p = obj(f?.properties);
  const coordinates = obj(f?.geometry)?.coordinates;
  if (!p || !Array.isArray(coordinates)) return null;
  const [lon, lat] = coordinates;
  if (typeof lon !== "number" || typeof lat !== "number" ||
      !Number.isFinite(lon) || !Number.isFinite(lat) ||
      lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

  const country = str(p.country_a) ?? str(p.country);
  const matchesCountry = ["CL", "CHL"].includes(country ?? "") ||
    norm(country) === "chile";
  if (!matchesCountry) return null;

  const locality = str(p.locality) ?? str(p.localadmin);
  const matchesCommune = [str(p.locality), str(p.localadmin)]
    .some((v) => v !== null && norm(v) === norm(destination.commune_key));
  const street = str(p.street);
  const number = typeof p.housenumber === "number" && Number.isFinite(p.housenumber)
    ? String(p.housenumber) : str(p.housenumber);
  const requested = addressOnly(destination);
  const matchesStreetNumber = !!street && !!number && (
    requested === norm(street + " " + number) ||
    requested === norm(number + " " + street)
  );
  const layer = str(p.layer);
  const matchType = str(p.match_type);
  const accuracy = str(p.accuracy);
  const exact = matchesCommune && matchesStreetNumber && layer === "address" &&
    norm(matchType) !== "fallback" &&
    !["centroid", "interpolated"].includes(norm(accuracy));

  return {
    coordinates: [lon, lat],
    provider_place_id: str(p.id),
    matched_address: str(p.label),
    locality, street, housenumber: number, layer,
    confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) &&
      p.confidence >= 0 && p.confidence <= 1 ? p.confidence : null,
    match_type: matchType, accuracy,
    country_matches: true, commune_matches: matchesCommune,
    street_number_matches: matchesStreetNumber, exact_geographic_match: exact,
  };
}

function answer(d, classification, candidates = [], coordinates = null) {
  return {
    country_code: d.country_code, commune_key: d.commune_key, address_key: d.address_key,
    classification, coordinates, candidates, physical_access_verified: false,
  };
}

async function geocode(d, key) {
  const url = new URL("https://api.heigit.org/pelias/v1/search");
  url.searchParams.set("text", providerQuery(d));
  url.searchParams.set("boundary.country", "CHL");
  url.searchParams.set("layers", "address,street,venue");
  url.searchParams.set("size", "5");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT);
  try {
    const response = await fetch(url, {
      headers: { Authorization: key, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 429) return answer(d, "PROVIDER_RATE_LIMITED");
    if ([401, 403].includes(response.status)) return answer(d, "PROVIDER_AUTH_FAILED");
    if (!response.ok) return answer(d, "PROVIDER_UNAVAILABLE");
    const payload = obj(await response.json());
    if (!payload || !Array.isArray(payload.features)) {
      return answer(d, "PROVIDER_UNAVAILABLE");
    }
    const candidates = payload.features.slice(0, 5)
      .map((f) => parseCandidate(f, d)).filter(Boolean);
    const exact = candidates.filter((c) => c.exact_geographic_match);
    const exactPlaces = new Set(exact.map((c) =>
      c.coordinates[0].toFixed(6) + "," + c.coordinates[1].toFixed(6)));
    if (exactPlaces.size === 1 && exact.length) {
      return answer(d, "EXACT", candidates, exact[0].coordinates);
    }
    if (exactPlaces.size > 1) return answer(d, "AMBIGUOUS", candidates);
    const local = candidates.filter((c) => c.commune_matches);
    if (local.length > 1) return answer(d, "AMBIGUOUS", candidates);
    if (local.length === 1) return answer(d, "APPROXIMATE", candidates);
    return answer(d, "NOT_FOUND", candidates);
  } catch {
    return answer(d, "PROVIDER_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (req) => {
    if (req.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
      return json({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    let payload;
    try {
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > BODY_LIMIT) throw new Error("size");
      payload = JSON.parse(raw);
    } catch {
      return json({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    const input = obj(payload);
    if (!input || input.company_id !== COMPANY_ID ||
        !Array.isArray(input.destinations) ||
        input.destinations.length > MAX_BATCH ||
        !input.destinations.every(valid)) {
      return json({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    // The caller is the trusted PetGroup server. It authorizes the user,
    // company and preparation cards before passing any geographic keys.
    const unique = new Map();
    for (const d of input.destinations) {
      unique.set(JSON.stringify([d.country_code, d.commune_key, d.address_key]), d);
    }
    if (unique.size === 0) {
      return json({
        ok: true, code: "GEOCODE_BATCH_COMPLETE", company_id: COMPANY_ID,
        provider: "HEIGIT_PELIAS", results: [], requests_to_provider: 0, writes: 0,
      });
    }
    const key = Deno.env.get("HEIGIT_API_KEY");
    if (!key) return json({ ok: false, code: "PROVIDER_NOT_CONFIGURED" }, 503);
    const destinations = [...unique.values()];
    const results = new Array(destinations.length);
    let next = 0;
    async function worker() {
      while (next < destinations.length) {
        const i = next++;
        results[i] = await geocode(destinations[i], key);
      }
    }
    await Promise.all([worker(), worker()]);
    return json({
      ok: true, code: "GEOCODE_BATCH_COMPLETE", company_id: COMPANY_ID,
      provider: "HEIGIT_PELIAS", results,
      requests_to_provider: destinations.length, writes: 0,
    });
  }),
};
