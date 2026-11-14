# Cala: notas de la API

Resumen de la documentación pública (docs.cala.ai) y de lo comprobado en la auditoría. La guía de campos oficial del reto está en `cala_funding_fields_hack_guide.md` y la especificación completa en `cala_openapi.json`.

## Acceso

- Base: `https://api.cala.ai/v1`, cabecera `X-API-KEY`.
- MCP: `https://api.cala.ai/mcp/` con la misma cabecera.
- Clave: https://console.cala.ai/api-keys
- Cuenta gratuita: 10 llamadas por minuto, 100 créditos al mes.

## Endpoints

| Quiero | Endpoint |
|---|---|
| Buscar una entidad por nombre | `GET /entities?name=...&entity_types=Company&limit=20` |
| Buscar por identificador (LEI, CIK, SIREN, Companies House) | `POST /entities/lookup` |
| Ver qué campos y relaciones tiene una entidad | `GET /entities/{id}/introspection` |
| Traer valores, relaciones y series | `POST /entities/{id}` |
| Filas estructuradas a partir de una pregunta o consulta | `POST /knowledge/query` |
| Respuesta redactada con citas | `POST /knowledge/search` |

Cala recomienda para el reto los endpoints de entidad.

## Traer una entidad

```json
POST /entities/{id}
{
  "properties": ["name", "funding_stage", "total_funding"],
  "relationships": {
    "outgoing": {"PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50, "offset": 0}},
    "incoming": {"INVESTED_IN": {"limit": 50, "offset": 0}, "FOUNDED": {"limit": 20, "offset": 0}}
  }
}
```

- `limit` máximo 1.000 por relación.
- Sin cuerpo devuelve solo las propiedades por defecto, sin relaciones.
- Pedir una relación que no existe no da error.

## Forma de los datos

Propiedad:

```json
"legal_name": {"value": "Synhelion AG",
  "sources": [{"name": "synhelion.com", "document": "https://synhelion.com/",
               "date": "2026-11-04", "date_precision": "day", "source_rank": "PRIMARY"}]}
```

Relación:

```json
{"id": "...", "name": "Swiss KMU Partners AG", "entity_type": "Company",
 "properties": {"role": "INVESTOR", "is_lead": true, "sources": [...]}}
```

`source_rank`: `FILING` (registros y reguladores), `PRIMARY` (la empresa o sus inversores), `PRESS`, `AGGREGATOR`.

## Recorridos útiles

- Asistentes de Slush: evento `bc844d56-6ab4-452b-96bf-2661e86e592b` → `PARTICIPATES_IN_EVENT` entrante.
- Rondas de una empresa: `PARTICIPATES_IN_FUNDING_ROUND` saliente, quedándose con `role = ISSUER`.
- Inversores de una ronda: en la ronda, `PARTICIPATES_IN_FUNDING_ROUND` entrante con `role = INVESTOR` o `LENDER`, y `is_lead`.
- Inversores de una empresa, todas las rondas juntas: `INVESTED_IN` entrante.
- Cartera de un inversor: `INVESTED_IN` saliente.
- Personas: `FOUNDED`, `IS_CEO_OF`, `IS_CTO_OF`, `IS_BOARD_MEMBER_OF`, `WORKS_AT` entrantes.

## Trampas

- Una financiación puede estar dos veces: como `FundingRound` y como `PrivateCompanyFundingRound` (de registros). Casar por fecha e importe antes de sumar.
- La etiqueta de ronda puede estar inferida: mirar `annotations`.
- Las empresas están bajo su nombre legal; la marca va en `name` o `aliases`.
- Si un campo no aplica, no viene. Ausente no significa cero.
- `knowledge_query` puede tardar hasta 180 s y los números pueden venir como texto aproximado.
