-- Allow the one-time internal warehouse opening movement.
ALTER TABLE mermas.movements
  DROP CONSTRAINT IF EXISTS movements_movement_type_check;

ALTER TABLE mermas.movements
  ADD CONSTRAINT movements_movement_type_check
  CHECK (movement_type IN (
    'ENTRADA_BSALE',
    'VENTA_INTERNA',
    'ELIMINACION',
    'REVERSA',
    'STOCK_INICIAL'
  ));
