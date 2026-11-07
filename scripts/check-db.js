/**
 * Prueba de conexión a la base de datos usando las mismas variables y la
 * misma configuración SSL que la aplicación.
 *
 * Uso:
 *   npm run db:check
 *   node --env-file=.env.production.local scripts/check-db.js
 */
const mysql = require('mysql2/promise');

const useSsl = (process.env.DB_SSL ?? 'false') === 'true';

const config = {
  host: (process.env.DB_HOST ?? 'localhost')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, ''),
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'nextgen',
  connectTimeout: 10000,
  ssl: useSsl
    ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
    : undefined,
};

console.log(
  `Probando ${config.host}:${config.port} db=${config.database} user=${config.user} ssl=${useSsl} ...`,
);

mysql
  .createConnection(config)
  .then(async (connection) => {
    const [rows] = await connection.query('SELECT 1 AS ok');
    console.log('Conexión OK:', rows);
    await connection.end();
  })
  .catch((error) => {
    console.error(
      `Conexión FALLÓ [code=${error?.code ?? 'n/a'}]: ${error?.message ?? error}`,
    );
    process.exit(1);
  });
