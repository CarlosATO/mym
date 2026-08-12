-- Materialización del Stock Teórico Global Oficial del Inventario.
--
-- Inventario: PRUEBA INTEGRAL INVENTARIO M1.5 - 11-08-2026
--   campaign : a6b261bb-5c91-41db-9db0-7066b4470c52
--   import   : b480f923-a672-4c3f-bd08-e4385e9470b2  (TOTAL_CAMPAIGN, 704 VALID)
--
-- Convierte las 704 filas válidas del import en la fotografía oficial congelada:
--   stock_import_rows
--     -> inventory_campaign_snapshots        (cabecera COMPLETED)
--     -> inventory_campaign_snapshot_products (productos)
--     -> inventory_campaign_theoretical_stocks (stocks TOTAL_CAMPAIGN + unit_cost)
--
-- Garantías:
--   * Defensivo: aborta si import/campaign/704 VALID no coinciden.
--   * Idempotente: si la fotografía ya existe con el mismo contenido, no duplica.
--   * NO modifica stock_import_rows.
--   * NO propaga el teórico a las secciones (snapshot_stocks / snapshot_theoretical_stocks).
--   * Solo DDL/DML en esquema inventarios (campaña, snapshot, stock, costos).
--   * Actor administrativo: dc9be3b3 (admin de la empresa), mismo usado en
--     reparaciones previas del módulo.

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_campaign_id uuid := 'a6b261bb-5c91-41db-9db0-7066b4470c52';
    v_import_id uuid := 'b480f923-a672-4c3f-bd08-e4385e9470b2';
    v_actor_id uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';

    v_campaign_status text;
    v_import_campaign_id uuid;
    v_import_status text;
    v_import_scope text;
    v_valid_rows bigint;
    v_campaign_snapshot_id uuid;
    v_existing_snapshot_id uuid;
    v_existing_status text;
    v_occurred_at timestamptz := pg_catalog.now();
    v_content_hash char(64);
    v_inserted_products bigint;
    v_inserted_stocks bigint;
