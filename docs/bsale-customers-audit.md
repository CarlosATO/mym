# Auditoría de Clientes Bsale

## Resumen Ejecutivo
Se realizó una inspección segura (Solo-Lectura) a la API de clientes de Bsale (`/clients.json`).
- **Endpoint usado**: `GET /clients.json?state=0` (Solo clientes activos).
- **Total clientes activos**: 471
- **Paginación**: Soportada (usando `limit` y `offset`).

## Campos Disponibles por Cliente
Los clientes retornan un payload rico en información comercial:

- **Identificación**: `id` (Bsale ID), `firstName`, `lastName`, `company` (Razón Social), `code` (RUT).
- **Contacto**: `email`, `phone`, `phoneCode`.
- **Ubicación**: `city` (Ciudad), `municipality` (Comuna), `address` (Dirección física).
- **Comercial / Financiero**: `hasCredit` (Booleano de crédito), `maxCredit` (Límite de crédito), `activity` (Giro), `commerciallyBlocked` (Bloqueo comercial).
- **Relaciones Bsale**: 
  - `payment_type` (Medio de pago)
  - `sale_condition` (Condición de venta / Días crédito)
  - `price_list` (Lista de precios asignada)
- **Metadatos**: `createdAt`, `updatedAt`, `state` (0 = Activo).

## Muestra Enmascarada
```json
{
  "id": 3,
  "firstName": "JUAN CARLOS",
  "lastName": "CASTRO",
  "email": "c***@dominio.cl",
  "code": "12.***.***-*",
  "phone": "+56 ******123",
  "company": "SOC. AGROMAULE SERVICIOS LTDA",
  "note": "",
  "hasCredit": 1,
  "maxCredit": 1000000,
  "state": 0,
  "activity": "VENTAS INSUMOS MASCOTAS",
  "city": "CAUQUENES",
  "commerciallyBlocked": 0,
  "municipality": "CAUQUENES",
  "address": "Direccion oculta...",
  "createdAt": 1612820509,
  "updatedAt": 1752854129,
  "payment_type": { "id": "20" },
  "sale_condition": { "id": "20" },
  "price_list": { "id": "4" }
}
```

## Calidad de Datos Observada
- El campo `code` almacena el RUT, pero puede requerir normalización (`rut_clean`) en PetGrup.
- Las empresas usan `company`, y puede que `firstName`/`lastName` apliquen al contacto o representante.
- La información de crédito y condiciones de pago está disponible, lo cual es excelente para B2B.

## Recomendaciones de Mapeo
Para la futura fase de sincronización a `comercial.customers`:
- `id` -> `bsale_client_id`
- `company` -> `business_name`
- `code` -> `rut` y `rut_clean`
- `email`, `phone` -> Mapeo directo.
- `address`, `city`, `municipality` -> Mapeo directo a `address`, `city`, `commune`.
- `maxCredit` -> `credit_limit`
- `activity` -> Podría ir a `notes` o nuevo campo `business_activity`.
