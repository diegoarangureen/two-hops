# Prompt de construcción

Copia todo lo que hay debajo de la línea y pégalo a Claude con este repositorio abierto.

---

Vas a construir en este repositorio el proyecto con el que nos presentamos al reto de Cala en Junction 2026. La entrega es el domingo 15 de noviembre a las 10:00, hora de Helsinki. Un flujo que funciona de principio a fin vale más que muchas funciones a medias: si dudas, recorta.

## Antes de escribir código

Lee, en este orden: `README.md`, `docs/reto/fintech-track.md`, `docs/IDEA.md`, `docs/AUDITORIA_SLUSH.md`, `docs/CALA_API.md`, `docs/cala_funding_fields_hack_guide.md` y `docs/reto/submissions.md`. Abre un par de archivos de `data/companies/` y `data/rounds/` para ver la forma real de los datos. Lo que digo aquí resume esos documentos; si algo no cuadra, mandan ellos y me avisas.

## El reto

Cala, "Make Unicorns Real": un producto para founders o inversores, usable el día después del hackathon (Slush es el 18 y 19 de noviembre), que resuelva una sola necesidad muy bien. El jurado puntúa a partes iguales necesidad real, ejecución, originalidad y uso de Cala, y avisa de que penaliza la versión genérica de ideas ya vistas. El buscador de inversores o el emparejador de startups de siempre no nos vale.

## El producto

Nombre provisional: **Two Hops** (cámbialo si encuentras uno mejor, máximo 30 caracteres).

Usuario: un founder que va a Slush a levantar una ronda. Su problema: sabe que la intro cálida es lo que abre puertas, pero no sabe qué inversores encajan de verdad ni quién se los puede presentar esa semana.

Lo que hace el producto es recorrer el grafo de Cala desde la propia startup del founder:

1. **Encuéntrate.** El founder busca su empresa entre las entidades enlazadas al nodo Slush 2026. Se lee su ficha (sector, fase, sede).
2. **Primer salto: pares que están en la sala.** Otras empresas asistentes parecidas a la suya que tienen alguna ronda registrada.
3. **Segundo salto: quién las financió y quién lideró.** Las rondas de esos pares, con importe, fecha, participantes y la marca `is_lead`.
4. **Resultado.** Una lista ordenada de inversores. Cada uno con sus caminos: tú → empresa par presente en Slush → ronda → inversor. Y con las personas de esa empresa par a las que pedir la intro (`FOUNDED`, `IS_CEO_OF`, solo cargos vigentes).
5. **Kit de intro.** Para un camino elegido, un borrador de mensaje al founder par que cite solo hechos del camino, y una lista exportable de a quién buscar en Slush.

## El context graph es el producto

Lo que diferencia a Cala de un buscador web como Exa es el grafo con datos fiables. Todo lo que el usuario vea tiene que demostrarlo:

- **La respuesta es un camino, no un texto.** Dibuja el camino como grafo: nodos, aristas con el nombre real de la relación en Cala (`PARTICIPATES_IN_EVENT`, `PARTICIPATES_IN_FUNDING_ROUND`, `INVESTED_IN`, `FOUNDED`) y sus propiedades (`role`, `is_lead`, `event_date`).
- **Sin fuente no hay camino.** Cada nodo y cada arista muestra su fuente, su fecha y su `source_rank` (`FILING`, `PRIMARY`, `PRESS`, `AGGREGATOR`), con enlace al documento. Si un dato no viene de Cala con fuente, no se muestra. El modelo de lenguaje nunca aporta hechos.
- **Confianza calculada sobre el grafo.** La fiabilidad de un camino es la de su eslabón más débil. Un interruptor deja solo los caminos respaldados por registros oficiales y fuentes propias de la empresa.
- **Operaciones sobre el conjunto entero.** Intersecciones y conteos sobre todos los asistentes cargados, no los diez primeros resultados: cuántos pares, cuántos con ronda, qué inversores aparecen en más de un par, qué inversores coinvierten entre sí.
- **Tiempo.** Descarta cargos con `valid_until` pasado, ordena por fecha de ronda y enseña la antigüedad de cada dato.
- **Trampas de los datos, a la vista.** Marca las etiquetas de ronda inferidas (mira `annotations`), une los duplicados `Company` y `Organization`, y no sumes dos veces una financiación que aparece como `FundingRound` y como `PrivateCompanyFundingRound`.
- **Transparencia.** El orden de los inversores se explica con sus factores (número de caminos, veces que lideró, fecha, rango de fuente). Y la interfaz dice cuántas de las 2.989 empresas están cargadas: no finjas una cobertura que no tenemos.

