SELECT 
  (SELECT count(*) FROM logistica.dispatch_calendars) AS calendars_count,
  (SELECT count(*) FROM logistica.dispatch_calendars WHERE active = true) AS active_calendars_count,
  (SELECT count(*) FROM logistica.dispatch_calendar_cities) AS calendar_cities_count,
  (SELECT count(*) FROM logistica.dispatch_cities) AS cities_count,
  (SELECT count(*) FROM logistica.city_aliases) AS aliases_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_cards) AS cards_count;
