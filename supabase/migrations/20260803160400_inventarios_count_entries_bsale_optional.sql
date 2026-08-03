-- Migration: 20260803160400_inventarios_count_entries_bsale_optional.sql
-- Description: Fase 4I.2H.1. count_entries.bsale_variant_id pasa a opcional para
--              soportar productos seleccionados sin variante Bsale. La FK
--              fk_inventarios_counts_product_context usa MATCH SIMPLE (NULL no
--              valida) y snapshot_products ya tiene la unique correspondiente.
-- Author: Assistant

ALTER TABLE inventarios.count_entries
    ALTER COLUMN bsale_variant_id DROP NOT NULL;
