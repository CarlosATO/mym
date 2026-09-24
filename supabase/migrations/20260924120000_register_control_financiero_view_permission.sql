-- Register the Control Financiero read permission without assigning it.
INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
    'analisis_comercial.control_financiero.view',
    'Ver Control Financiero',
    'Acceso de lectura a Control Financiero dentro de Análisis Comercial.',
    m.id,
    true
FROM portal.modules AS m
WHERE m.code = 'analisis-comercial'
ON CONFLICT (code) DO NOTHING;
