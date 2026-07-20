SELECT 
  (SELECT count(*) FROM logistica.sales_order_preparation_cards) AS cards_count,
  (SELECT count(*) FROM logistica.dispatch_calendars) AS calendars_count,
  (SELECT count(*) FROM logistica.dispatch_calendar_cities) AS calendar_cities_count;
