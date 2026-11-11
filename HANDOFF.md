# HANDOFF: Next Gen Sport Ecosystem

Resumen de las sesiones del 10 y 11/11/2026 para continuar en otra máquina.

## Proyectos

| Repo | Qué es | Despliegue |
|---|---|---|
| `next-gen-back` | NestJS 12 + MySQL/TiDB (`mysql2`) | Koyeb (plan gratis, disco efímero) |
| `nextGen` | Angular 22 + Angular Material + `@lucide/angular` | Vercel |

## Estado de los repos

Los dos están en `main`, sincronizados con `origin/main` hasta estos commits:

- Back: `4c23097 cambios mezclados y dependencias instaladas`
- Front: `2afd5cf filtrar partidos por categoria`

**Hay cambios sin commit en los dos repos** (secciones 8 a 12 de "Qué se hizo"):

- Back: `tournaments.service.ts`, `tournaments.controller.ts`, `create-tounament.dto.ts`, `tournaments.calendar.spec.ts`, `scripts/sql/` (nuevo) y este `HANDOFF.md`.
- Front: prerender (`angular.json`, `package.json`, `pnpm-lock.yaml`, `vercel.json`, `src/main.server.ts`, `src/app/app.config.server.ts`, `src/app/app.routes.server.ts`), SEO (`index.html`, `site.ts`, `seo.ts`, `app.routes.ts`, `sitemap.xml`, `public-layout.html`), sede, goleadores, contador del home y banner de la academia.
- Front, cambios que no son de estas sesiones: `about-us.scss`, `almirantes.scss` y parte de `public-layout.html` (enlace de WhatsApp). Revisarlos antes de commitear.

**Nada se desplegó todavía en Koyeb ni en Vercel.**

## Puesta en marcha en la laptop

1. Clonar los dos repos. Back: `npm install`. Front: `pnpm install` (usa **pnpm**: tiene `pnpm-lock.yaml`; `npm install` falla con su `node_modules`).
2. Back: crear `.env` con estas variables (los valores están en Koyeb o en el `.env` de la otra máquina):
   - BD: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `PORT`. Agregar `DB_SSL=true` para TiDB; con un host `*.tidbcloud.com` se activa solo.
   - R2: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`nextgen-media`), `R2_PUBLIC_URL` (`https://pub-….r2.dev`).
3. Back: `npm run start:dev`. Usa siempre este modo: `node dist/main` no recarga los cambios, y eso causó dos de los errores de esta sesión ("property … should not exist" y "Cannot DELETE /tournaments/6").
4. Front: revisa `src/environments/environment.development.ts`. Ahí se elige `http://localhost:3000` o la API de Koyeb. **Si apunta a Koyeb, todo lo que hagas desde el front local se guarda en producción.**
5. Verificar:
   - Back: `npm test` (53 tests) y `npm run build`.
   - Front: `npx ng build` (debe decir "Prerendered 5 static routes") y `npx ng test --watch=false` (48 tests; `home.spec.ts` ya usa servicios simulados).
6. La BD local de la otra máquina era el MySQL (MariaDB) de XAMPP (`/opt/lampp`). En la laptop hace falta una BD con el mismo esquema, o apuntar a TiDB. Si es una copia vieja, aplicar antes `scripts/sql/2026-11-11-torneos-sede.sql`.

### Carpeta `scripts/` del back

No la usa la app en ejecución (el build solo compila `src/` y Koyeb corre `dist/main`), pero conviene conservarla:

| Archivo | Para qué | ¿Hace falta? |
|---|---|---|
| `scripts/sql/2026-11-11-torneos-sede.sql` | Agrega la columna `torneos.sede` y copia la sede guardada en `formato_config` | **Sí, en producción antes de desplegar el back** |
| `scripts/migrate-images-to-r2.js` (`npm run images:migrate`) | Pasa a R2 las imágenes que la BD referencia en disco | Una vez en producción; después se puede borrar |
| `scripts/check-db.js` (`npm run db:check`) | Prueba la conexión a la BD con la misma configuración SSL que la app | Útil para diagnosticar; opcional |

---

## Qué se hizo

### 1. Eliminar partido
- Back: `DELETE /matches/:id`. Borra `goles`, `tarjetas`, `sustitucionespartido`, `alineacionespartido` y `Partidos` en una transacción. Si el partido era de fase de grupos, reacomoda la fase definitoria.
- Front: botón "Eliminar" en el admin de partidos, con el modal `features/admin/matches/components/delete-match`.

### 2. Imágenes en Cloudflare R2 (back)
- `src/storage/storage.service.ts` (módulo global):
  - Sube con `@aws-sdk/client-s3` (put, copy, delete).
  - Procesa con `sharp`: redimensiona sin recortar y convierte a WebP con calidad 80.
  - Tamaños (`src/storage/image-presets.ts`): logos de equipo 512 px, fotos de jugador 800 px, banners de torneo 1600 px.
