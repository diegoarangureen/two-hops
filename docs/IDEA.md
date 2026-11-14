# Idea de proyecto

Estado: propuesta, sin decidir. Depende de conseguir más créditos de Cala (ver `AUDITORIA_SLUSH.md`).

## El reto

Cala, "Make Unicorns Real" (texto completo en `reto/fintech-track.md`). Un producto para founders o inversores, usable el día después del hackathon, que resuelva una sola necesidad bien. Slush empieza el 18 de noviembre.

Puntuación: 25% necesidad real, 25% ejecución, 25% originalidad, 25% que Cala sea el núcleo. Penalizan la versión genérica de ideas ya vistas.

Entrega: domingo 15 de noviembre, 10:00 (`reto/submissions.md`).

## Enfoque

Sacar partido a lo que distingue a Cala de un buscador web como Exa:

- **Varios saltos por el grafo.** Evento → empresa → ronda → inversor → otras participadas → founders. La respuesta es un camino, no un párrafo.
- **Operar sobre el conjunto entero.** Cruzar las 3.000 startups de Slush a la vez, en vez de leer diez enlaces.
- **Fuente, fecha y rango por dato.** Cada propiedad y cada relación trae su documento y si viene de un registro oficial, de la empresa, de prensa o de un agregador.
- **Tiempo.** Las relaciones tienen vigencia (`valid_since`, `valid_until`).

## Propuesta actual: la intro que ya está en Slush

Usuario: un founder que va a Slush a buscar inversión.

Dice qué hace y en qué fase está, y el producto recorre el grafo:

1. Busca startups de Slush parecidas a la suya (sector, sede, fase).
2. Mira quién invirtió en ellas y quién lideró la ronda, con su fuente.
3. Identifica a los founders de esas startups, que también están en Slush esa semana.

Resultado: "este fondo lideró el seed de 3 empresas como la tuya; los founders de 2 están aquí, pídeles la intro".

Por qué encaja: usa solo lo que el nodo tiene (startups, rondas, líderes, founders), y la respuesta es un camino por el grafo con fuente en cada paso.

Riesgos:

- Solo 3 de 12 startups de la muestra traen inversores con nombre. Sobre 3.000 serían unas 750; es una extrapolación de pocos casos.
- Necesita las 3.000 fichas descargadas, y eso no cabe en la cuenta gratuita.
- El parecido entre startups hay que calcularlo fuera de Cala (sector y descripción).

## Descartada

**Investigar a los inversores que asisten a Slush** (lo que dicen frente a lo que hacen, si siguen invirtiendo, conflictos de cartera). El nodo casi no contiene inversores, así que no hay lista de la que partir.

## Alternativa

**El espejo para inversores:** partir de un fondo, recorrer su cartera y sus coinversores, y marcar qué startups de Slush están a un salto. Mismo recorrido en sentido contrario.

## Dato comprobado después de la auditoría

Los ids coinciden entre la cartera de un inversor y la lista de asistentes: de las 44 participadas de Point Nine Capital, 2 están en Slush 2026 (Cardino y TesterArmy). Así que una sola llamada por inversor da su cartera entera y el cruce con los asistentes se hace en local, sin gastar más créditos.

## Siguiente paso

1. Pedir en el stand de Cala una clave con más límite.
2. Descargar las fichas con `tools/crawl.py companies`.
3. Medir la cobertura real con `tools/coverage.py` y decidir.
