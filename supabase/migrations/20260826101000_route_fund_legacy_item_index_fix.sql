-- Post-settlement closure rows have payment_id NULL by design. They must not
-- collide with the legacy no-payment item uniqueness rule.
DROP INDEX IF EXISTS adquisiciones.idx_route_fund_closures_active_legacy_item;
CREATE UNIQUE INDEX idx_route_fund_closures_active_legacy_item
    ON adquisiciones.route_fund_closure_items (route_settlement_item_id)
    WHERE released_at IS NULL AND payment_id IS NULL AND post_settlement_payment_id IS NULL;