- **En la BD se guarda solo la key** (por ejemplo `equipos/alpha-sub-12.webp`). La API devuelve la URL completa armada con `R2_PUBLIC_URL`. Para pasar a `media.nextgen.com.ve` basta con cambiar esa variable.
- Flujo de subida: `POST /uploads/image` sube a `tmp/{tipo}/{uuid}.webp` y devuelve `{ key, url }`. Al guardar el equipo, jugador o torneo con esa URL, el back copia la imagen a su nombre definitivo y borra la temporal y la anterior (`assignImage` / `commit` / `rollback`).
- Nombres:
  - Equipo: `equipos/{slug}.webp`. El slug sigue al nombre y es único: si ya existe, se le añade `-2`, `-3`…
  - Jugador: `jugadores/{slug-equipo}/{nombre-apellido}-{idJugador}.webp`
  - Torneo: `torneos/{slug-nombre}-{idTorneo}.webp`. Se añadió el id porque la tabla `torneos` no tiene columna slug.
- Renombrados:
  - Cambiar el nombre de un equipo renombra su logo y la carpeta de fotos de sus jugadores.
  - Cambiar el nombre de un jugador o de un torneo renombra su imagen.
  - Borrar un equipo o un jugador borra sus imágenes.
- Si el front reenvía una URL vieja de R2, se ignora y se conserva la imagen actual.
- Se quitaron `useStaticAssets('/uploads')` y `'/assets'` y ya no se guarda nada en disco. Los `FileInterceptor` usan memoria.
- `Cache-Control: public, no-cache`, porque la misma key se reutiliza al cambiar la imagen.
- Script `npm run images:migrate` (`scripts/migrate-images-to-r2.js`, con `--dry-run`): migra lo que la BD referencia en `/uploads` o `/assets` y rellena los slugs vacíos.
  - Se ejecutó en la BD local y después **se reseteó a cero a petición del usuario**: se borraron todos los objetos del bucket, y en la BD local `logo` y `foto` quedaron en NULL y los banners con la imagen por defecto. Los slugs se conservaron.
  - El respaldo `r2-migration-2026-11-10T19-35-08-393Z.json` está ignorado en git y solo existe en la otra máquina.
- Front: `image-upload.ts` reduce cada imagen al tamaño de su tipo y la envía en WebP. Los formularios no cambiaron: siguen mandando la URL que devuelve la subida.

### 3. Fecha y hora de Venezuela (front)
- `src/app/@core/utils/ve-date-adapter.ts`, registrado en `app.config.ts` con `provideVenezuelaDates()`:
  - `LOCALE_ID` y `MAT_DATE_LOCALE` en `es-VE`.
  - `VeDateAdapter`: lee lo escrito a mano como dd/mm/aaaa y carga las fechas `YYYY-MM-DD` del back en hora local.
  - Textos del calendario en español.
- Se cambiaron los `<input type="date|time|datetime-local">` nativos por datepicker y timepicker de Material en: torneo (inicio, cierre, días de juego, hora de inicio), nacimiento del jugador, filtro de partidos, y fecha y hora al editar un partido (dos controles que se unen con `combineDateTime`).
- Las horas se muestran en 12 h ("8:30 a. m.") con `formatDisplayTime`. Al back se envían en 24 h.

### 4. El día que se restaba (causa encontrada)
- La versión desplegada en Koyeb lee las fechas con `CONVERT_TZ(..., '+00:00', '-04:00')` y las guarda sin convertir. Cada edición retrocede la fecha 4 horas, y una fecha a las 00:00 pasa al día anterior.
- El código actual usa `dateStrings: true` y no tiene ninguna conversión. Se comprobó editando 3 veces seguidas: la fecha no cambia.
- **Los datos de producción que ya se corrieron no se arreglan solos** (pendiente más abajo).

### 5. Calendario de torneos (back: `tournaments.service.ts`)
- **Transacciones:** `DatabaseService.transaction()` usa `AsyncLocalStorage`, así que cualquier `db.query()` dentro de la transacción usa la misma conexión. Van en transacción: crear, editar y eliminar torneo; editar y eliminar partido; `refreshDefinitoria`.
- **Un planificador para todo** (`scheduleMatches`), que usan tanto crear como reprogramar:
  - Un partido cada 45 minutos como mínimo. Si el partido dura más (tiempos × duración + descansos), se usa su duración.
  - Las jornadas de cada categoría se reparten de forma pareja entre los días de grupos (antes se amontonaban en el último).
  - Dentro de un día se alternan las categorías para que los equipos descansen.
  - El último día de juego es solo para el tercer lugar y la final de cada categoría: primero todos los terceros lugares y luego las finales.
  - Si los partidos de un día no caben antes de medianoche, devuelve un error en vez de pasarlos al día siguiente.