## Datos y créditos

Este es el mayor riesgo, trátalo como tal.

- La clave de Cala se lee de `CALA_API_KEY` o de `~/.cala_key`. Nunca la escribas en el repo, en logs ni en el cliente; las llamadas a Cala van siempre por el servidor.
- La cuenta gratuita da 10 llamadas por minuto y, según la web de Cala, 100 créditos al mes (1 crédito = 1 llamada). Ya se han gastado unas 45. Lleva la cuenta de cada llamada en un registro, guarda en caché todo lo que bajes y no repitas nunca una llamada cuyo resultado ya está en `data/`.
- **Antes de gastar más de 10 créditos, dime cuántos quedan y en qué los vas a usar, y espera mi respuesta.** Estoy pidiendo a Cala una clave con más límite.
- Ya hay en `data/`: las 2.989 entidades enlazadas al nodo (id, nombre, tipo, rol), 9 fichas completas de empresa, la cartera de Point Nine Capital y dos rondas.
- Con pocos créditos, entra por los inversores: una sola llamada a un inversor trae toda su cartera (`INVESTED_IN` saliente, hasta 1.000) y sus rondas, y se cruza por id con la lista de asistentes sin gastar nada más. Está comprobado: la cartera de Point Nine cruza con dos asistentes (Cardino y TesterArmy). Buenos puntos de partida son los cerca de 15 inversores que asisten y los que ya aparecen en las fichas guardadas.
- Si llega una clave con más límite, baja todas las fichas con `tools/crawl.py companies` y mide con `tools/coverage.py`.
- Construye un único archivo de grafo a partir de la caché (nodos y aristas con su procedencia) y haz que la aplicación lea de ahí. La demo tiene que funcionar entera sin llamar a Cala. Deja como mucho una llamada en vivo visible, la de "encuéntrate", que tarda de 0,2 a 5 segundos.
- `knowledge_query` no está probado y puede tardar hasta 180 segundos. Puedes gastar dos créditos en ver si devuelve de una vez asistentes con ronda e inversores; no construyas nada que dependa de ello.

## Qué entregar

1. **La aplicación web**, desplegada en una URL pública. Pregúntame dónde desplegar cuando llegues a ese punto.
2. **Una landing page** en la ruta principal, en inglés: qué problema resuelve, un camino de ejemplo real sacado del grafo con sus fuentes, cómo funciona en tres pasos y la entrada a la aplicación. Sin cifras inventadas ni testimonios.
3. **El script que construye el grafo** desde la caché, y el registro de llamadas a Cala.
4. **`docs/SUBMISSION.md`** con los textos de la entrega en inglés: nombre (máximo 30 caracteres), frase gancho (máximo 200), descripción (máximo 5.000, en markdown), tecnologías usadas, una nota de qué endpoints de Cala se usan y para qué, y un guion de vídeo de 2 minutos como máximo.
5. **`README.md` actualizado** para que un juez lo arranque en local.

Toda la interfaz y los textos de entrega van en inglés. Conmigo habla en español.

## Cómo trabajar

- Elige tú la tecnología buscando la vía más rápida a algo desplegado. Si no tienes preferencia: Next.js con TypeScript, el grafo en un JSON generado por un script de Python, y el dibujo del camino en SVG propio.
- El modelo de lenguaje (hay `ANTHROPIC_API_KEY`, con 20 dólares) solo se usa para redactar el mensaje de intro y, si hace falta, para comparar descripciones de empresas. Usa el modelo barato y pon un tope de llamadas.
- Haz commits pequeños y frecuentes en una rama, con mensajes que digan qué cambia.
- Orden de trabajo: grafo desde la caché → pantalla de caminos con fuentes → "encuéntrate" → orden de inversores → kit de intro → landing → textos de entrega. Si el tiempo aprieta, el kit de intro es lo primero que se cae.
- Cuando termines cada bloque, dime qué funciona, qué has comprobado de verdad y qué no. Si una prueba falla o algo queda a medias, dilo tal cual.
- No toques `docs/reto/` ni la guía de Cala. No subas el repo a GitHub ni lo hagas público sin preguntarme.
