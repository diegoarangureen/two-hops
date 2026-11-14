# Auditoría del nodo Slush 2026 en Cala

Hecha el 14 de noviembre de 2026 contra la API real, con la cuenta gratuita. Gastó unas 40 de las 100 consultas mensuales.

## El nodo

- Entidad `Event` "Slush 2026", id `bc844d56-6ab4-452b-96bf-2661e86e592b`.
- Propiedades: `name`, `description`, `event_date` (2026-11-18), `location` (Messukeskus Helsinki), `aliases`.
- Una sola relación: `PARTICIPATES_IN_EVENT` entrante. No tiene salientes ni series temporales.
- 2.989 entidades enlazadas: 2.988 con rol `ATTENDEE` y Slush Oy como `ORGANIZER`. Por tipo: 2.980 `Company`, 8 `Organization`, 1 `EducationalInstitution`.
- La relación de asistencia solo lleva `role` y la fuente (slush.org, noviembre de 2026).
- Casi todo son startups. Solo unos 15 nombres parecen inversores: Point Nine Capital, Capnamic Ventures, Data Driven VC, Heave Ventures, LTS Ventures, Windhill Capital, Pacer Ventures, Plug Capital, entre otros. **La lista de inversores de Slush no está en el nodo.** A los inversores se llega desde las startups, por sus rondas.
- Otros nodos Slush (2025, 2024, 2023, "Slush") solo tienen la relación `SPOKE_AT`.

Lista completa en `data/attendees.json`.

## Cobertura: muestra aleatoria de 12 startups

| Empresa | Fundada | Sede | Fase | Financiación total | Rondas | Inversores | Founders | CEO | Consejo |
|---|---|---|---|---|---|---|---|---|---|
| FunDoubler | 2013 | Estocolmo | | | 0 | 0 | 0 | 0 | 2 |
| The Hazard Factory | 2022 | Kortrijk | SEED | 799.200 EUR | 1 | 0 | 2 | 0 | 3 |
| Styloteca, UAB | 2023 | Vilna | | 90.409 EUR | 2 | 0 | 0 | 0 | 0 |
| Breathment | 2022 | Múnich | | 800.000 EUR | 1 | 6 | 3 | 1 | 0 |
| Reactional Music | 2012 | Estocolmo | PRE_SERIES_A | 2.500.000 EUR | 2 | 3 | 0 | 1 | 7 |
| WAI Water Intelligence | 2023 | Helsinki | | | 0 | 0 | 1 | 0 | 0 |
| DBtune | 2020 | Malmö | SEED | | 1 | 3 | 1 | 1 | 0 |
| Nada | 2025 | Esch-sur-Alzette | | | 1 | 0 | 0 | 0 | 0 |
| CAVIGEN | 2024 | Rülzheim | | | 0 | 0 | 3 | 1 | 0 |
| CONTENT CHEMISTRY LTD | 2021 | Reino Unido | | | 0 | 0 | 0 | 0 | 2 |
| CaBloom | 2021 | Helsinki | SERIES_A | 3.000.000 USD | 3 | 0 | 3 | 1 | 0 |
| Velory | 2020 | Estocolmo | | | 0 | 0 | 1 | 1 | 4 |

| Dato | Lo tienen |
|---|---|
| Web, descripción, fecha de fundación, sede, sector | 12 de 12 |
| Founders o CEO | 8 de 12 |
| Al menos una ronda | 7 de 12 |
| Financiación total | 5 de 12 |
| Fase (`funding_stage`) | 4 de 12 |
| Inversores con nombre | 3 de 12 |
| Plantilla (`employee_count_range`) | 0 de 12 |

Las cuatro primeras filas no están en `data/companies` (el script falló antes de guardarlas); las otras ocho sí. Doce casos es poco: sirve de orientación, no de estadística.

Rango de las fuentes en las propiedades de esas 8 fichas (107 citas): 56 `PRIMARY` (la propia empresa), 25 `AGGREGATOR`, 11 `FILING` (registros oficiales), 9 `PRESS`, 6 sin clasificar.

## Casos mirados a fondo

**Synhelion** (startup conocida, elegida a mano): ficha completa. 6 rondas (Series D, Series A, una ronda de capital, 3 subvenciones), 10 inversores, 2 founders, 2 CEO, CTO, 6 consejeros con `valid_since` y uno con `valid_until`, 2 adquisiciones. Fuentes: registro mercantil suizo (zefix), su web y prensa. Sin series temporales.

**Rondas** (2 miradas): traen `transaction_value`, moneda, `event_date` o `announcement_date`, `round_label`, `instrument` y participantes con `role` e `is_lead`. La Series D de Synhelion tiene 9 participantes y el líder marcado; el Pre-Series A de Reactional Music, 2 líderes marcados.

**Point Nine Capital** (inversor): 44 participadas por `INVESTED_IN`, 11 rondas con `is_lead` en casi todas, 48 eventos de financiación. Se puede recorrer su cartera.

## Problemas de calidad

- **Etiquetas de ronda inferidas.** La "Series D" de Synhelion tiene como alias Seed, Series A, B y C, y `annotations` dice `round_label_basis:INFERRED`. Hay que leer `annotations` antes de fiarse de la etiqueta.
- **Relaciones que parecen invertidas.** Typeform, Factorial, Preply y otras participadas aparecen como inversores *en* Point Nine (`INVESTED_IN` entrante).
- **Duplicados.** La misma empresa puede salir dos veces en una relación, o como `Company` y como `Organization`.
- **Nombre legal frente a marca.** Algunas fichas tienen como sede la dirección registral en vez de la ciudad.
- **Un fallo transitorio** de la API en unas 45 llamadas (respuesta de error sin cuerpo).

## Cómo se comporta la API

- Los endpoints de entidad responden en 0,2 a 5 segundos.
- Una sola llamada trae la ficha completa de una empresa con todas sus relaciones. No hace falta la introspección previa: pedir una relación que la entidad no tiene no da error.
- Máximo 1.000 elementos por relación y página; se pagina con `offset`.
- Cuenta gratuita: 10 llamadas por minuto y 100 créditos al mes (1 crédito = 1 consulta). Al pasarse devuelve 429 sin cabecera `Retry-After`.
- Descargar las 2.989 fichas son unas 3.000 llamadas: 30 veces la cuota mensual y 5 horas a 10 por minuto.

## Lo que no se probó

- `knowledge_query` y `knowledge_search` (para no gastar créditos; la documentación dice que pueden tardar hasta 180 s).
- Series temporales de plantilla o ARR más allá de Synhelion.
- El servidor MCP.