- **Validación** (`resolveCalendar`):
  - Fecha de inicio y de cierre obligatorias, y la de cierre no puede ser anterior.
  - Con fase final hacen falta al menos 2 días de juego.
  - Todos los días deben estar entre el inicio y el cierre.
- **Tercer lugar y final:** se asignan solo cuando **todos** los partidos de grupos de esa categoría tienen resultado (1.º contra 2.º y 3.º contra 4.º). Antes se llenaban con equipos provisionales; ahora quedan "Por definir".
- **"Próximamente":** guarda los equipos sin generar el calendario. Se genera al pasar el torneo a otro estado.
- **Editar torneo:**
  - Nombre, sede, banner o estado: no toca los partidos ni valida el calendario.
  - Fechas, días, hora de inicio o duración (`calendarSignature`): reprograma solo los partidos pendientes; los jugados conservan su horario.
  - Equipos o tipo de torneo: genera el calendario de nuevo si no hay resultados; si los hay, lo rechaza con un mensaje.
- **Eliminar torneo:** `DELETE /tournaments/:id`. Borra los partidos y sus registros, las inscripciones y el torneo, y después el banner en R2. Los equipos no se tocan. **Hoy borra aunque haya partidos con resultado.**
- Se quitaron las canchas del formulario: se juega en una sola cancha.

### 6. Guardar un partido sin que quede a medias
- Antes, el front lanzaba en paralelo `PUT /matches/:id`, alineaciones, goles y cambios. Si una petición fallaba, las otras ya estaban guardadas.
- Ahora va **una sola petición** `PUT /matches/:id` con `alineaciones`, `nuevasAlineaciones`, `goles`, `sustituciones` y `tarjetas` (DTOs anidados en `matches.dto.ts`), y todo se guarda en una transacción. Al cambiar un equipo, se borran los registros del que sale antes de guardar los del que entra.
- **Tarjetas:** antes no existían en el back. Se agregaron `GET /matches/:id/tarjetas` y su guardado (color `amarilla`/`roja`; el jugador es obligatorio).
- El periodo de los cambios ahora se envía como número.

### 7. Categorías en el home y en el evento (front)
- **Home:** el selector ya existía, pero solo aparece si el torneo "más cercano" tiene más de una categoría. Se quitó la opción "Todas", que mezclaba equipos de categorías distintas en una sola tabla.
- **Evento:** se reactivó el selector, que estaba comentado en el HTML, y se movió encima de "Partidos" y "Tabla". Las fases se muestran como "Fase de grupos · Jornada N", "Tercer lugar" o "Final", y los equipos sin definir como "Por definir". Lo cubre un test en `event.spec.ts`.
- **Admin de torneos:** botones "Editar" y "Eliminar" en cada tarjeta (modal `delete-tournament`), y las fechas en dd/mm/aaaa.

### 8. SEO y prerender (front)
- **Prerender estático** con `@angular/ssr` (`outputMode: "static"` en `angular.json`): el build genera HTML completo para `/`, `/about-us`, `/academies`, `/academies/almirantes` y `/events` (`app.routes.server.ts`). El resto se renderiza en el navegador con `index.csr.html`, y `vercel.json` redirige ahí. En Vercel la carpeta de salida sigue siendo `dist/nextGen/browser`.
- Durante el build no se llama a la API (interceptor `browserOnlyApi` en `app.config.ts`); torneos, partidos y tablas se cargan en el navegador. Hidratación activada (`provideClientHydration`).
- **Bug corregido:** `seo.ts` buscaba el título en `data['title']`, pero las rutas lo definen con `title:`. Todas las páginas terminaban con el título del home (también en producción).
- Títulos: el home es "Next Gen Venezuela | Torneos de futsal y academias"; el resto termina en "| Next Gen Venezuela". "NextGen" (junto) **solo** está en el `alternateName` del JSON-LD de `index.html`; el usuario no quiere mostrarlo en la página.
- `/about` redirige a `/about-us` (Google tenía indexada la URL vieja). Favicon oscuro y títulos ya publicados: falta que Google reindexe.
- El carrusel de `almirantes.ts` arranca con `afterNextRender` (fallaba en el prerender).
- El texto oculto (`display: none`) para buscadores se descartó: Google lo considera spam.

### 9. Sede del torneo
- El campo "Sede" (al lado de "Organizador") se guardaba solo dentro de `formato_config.place`, y las páginas públicas mostraban "Sede por definir".
- Columna nueva `torneos.sede` (`scripts/sql/2026-11-11-torneos-sede.sql`, ya aplicada en la BD local). El back la guarda y la devuelve; si llega un formulario antiguo, la toma de `formato_config.place`. El front la envía como `sede`.

