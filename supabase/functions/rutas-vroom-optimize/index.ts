import { withSupabase } from "npm:@supabase/server@1";

const COMPANY_ID = "d1000000-0000-0000-0000-000000000001";
const DEPOT: [number, number] = [-71.6741499, -35.5182400];
const PROVIDER_URL = "https://api.heigit.org/vroom/v0";
const MAX_STOPS = 45; // Below the current provider limit of 50 locations.
const MAX_BODY_BYTES = 32000;
const REQUEST_TIMEOUT_MS = 25000;
const STOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:\-.]{0,127}$/;

type Stop = { stop_id: string; coordinates: [number, number] };
type Input = {
  company_id: string;
  included_stop_ids: string[];
  stops: Stop[];
};
type RouteStop = {
  stop_id: string;
  sequence: number;
  coordinates: [number, number];
  arrival_seconds: number | null;
  cumulative_distance_meters: number | null;
  cumulative_travel_seconds: number | null;
};

const record = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === "object" && !Array.isArray(x)
    ? x as Record<string, unknown> : null;
const finiteNonNegative = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
const validId = (x: unknown): x is string =>
  typeof x === "string" && STOP_ID_RE.test(x);
const validCoordinates = (x: unknown): x is [number, number] =>
  Array.isArray(x) && x.length === 2 &&
  typeof x[0] === "number" && Number.isFinite(x[0]) &&
  typeof x[1] === "number" && Number.isFinite(x[1]) &&
  x[0] >= -180 && x[0] <= 180 && x[1] >= -90 && x[1] <= 90;
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function parseInput(raw: unknown): Input | null {
  const d = record(raw);
  if (!d || d.company_id !== COMPANY_ID ||
      !Array.isArray(d.included_stop_ids) ||
      !Array.isArray(d.stops) ||
      d.included_stop_ids.length > MAX_STOPS ||
      d.stops.length > MAX_STOPS ||
      !d.included_stop_ids.every(validId)) return null;

  const included = d.included_stop_ids as string[];
  if (new Set(included).size !== included.length) return null;
  const stops: Stop[] = [];
  const seen = new Set<string>();
  for (const item of d.stops) {
    const s = record(item);
    if (!s || !validId(s.stop_id) || !validCoordinates(s.coordinates) ||
        !included.includes(s.stop_id) || seen.has(s.stop_id)) return null;
    seen.add(s.stop_id);
    stops.push({ stop_id: s.stop_id, coordinates: s.coordinates });
  }
  return { company_id: COMPANY_ID, included_stop_ids: included, stops };
}

