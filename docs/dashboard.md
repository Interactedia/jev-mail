# Panel local

Panel HTTP en `http://127.0.0.1:3000` (solo loopback). Lee `results.json` y `emails.json`; escribe `data/reviews.json`.

## Uso

```bash
npm run dashboard
```

## Secciones

### Tabla de resultados

Lista cada correo clasificado con:
- Remitente y asunto
- Categoría (Trabajo / Personal / Indeterminado)
- Probabilidad de spam y de requerir atención
- Estado: `ok` o `error` (error de clasificación)
- Modelo usado y fuente de la decisión (JEV / RULE / CACHE)

### Métricas

- Total de correos en el lote
- Clasificaciones ok y errores
- Llamadas a Jev y decisiones evitadas por caché/reglas
- Tokens de entrada y salida (si se configura la tarifa en `.env`)

### Gestión de reglas

Lista reglas existentes ordenadas por clasificador. Desde aquí puedes:

- **Crear regla**: especificar clasificador, tipo (EMAIL/DOMAIN), valor y acción.EMAIL cubre la dirección exacta; DOMAIN cubre solo ese dominio (no subdominios).
- **Habilitar/deshabilitar**: toggle de cada regla.

### Gestión de clasificadores

Lista todos los clasificadores. Desde aquí puedes:

- **Crear clasificador**: nombre, descripción, pregunta, tipo (`choice` o `noul`). Choice requiere entre 2 y 20 opciones.
- **Editar**: cambiar nombre, descripción, pregunta, tipo u opciones. Editar la semántica sube la versión e invalida la caché de ese clasificador.
- **Habilitar/deshabilitar**: el clasificador base no puede deshabilitarse.

## Evaluaciones

Desde la tabla de resultados puedes marcar un correo como:

- **Correcto**: la clasificación es acertada
- **Incorrecto**: la clasificación es errónea, con opción de indicar la corrección

Las evaluaciones se guardan en `data/reviews.json` con la clave del correo (formato `IMAP_USER|IMAP_MAILBOX|UIDVALIDITY|UID`).

## Endpoints de la API

| Ruta | Método | Descripción |
|---|---|---|
| `/api/data` | GET | Resultados y datos de correos |
| `/api/reviews` | POST | Guardar evaluación |
| `/api/rules` | POST | Crear regla |
| `/api/rules/toggle` | POST | Toggle regla |
| `/api/classifiers` | POST | Crear clasificador |
| `/api/classifiers/update` | POST | Editar clasificador |
| `/api/classifiers/toggle` | POST | Toggle clasificador |

Todas las respuestas son JSON. Los códigos de error 4xx indican error del cliente; 500 indica error interno.