### 10. Máximos goleadores en el evento
- Back: `GET /tournaments/:id/goleadores`. Goles por jugador sin autogoles, con la categoría del equipo dentro del torneo (la misma que usa la tabla).
- Front: tarjeta "Máximos goleadores" debajo de la tabla de posiciones, filtrada por la categoría elegida. Los empatados comparten posición. La tabla y los goleadores tienen scroll propio (máximo 360 px).

### 11. Torneo destacado del home
- Back: `GET /tournaments/nearest` elige por fecha (hora de Venezuela): primero el que está en curso, luego el próximo más cercano y, si no queda ninguno, el último que terminó. Devuelve `estadoCalendario` (`PROXIMO`, `EN_CURSO`, `FINALIZADO`, `PROXIMAMENTE`). Los conteos van en subconsultas (MariaDB/TiDB con `ONLY_FULL_GROUP_BY`).
- Front: "PRÓXIMO EVENTO" con contador hasta la hora de inicio de la jornada; "EVENTO EN CURSO" con indicador verde y fechas; "EVENTO FINALIZADO" solo si no hay otro torneo por venir.

### 12. Banner de la academia en el home
- Tamaños fluidos con `clamp()`: el título y el botón quedan en una línea y el texto tiene el mismo aire arriba y abajo entre 375 y 1920 px. La foto de los niños va pegada a los bordes derecho e inferior (requisito del usuario).

---

## Decisiones tomadas

- En la BD se guarda la key de R2, nunca la URL completa.
- Las imágenes se suben a `tmp/` y se mueven a su nombre definitivo al guardar la entidad, para que el front no tenga que mandar el id o el slug.
- Banners: `torneos/{slug}-{id}.webp`, con id, porque los torneos no tienen slug único.
- Fechas: se guardan y se leen como "hora de pared", sin zona horaria. Nunca `CONVERT_TZ` ni objetos `Date` en la API.
- Datepicker y timepicker de Material con locale `es-VE`, porque los inputs nativos dependen del idioma del navegador de cada cliente.
- Separación mínima de 45 minutos entre partidos y una sola cancha.
- La final y el tercer lugar se definen al terminar la fase de grupos de su categoría.
- Las horas cambiadas a mano en un partido se conservan al editar el torneo, salvo que cambie el calendario.
- Prerender estático (no SSR): las páginas públicas tienen contenido fijo y Vercel las sirve como archivos, sin servidor.
- La marca visible es "Next Gen" (separado); "NextGen" solo se usa como nombre alternativo para buscadores.
- La sede es una columna propia de `torneos`, no un dato de `formato_config`.

## Pendientes

1. **Ejecutar `scripts/sql/2026-11-11-torneos-sede.sql` en producción (TiDB) antes de desplegar el back.** Sin la columna `sede`, crear y editar torneos falla.
2. **Commitear y desplegar** el back (Koyeb) y el front (Vercel) a la vez: "editar partido" usa la petición única, el home necesita `estadoCalendario` y el evento necesita `/goleadores`.
   - Después, en producción: `node --env-file=<env de prod> scripts/migrate-images-to-r2.js --dry-run`. Las imágenes del disco de Koyeb probablemente se perdieron; el script marca con ✗ las que no encuentra y no toca esas filas.
3. **Google Search Console:** enviar `https://www.nextgen.com.ve/sitemap.xml` y solicitar indexación de `/` y `/about-us`. Para competir con otros "Next Gen": Perfil de Empresa de Google y enlaces desde Instagram y otros sitios.
4. **Revisar a mano en producción las fechas de partidos y torneos** que se corrieron por el bug de `CONVERT_TZ`.
5. **Proteger "Eliminar torneo" cuando hay resultados** (propuesto, sin aplicar): mostrar en el modal cuántos partidos jugados se pierden y pedir el nombre del torneo para confirmar, o bloquear el borrado en el back.
6. **R2:** regla de ciclo de vida que borre `tmp/` después de 1 día. Valorar un bucket de desarrollo (`nextgen-media-dev`): hoy local y producción comparten bucket.
7. **Bundle inicial del front:** ~927 kB, sobre el presupuesto de 500 kB (límite de error: 1 MB). Ya pesaba ~894 kB antes del prerender.
8. **Torneos antiguos sin días de juego:** si se les cambia el calendario o los equipos, habrá que agregarles días.
9. **Campos sin uso:** "Total de jornadas" y los "cruces" de la fase final del formulario de torneo. Quitarlos o implementarlos.
10. **Errores de clave foránea** (por ejemplo, un jugador inexistente en un gol) llegan como 500 genérico. Traducirlos a 400 con un mensaje claro.
11. **Futuro:** dominio `media.nextgen.com.ve` (DNS de NIC.ve a Cloudflare y cambiar `R2_PUBLIC_URL`). Comprobantes de pago a ~1600 px en un bucket privado `nextgen-private` con presigned URLs.
