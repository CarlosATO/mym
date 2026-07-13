-- 1. Deduplicar duplicados lógicos (si los hubiera) dentro de la misma empresa
DELETE FROM integraciones.bsale_stock_current a USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY company_id, variant_id, office_id 
    ORDER BY synced_at DESC
  ) as rn
  FROM integraciones.bsale_stock_current
) b WHERE a.id = b.id AND b.rn > 1;

-- 2. Asegurar idempotencia eliminando el nuevo constraint si existe por corridas previas
ALTER TABLE integraciones.bsale_stock_current 
DROP CONSTRAINT IF EXISTS bsale_stock_current_variant_office_key;

-- 3. Agregar el nuevo constraint de negocio (manteniendo intacto el antiguo UNIQUE(company_id, bsale_id))
ALTER TABLE integraciones.bsale_stock_current 
ADD CONSTRAINT bsale_stock_current_variant_office_key UNIQUE (company_id, variant_id, office_id);
