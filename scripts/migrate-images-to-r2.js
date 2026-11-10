/**
 * Migra a Cloudflare R2 las imágenes que la BD aún referencia en disco
 * (`/uploads/...`, `/assets/...`) o por URL absoluta del backend, con los
 * nombres nuevos, y guarda en la BD solo la key:
 *
 *   equipos.logo   → equipos/{slug}.webp                         (512 px)
 *   jugadores.foto → jugadores/{slug-equipo}/{nombre-apellido}-{id}.webp (800 px)
 *   torneos.banner → torneos/{slug-torneo}-{id}.webp             (1600 px)
 *
 * También genera el slug de los equipos que no lo tienen.
 * Las rutas del front (`/images/...`) y las keys que ya están en R2 no se tocan.
 * Antes de escribir guarda los valores anteriores en r2-migration-<fecha>.json.
 *
 * Uso:
 *   npm run images:migrate -- --dry-run   (solo muestra lo que haría)
 *   npm run images:migrate
 *   node --env-file=.env.production.local scripts/migrate-images-to-r2.js
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const mysql = require('mysql2/promise');
const sharp = require('sharp');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const DRY_RUN = process.argv.includes('--dry-run');

// Mismos tamaños que src/storage/image-presets.ts
const PRESETS = {
  team: { maxSize: 512, quality: 80 },
  player: { maxSize: 800, quality: 80 },
  tournament: { maxSize: 1600, quality: 80 },
};

function createSlug(text, fallback) {
  const slug = (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

const isManagedKey = (value) =>
  !!value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('/');

// ------------------------------------------------------------------
// Conexiones
// ------------------------------------------------------------------

const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

const bucket = process.env.R2_BUCKET;
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const dbHost = (process.env.DB_HOST ?? 'localhost')
  .trim()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .replace(/\/+$/, '');
const useSsl =
  ['true', '1', 'yes', 'on'].includes((process.env.DB_SSL ?? '').trim().toLowerCase()) ||
  /\.tidbcloud\.com$/i.test(dbHost);

// ------------------------------------------------------------------
// Imagen origen → WebP en R2
// ------------------------------------------------------------------

/** Lee la imagen del disco (si la ruta es /uploads o /assets) o la descarga. */
async function readSource(value) {
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // ya es una ruta relativa
  }

  if (/^\/(uploads|assets)\//.test(pathname)) {
    const localFile = join(process.cwd(), decodeURIComponent(pathname));
    if (existsSync(localFile)) return readFileSync(localFile);
  }

  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${value}`);
    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error(`no se encontró el archivo de ${value}`);
}

async function uploadImage(value, key, preset) {
  const source = await readSource(value);
  const { maxSize, quality } = PRESETS[preset];
  const body = await sharp(source)
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();

  if (!DRY_RUN) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'public, no-cache',
      }),
    );
  }

  return `${(source.length / 1024).toFixed(0)} KB → ${(body.length / 1024).toFixed(0)} KB`;
}

// ------------------------------------------------------------------
// Migración
// ------------------------------------------------------------------

async function main() {
  const db = await mysql.createConnection({
    host: dbHost,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'nextgen',
    connectTimeout: 10000,
    ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  });

  console.log(
    `${DRY_RUN ? '[DRY RUN] ' : ''}BD ${dbHost}/${process.env.DB_NAME} → bucket ${bucket}\n`,
  );

  const [teams] = await db.query('SELECT idEquipo, nombre, slug, logo FROM equipos ORDER BY idEquipo');
  const [players] = await db.query(
    `SELECT idJugador, nombre, apellido, idEquipo, foto FROM jugadores
     WHERE foto IS NOT NULL AND foto <> '' ORDER BY idJugador`,
  );
  const [tournaments] = await db.query('SELECT idTorneo, nombre, banner FROM torneos ORDER BY idTorneo');

  const backupFile = `r2-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  if (!DRY_RUN) {
    writeFileSync(backupFile, JSON.stringify({ teams, players, tournaments }, null, 2));
    console.log(`Valores anteriores guardados en ${backupFile}\n`);
  }

  const failures = [];
  const run = async (label, work) => {
    try {
      console.log(`  ✓ ${label}: ${await work()}`);
    } catch (error) {
      failures.push(label);
      console.log(`  ✗ ${label}: ${error.message}`);
    }
  };

  // 1. Slugs únicos para los equipos que no lo tienen
  console.log('Slugs de equipos');
  const takenSlugs = new Set(teams.filter((team) => team.slug).map((team) => team.slug));
  for (const team of teams) {
    if (team.slug) continue;
    const base = createSlug(team.nombre, 'equipo');
    let slug = base;
    for (let suffix = 2; takenSlugs.has(slug); suffix++) slug = `${base}-${suffix}`;
    takenSlugs.add(slug);
    team.slug = slug;

    await run(`#${team.idEquipo} ${team.nombre}`, async () => {
      if (!DRY_RUN) {
        await db.query('UPDATE equipos SET slug = ? WHERE idEquipo = ?', [slug, team.idEquipo]);
      }
      return slug;
    });
  }

  const pending = (value) => value && !isManagedKey(value) && !value.startsWith('/images/');

  // 2. Logos de equipos
  console.log('\nLogos de equipos');
  for (const team of teams.filter((row) => pending(row.logo))) {
    const key = `equipos/${team.slug}.webp`;
    await run(`#${team.idEquipo} ${team.nombre} → ${key}`, async () => {
      const size = await uploadImage(team.logo, key, 'team');
      if (!DRY_RUN) {
        await db.query('UPDATE equipos SET logo = ? WHERE idEquipo = ?', [key, team.idEquipo]);
      }
      return size;
    });
  }

  // 3. Fotos de jugadores
  console.log('\nFotos de jugadores');
  const teamSlugs = new Map(teams.map((team) => [team.idEquipo, team.slug]));
  for (const player of players.filter((row) => pending(row.foto))) {
    const teamSlug = teamSlugs.get(player.idEquipo) ?? 'sin-equipo';
    const playerSlug = createSlug(`${player.nombre} ${player.apellido}`, 'jugador');
    const key = `jugadores/${teamSlug}/${playerSlug}-${player.idJugador}.webp`;
    await run(`#${player.idJugador} ${player.nombre} ${player.apellido} → ${key}`, async () => {
      const size = await uploadImage(player.foto, key, 'player');
      if (!DRY_RUN) {
        await db.query('UPDATE jugadores SET foto = ? WHERE idJugador = ?', [key, player.idJugador]);
      }
      return size;
    });
  }

  // 4. Banners de torneos
  console.log('\nBanners de torneos');
  for (const tournament of tournaments.filter((row) => pending(row.banner))) {
    const key = `torneos/${createSlug(tournament.nombre, 'torneo')}-${tournament.idTorneo}.webp`;
    await run(`#${tournament.idTorneo} ${tournament.nombre} → ${key}`, async () => {
      const size = await uploadImage(tournament.banner, key, 'tournament');
      if (!DRY_RUN) {
        await db.query('UPDATE torneos SET banner = ? WHERE idTorneo = ?', [key, tournament.idTorneo]);
      }
      return size;
    });
  }

  await db.end();

  console.log(
    failures.length
      ? `\nTerminado con ${failures.length} error(es). Esas filas no se modificaron.`
      : `\nTerminado sin errores${DRY_RUN ? ' (no se escribió nada)' : ''}.`,
  );
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error('La migración falló:', error);
  process.exit(1);
});
