-- Preparation only: the next block may claim physical post-settlement
-- collections without changing the current Cierre de Fondos behavior.
ALTER TABLE adquisiciones.route_fund_closure_items
    ADD COLUMN IF NOT EXISTS post_settlement_payment_id uuid
        REFERENCES adquisiciones.post_settlement_payments(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_fund_closure_items_active_post_payment
    ON adquisiciones.route_fund_closure_items(post_settlement_payment_id)
    WHERE post_settlement_payment_id IS NOT NULL AND released_at IS NULL;

COMMENT ON COLUMN adquisiciones.route_fund_closure_items.post_settlement_payment_id IS
    'Future physical-fund claim for a confirmed post-settlement CASH/CHECK payment; not used by this block.';
