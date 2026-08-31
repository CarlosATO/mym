-- Remove the legacy test company introduced by historical multi-company migrations.
-- Keep this scoped to the exact legacy UUID; real companies are not touched.
DELETE FROM core.user_company_access
WHERE company_id = 'd2000000-0000-0000-0000-000000000002'::uuid;

DELETE FROM core.companies
WHERE id = 'd2000000-0000-0000-0000-000000000002'::uuid;
