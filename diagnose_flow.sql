SELECT 'CALENDARS' as source, id, name, active FROM logistica.dispatch_calendars;
SELECT 'CITIES' as source, id, calendar_id, city_id, weekday, normalized_city FROM logistica.dispatch_calendar_cities;
SELECT 'CARDS' as source, count(*) FROM logistica.sales_order_preparation_cards;
