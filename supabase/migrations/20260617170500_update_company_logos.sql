-- Update logo_url for core.companies to point to public assets
UPDATE core.companies
SET logo_url = '/logos/Logo_AmiMascota.jpeg',
    updated_at = now()
WHERE id = 'd2000000-0000-0000-0000-000000000002'
   OR business_name ILIKE '%AmiMascota%'
   OR trade_name ILIKE '%AmiMascota%'
   OR business_name ILIKE '%EMPRESA 2%';

UPDATE core.companies
SET logo_url = '/logo-transparent.png',
    updated_at = now()
WHERE id = 'd1000000-0000-0000-0000-000000000001'
   OR business_name ILIKE '%MYM%'
   OR trade_name ILIKE '%MYM%';

NOTIFY pgrst, 'reload schema';
