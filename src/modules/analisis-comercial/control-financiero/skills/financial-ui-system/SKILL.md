# Financial UI System

## Alcance

Este documento define exclusivamente la UI interna de `Análisis Comercial -> Control Financiero`.
No obliga visualmente al resto de PetGroup.

## Identidad

La interfaz debe sentirse ejecutiva, financiera, sobria, moderna, compacta, de alta densidad y orientada a reuniones y toma de decisiones.

Evitar:

- SaaS genérico.
- Exceso de cards.
- Espacios vacíos.
- Glassmorphism.
- Sombras fuertes.
- Gradientes decorativos.
- Animaciones innecesarias.
- Colores excesivos.

## Paleta

Base validada:

| Color | Uso |
|---|---|
| `#322D29` Charcoal | Texto principal, títulos y navegación interna oscura. |
| `#72383D` Burgundy | Marca financiera, selección, acciones e indicadores importantes. |
| `#AC9C8D` Taupe | Información secundaria y apoyo visual. |
| `#D1C7BD` Stone | Bordes, divisores y fondos neutros. |
| `#EFE9E1` Ivory | Superficie y fondo principal financiero. |

Se permiten colores semánticos para pérdida, error o advertencia sin romper la identidad.

## Integración PetGroup

Mantener del ERP:

- topbar global;
- sidebar de Análisis Comercial;
- selector de empresa;
- sesión;
- breadcrumbs;
- navegación;
- permisos.

La identidad financiera especial comienza dentro de la superficie de Control Financiero.

No modificar visualmente Vista general, Proveedor 360, Producto 360 ni otros módulos.

## Estructura visual

Patrón principal:

1. Lectura Ejecutiva.
2. Gráfico.
3. Matriz mensual/anual.
4. Drill-down lateral.
5. Notas o advertencias de período.

Estado de Resultados, Flujo de Caja y Capital de Trabajo deben compartir el mismo lenguaje visual.

## Lectura Ejecutiva

Debe ser compacta, alinearse con el gráfico, mostrar indicadores útiles, permitir lectura rápida en reunión, evitar duplicar datos y utilizar datos dinámicos.

Puede contener KPIs, "de cada $100 vendidos", OPEX principales, composición, resumen gerencial y notas sobre períodos parciales.

No inventar conclusiones.

## Gráficos

Estado de Resultados:

- barras de ventas;
- línea de resultado final;
- etiquetas visibles;
- tooltip;
- meses existentes solamente;
- identificación de período parcial;
- CLP abreviado y legible.

Flujo de Caja:

- barras de entradas;
- barras de salidas;
- línea de saldo final;
- tooltip con entradas, salidas, flujo neto y saldo;
- diferencia entre flujo bruto y flujo gerencial;
- neutralización visual de transferencias internas.

No crear meses futuros artificiales.

## Matriz

Utilizar:

- alta densidad;
- importes alineados a la derecha;
- CLP;
- scroll horizontal interno;
- header sticky;
- columna CONCEPTO sticky;
- YTD sticky cuando sea necesario;
- porcentajes sticky cuando corresponda;
- offsets consistentes;
- misma definición geométrica entre headers;
- fondos sticky opacos;
- z-index correcto.

Nunca utilizar fondos transparentes en elementos sticky.

Cada fila debe conservar un fondo continuo entre CONCEPTO, meses, YTD y porcentaje.

## Jerarquía

Niveles visuales:

- fila normal;
- subtotal;
- línea estructural;
- resultado operacional;
- resultado final;
- margen final.

Resultado Final y Margen Final deben tener énfasis superior.

## Valores negativos

Regla universal:

```text
valor matemático < 0 -> rojo
```

No colorear de rojo una cifra simplemente porque conceptualmente sea un gasto.

## YTD y porcentajes

YTD debe diferenciarse visualmente.

Para Estado de Resultados:

```text
% SOBRE VENTAS = valor YTD del concepto / ventas netas YTD
```

Interpretar según contexto:

- ventas: participación;
- costo: peso;
- margen: margen;
- gasto: peso;
- resultado: resultado sobre ventas.

En Flujo de Caja utilizar porcentajes solamente cuando exista denominador financiero válido.
No mostrar ratios sin significado económico.

## Drawer

Patrón obligatorio:

```text
drawer lateral reutilizable
-> Nivel 1
-> Nivel 2
```

Debe ser fixed, abrir a la derecha, tener ancho responsive, scroll interno, evitar scroll horizontal, conservar contexto de período y concepto y mantener trazabilidad.

Puede mostrar fecha, cuenta, contraparte, descripción, monto, clasificación, fuente, observación y documento o referencia.

## Selección

- Celda activa resaltada.
- Header del mes activo resaltado.
- Concepto activo resaltado.
- Selección azul validada.
- El drawer no debe perder contexto.
- El auto-scroll debe afectar el contenedor de la matriz, no desplazar innecesariamente toda la página.

## Responsive

En desktop se prioriza split-view, lectura con gráfico, matriz amplia y drawer.
En mobile se apila el contenido cuando corresponda.
No activar una experiencia móvil demasiado temprano en escritorios estrechos.
