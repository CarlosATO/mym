-- Migration: 20260805153000_inventarios_campaign_import_validation_row_index_nullable.sql
-- Description: Permite incidencias de cobertura sin fila fisica asociada.
-- Author: Assistant

ALTER TABLE inventarios.stock_import_row_issues
    ALTER COLUMN row_index DROP NOT NULL;
