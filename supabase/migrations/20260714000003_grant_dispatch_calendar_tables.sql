GRANT USAGE ON SCHEMA logistica TO service_role;

GRANT SELECT ON logistica.dispatch_cities TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON logistica.dispatch_calendars TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON logistica.dispatch_calendar_cities TO service_role;