BEGIN
    -- 1. Validar campaña.
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = v_company_id AND ic.id = v_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: campaign % not found', v_campaign_id;
    END IF;

    -- 2. Validar import: pertenece a la campaña, VALIDATED, TOTAL_CAMPAIGN.
    SELECT si.campaign_id, si.status, si.theoretical_scope
    INTO v_import_campaign_id, v_import_status, v_import_scope
    FROM inventarios.stock_imports si
    WHERE si.company_id = v_company_id AND si.id = v_import_id;
    IF v_import_status IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: import % not found', v_import_id;
    END IF;
    IF v_import_campaign_id IS DISTINCT FROM v_campaign_id THEN
        RAISE EXCEPTION 'Precondition failed: import % does not belong to campaign %', v_import_id, v_campaign_id;
    END IF;
    IF v_import_status <> 'VALIDATED' THEN
        RAISE EXCEPTION 'Precondition failed: import % status is %, expected VALIDATED', v_import_id, v_import_status;
    END IF;
    IF v_import_scope IS DISTINCT FROM 'TOTAL_CAMPAIGN' THEN
        RAISE EXCEPTION 'Precondition failed: import % scope is %, expected TOTAL_CAMPAIGN', v_import_id, v_import_scope;
    END IF;

    -- 3. Validar 704 filas VALID con identidad completa.
    SELECT pg_catalog.count(*) INTO v_valid_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = v_company_id AND r.import_id = v_import_id
      AND r.row_status = 'VALID'
      AND r.product_id IS NOT NULL
      AND r.bsale_variant_id IS NOT NULL
      AND r.sku IS NOT NULL AND pg_catalog.btrim(r.sku) <> ''
      AND r.theoretical_quantity IS NOT NULL;
    IF v_valid_rows IS DISTINCT FROM 704 THEN
        RAISE EXCEPTION 'Precondition failed: expected 704 VALID rows with full identity, found %', v_valid_rows;
    END IF;

    -- 4. Fotografía de campaña: una sola por campaña.
    SELECT cs.id, cs.completion_status
    INTO v_existing_snapshot_id, v_existing_status
    FROM inventarios.inventory_campaign_snapshots cs
    WHERE cs.company_id = v_company_id AND cs.campaign_id = v_campaign_id;

    IF v_existing_snapshot_id IS NOT NULL AND v_existing_status = 'COMPLETED' THEN
        RAISE NOTICE 'Campaign snapshot already COMPLETED (id %) for campaign %; skipping materialization', v_existing_snapshot_id, v_campaign_id;
        RETURN;
    END IF;

    IF v_existing_snapshot_id IS NULL THEN
        INSERT INTO inventarios.inventory_campaign_snapshots (
            company_id, campaign_id, stock_import_id, theoretical_scope,
            completion_status, captured_at, captured_by, created_at, created_by
        ) VALUES (
            v_company_id, v_campaign_id, v_import_id, 'TOTAL_CAMPAIGN',
            'COMPLETED', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_campaign_snapshot_id;
    ELSE
        v_campaign_snapshot_id := v_existing_snapshot_id;
        UPDATE inventarios.inventory_campaign_snapshots
        SET stock_import_id = v_import_id,
            theoretical_scope = 'TOTAL_CAMPAIGN',
            completion_status = 'COMPLETED',
            captured_at = v_occurred_at,
            captured_by = v_actor_id
        WHERE company_id = v_company_id AND id = v_campaign_snapshot_id;
    END IF;

    -- 5. Productos del snapshot de campaña (identidad canónica: bsale_variant_id).
    INSERT INTO inventarios.inventory_campaign_snapshot_products (
        company_id, campaign_snapshot_id, product_id, bsale_variant_id, sku,
        barcode, name, is_active, created_at, created_by
    )
    SELECT r.company_id, v_campaign_snapshot_id, r.product_id, r.bsale_variant_id,
           r.sku, NULLIF(pg_catalog.btrim(p.barcode), ''),
           coalesce(NULLIF(pg_catalog.btrim(p.description), ''), r.sku),
           true,
           v_occurred_at, v_actor_id
    FROM inventarios.stock_import_rows r
    JOIN adquisiciones.products p ON p.id = r.product_id
    WHERE r.company_id = v_company_id AND r.import_id = v_import_id
      AND r.row_status = 'VALID'
    ON CONFLICT (company_id, campaign_snapshot_id, bsale_variant_id)
        WHERE bsale_variant_id IS NOT NULL
    DO NOTHING;

    -- 6. Stock teórico oficial global + costo congelado.
    INSERT INTO inventarios.inventory_campaign_theoretical_stocks (
        company_id, campaign_snapshot_id, snapshot_product_id, scope_level,
        theoretical_quantity, unit_cost, source_import_id, created_at, created_by
    )
    SELECT csp.company_id, v_campaign_snapshot_id, csp.id, 'TOTAL_CAMPAIGN',
           r.theoretical_quantity, r.unit_cost, r.import_id,
           v_occurred_at, v_actor_id
    FROM inventarios.stock_import_rows r
    JOIN inventarios.inventory_campaign_snapshot_products csp
      ON csp.company_id = r.company_id
     AND csp.campaign_snapshot_id = v_campaign_snapshot_id
     AND csp.bsale_variant_id = r.bsale_variant_id
    WHERE r.company_id = v_company_id AND r.import_id = v_import_id
      AND r.row_status = 'VALID'
    ON CONFLICT (company_id, campaign_snapshot_id, snapshot_product_id)
        WHERE scope_level = 'TOTAL_CAMPAIGN'
    DO NOTHING;

    -- 7. Hash de integridad de la fotografía oficial.
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                pg_catalog.string_agg(t.line, E'\n' ORDER BY t.line),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    ) INTO v_content_hash
    FROM (
        SELECT 'P:' || csp.product_id::text || '|' || coalesce(csp.sku,'') AS line
        FROM inventarios.inventory_campaign_snapshot_products csp
        WHERE csp.company_id = v_company_id AND csp.campaign_snapshot_id = v_campaign_snapshot_id
        UNION ALL
        SELECT 'T:' || csp.product_id::text || '|' || icts.theoretical_quantity::text || '|' || coalesce(icts.unit_cost::text,'') AS line
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id
         AND csp.campaign_snapshot_id = icts.campaign_snapshot_id
         AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = v_company_id
          AND icts.campaign_snapshot_id = v_campaign_snapshot_id
          AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ) t;

    UPDATE inventarios.inventory_campaign_snapshots
    SET content_hash = v_content_hash
    WHERE company_id = v_company_id AND id = v_campaign_snapshot_id;

    -- 8. Conteos para auditoría de la migración.
    SELECT pg_catalog.count(*) INTO v_inserted_products
    FROM inventarios.inventory_campaign_snapshot_products csp
    WHERE csp.company_id = v_company_id AND csp.campaign_snapshot_id = v_campaign_snapshot_id;

    SELECT pg_catalog.count(*) INTO v_inserted_stocks
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    WHERE icts.company_id = v_company_id
      AND icts.campaign_snapshot_id = v_campaign_snapshot_id
      AND icts.scope_level = 'TOTAL_CAMPAIGN';

    RAISE NOTICE 'Campaign snapshot % materialized: products=%, stocks=%', v_campaign_snapshot_id, v_inserted_products, v_inserted_stocks;
END;
$$;
