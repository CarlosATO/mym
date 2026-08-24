-- COMV2-06: simulation and plan inspection need read-only access to V2 plans.
-- Writes remain exclusively inside comisiones.save_family_fixed_plan.

GRANT SELECT ON comisiones.commission_plans TO authenticated;
GRANT SELECT ON comisiones.commission_plan_family_rates TO authenticated;