function emptyRoute(input: Input, pending: string[]) {
  return json({
    ok: true,
    code: pending.length ? "PENDING_GEOLOCATION" : "NO_STOPS",
    company_id: COMPANY_ID,
    depot: { label: "Fundo El Trapiche", coordinates: DEPOT },
    included_stop_count: input.included_stop_ids.length,
    routed_stop_count: 0,
    pending_stop_ids: pending,
    unassigned_stop_ids: [],
    complete: pending.length === 0,
    route: null,
    writes: 0,
  });
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (request: Request) => {
    if (request.method !== "POST") {
      return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    let raw: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
        return json({ ok: false, code: "INVALID_REQUEST" }, 400);
      }
      raw = JSON.parse(text);
    } catch {
      return json({ ok: false, code: "INVALID_REQUEST" }, 400);
    }
    const input = parseInput(raw);
    if (!input) return json({ ok: false, code: "INVALID_REQUEST" }, 400);

    // Next.js has already checked session, company, inclusion and geocoding.
    // An omitted location stays explicit; it must never be silently routed.
    const locations = new Map(input.stops.map((s) => [s.stop_id, s]));
    const pending = input.included_stop_ids.filter((id) => !locations.has(id));
    if (input.stops.length === 0) return emptyRoute(input, pending);

    const key = Deno.env.get("HEIGIT_API_KEY");
    if (!key) return json({ ok: false, code: "PROVIDER_NOT_CONFIGURED" }, 503);

    // VROOM uses integer job IDs. Commercial identifiers never reach HeiGIT.
    const jobs = input.stops.map((s, index) => ({
      id: index + 1,
      location: s.coordinates,
      service: 0, // No unapproved estimate for delivery/unloading time.
    }));
    const jobToStop = new Map(jobs.map((job, index) =>
      [job.id, input.stops[index]]));
    const requestBody = {
      vehicles: [{ id: 1, profile: "driving-car", start: DEPOT, end: DEPOT }],
      jobs,
      options: { g: true },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(PROVIDER_URL, {
        method: "POST",
        headers: {
          Authorization: key,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (response.status === 429) {
        return json({ ok: false, code: "PROVIDER_RATE_LIMITED" }, 429);
      }
      if (response.status === 401 || response.status === 403) {
        return json({ ok: false, code: "PROVIDER_AUTH_FAILED" }, 502);
      }
      if (!response.ok) {
        return json({ ok: false, code: "PROVIDER_HTTP_ERROR", provider_status: response.status }, 502);
      }

      const data = record(await response.json());
      const providerRoutes = data?.routes;
      const providerUnassigned = data?.unassigned;
      if (data?.code !== 0 || !Array.isArray(providerRoutes) ||
          providerRoutes.length > 1 || !Array.isArray(providerUnassigned)) {
        return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
      }

      const unassigned = new Set<number>();
      for (const item of providerUnassigned) {
        const jobId = record(item)?.id;
        if (typeof jobId !== "number" || !Number.isInteger(jobId) ||
            !jobToStop.has(jobId) || unassigned.has(jobId)) {
          return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
        }
        unassigned.add(jobId);
      }

      let route: {
        encoded_geometry: string;
        geometry_encoding: "polyline";
        distance_meters: number;
        travel_seconds: number;
        service_seconds: 0;
        ordered_stops: RouteStop[];
      } | null = null;

      if (providerRoutes.length === 1) {
        const providerRoute = record(providerRoutes[0]);
        const steps = providerRoute?.steps;
        if (!providerRoute || !Array.isArray(steps) ||
            !finiteNonNegative(providerRoute.distance) ||
            !finiteNonNegative(providerRoute.duration) ||
            typeof providerRoute.geometry !== "string" ||
            !providerRoute.geometry.length || providerRoute.geometry.length > 1_000_000 ||
            record(steps[0])?.type !== "start" ||
            record(steps[steps.length - 1])?.type !== "end") {
          return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
        }
        const visited = new Set<number>();
        const ordered: RouteStop[] = [];
        for (const rawStep of steps) {
          const step = record(rawStep);
          if (!step) return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
          if (step.type !== "job") continue;
          const jobId = step.id;
          if (typeof jobId !== "number" || !Number.isInteger(jobId) ||
              !jobToStop.has(jobId) || visited.has(jobId) || unassigned.has(jobId)) {
            return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
          }
          visited.add(jobId);
          const stop = jobToStop.get(jobId)!;
          ordered.push({
            stop_id: stop.stop_id,
            sequence: ordered.length + 1,
            coordinates: stop.coordinates,
            arrival_seconds: finiteNonNegative(step.arrival) ? step.arrival : null,
            cumulative_distance_meters: finiteNonNegative(step.distance) ? step.distance : null,
            cumulative_travel_seconds: finiteNonNegative(step.duration) ? step.duration : null,
          });
        }
        if (!ordered.length) {
          return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
        }
        route = {
          encoded_geometry: providerRoute.geometry,
          geometry_encoding: "polyline",
          distance_meters: providerRoute.distance,
          travel_seconds: providerRoute.duration,
          service_seconds: 0,
          ordered_stops: ordered,
        };
        for (const id of visited) jobToStop.delete(id);
      }
      // All requested jobs must be accounted for: either visited or unassigned.
      if (jobToStop.size !== unassigned.size ||
          [...jobToStop.keys()].some((id) => !unassigned.has(id))) {
        return json({ ok: false, code: "INVALID_PROVIDER_RESPONSE" }, 502);
      }
      const unassignedStopIds = [...unassigned].map((jobId) =>
        input.stops[jobId - 1].stop_id);
      const routedCount = route?.ordered_stops.length ?? 0;
      const complete = pending.length === 0 && unassignedStopIds.length === 0 &&
        routedCount === input.included_stop_ids.length;
      return json({
        ok: true,
        code: complete ? "ROUTE_OPTIMIZED" : "ROUTE_PARTIAL",
        company_id: COMPANY_ID,
        provider: "HEIGIT_VROOM",
        depot: { label: "Fundo El Trapiche", coordinates: DEPOT },
        included_stop_count: input.included_stop_ids.length,
        routed_stop_count: routedCount,
        pending_stop_ids: pending,
        unassigned_stop_ids: unassignedStopIds,
        complete,
        route,
        writes: 0,
      });
    } catch {
      return json({
        ok: false,
        code: controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE",
      }, controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }
  }),
};
