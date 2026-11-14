# Cala project

Trabajo para el reto de Cala en Junction 2026, "Make Unicorns Real": un producto para founders o inversores construido sobre el grafo de conocimiento de Cala. Entrega el domingo 15 de noviembre de 2026 a las 10:00.

Por ahora el repo contiene la investigación, no el producto: qué pide el reto, qué hay de verdad en el nodo Slush 2026 y una propuesta de idea.

## Por dónde empezar

| Archivo | Qué es |
|---|---|
| `docs/IDEA.md` | La propuesta de proyecto, lo descartado y el siguiente paso |
| `docs/PROMPT_BUILD.md` | El prompt para pedirle a Claude que construya el proyecto |
| `docs/AUDITORIA_SLUSH.md` | Qué contiene el nodo Slush 2026 y con qué cobertura |
| `docs/CALA_API.md` | Cómo se consulta Cala, con las trampas encontradas |
| `docs/cala_funding_fields_hack_guide.md` | Guía de campos oficial de Cala para el reto |
| `docs/cala_openapi.json` | Especificación de la API |
| `docs/reto/` | Texto del reto, normas de entrega, retos técnicos y herramientas |

## Datos

Descargados de Cala el 14 de noviembre de 2026.

| Ruta | Contenido |
|---|---|
| `data/attendees.json` | Las 2.989 entidades enlazadas a Slush 2026: 2.988 asistentes y el organizador (id, nombre, tipo, rol) |
| `data/companies/<id>.json` | Ficha completa de 9 startups, con relaciones y fuentes |
| `data/investors/` | Point Nine Capital con su cartera |
| `data/rounds/` | Dos rondas con sus participantes |
| `data/introspection/` | Qué campos y relaciones tiene cada tipo de entidad |
| `data/raw/` | Respuestas tal cual de la búsqueda y de las páginas de asistentes |

## Herramientas

Python 3, sin dependencias.

```
python tools/crawl.py attendees               # vuelve a bajar la lista de asistentes
python tools/crawl.py companies --budget 50   # baja fichas de empresa, saltando las ya guardadas
python tools/coverage.py                      # cobertura de las fichas guardadas, sin llamar a la API
python tools/audit_slush.py out/audit         # auditoría completa del nodo (unas 250 llamadas)
```

La clave de Cala se lee de la variable `CALA_API_KEY` o de un archivo de una línea en `~/.cala_key`. No va en el repo.

La cuenta gratuita permite 10 llamadas por minuto y 100 al mes, así que las herramientas esperan entre llamadas y paran al llegar a un presupuesto (`--budget`, o `CALA_BUDGET` en la auditoría).
