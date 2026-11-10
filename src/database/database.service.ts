import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as mysql from 'mysql2/promise';

export type DbStatus = 'connecting' | 'up' | 'down';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool: mysql.Pool;
  private readonly logger = new Logger(DatabaseService.name);

  /** Conexión de la transacción en curso (ver `transaction`). */
  private readonly transactionConnection = new AsyncLocalStorage<mysql.PoolConnection>();

  private status: DbStatus = 'connecting';
  private lastError: string | null = null;
  private destroyRequested = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Normaliza DB_HOST: quita esquema (http://), rutas y espacios por error
    const host = (this.configService.get<string>('DB_HOST', 'localhost') ?? '')
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/+$/, '');

    const sslRequested = ['true', '1', 'yes', 'on'].includes(
      (this.configService.get<string>('DB_SSL', 'false') ?? '')
        .trim()
        .toLowerCase(),
    );

    // TiDB Cloud exige TLS: se activa solo aunque DB_SSL no esté definido
    const useSsl = sslRequested || /\.tidbcloud\.com$/i.test(host);

    const port = Number(this.configService.get<string>('DB_PORT', '3306'));
    const database = this.configService.get<string>(
      'DB_NAME',
      'sports_management_db',
    );

    this.logger.log(
      `Conectando a MySQL en ${host}:${port} (db: ${database}, ssl: ${useSsl})`,
    );

    this.pool = mysql.createPool({
      host,
      port,
      user: this.configService.get<string>('DB_USER', 'root'),
      password: this.configService.get<string>('DB_PASSWORD', ''),
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      decimalNumbers: true, // Convierte valores DECIMAL de MySQL a números JS en lugar de strings
      connectTimeout: 10000,
      // Devuelve DATE/DATETIME como los strings tal cual se guardaron
      // ('YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS'), sin construir objetos Date.
      // Así la API nunca serializa fechas a ISO-Z y el día no "se corre" un día
      // según la zona horaria del servidor o del navegador.
      dateStrings: true,
      // SSL para TiDB en producción: se activa con DB_SSL=true en el .env
      ssl: useSsl
        ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
        : undefined,
    });

    // No se espera la conexión aquí: si la BD tarda o falla, el servidor HTTP
    // ya está escuchando y el health check de Koyeb no falla por eso.
    void this.connectWithRetry(host, port, database, useSsl);
  }

  private async connectWithRetry(
    host: string,
    port: number,
    database: string,
    useSsl: boolean,
  ) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.destroyRequested) return;

      try {
        const connection = await this.pool.getConnection();
        connection.release();
        this.status = 'up';
        this.lastError = null;
        this.logger.log('Conexión con MySQL establecida correctamente.');
        return;
      } catch (error: any) {
        this.status = 'down';
        this.lastError =
          `[code=${error?.code ?? 'n/a'}, errno=${error?.errno ?? 'n/a'}, ` +
          `sqlState=${error?.sqlState ?? 'n/a'}] ${error?.message ?? error}`;

        this.logger.error(
          `Intento ${attempt}/${maxAttempts} falló al conectar a MySQL: ${this.lastError}`,
        );

        if (attempt === maxAttempts) {
          this.logger.error(
            `No se pudo conectar a ${host}:${port}/${database} con ssl=${useSsl}. ` +
              'Revisa DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME y DB_SSL en las variables de entorno. ' +
              'La app seguirá escuchando: /health mostrará db=down y se reintentará cada 30s.',
          );
          void this.retryInBackground(host, port, database, useSsl);
          return;
        }

        await this.sleep(2000);
      }
    }
  }

  // Reintentos lentos para recuperarse si la BD estaba caída al arrancar.
  private async retryInBackground(
    host: string,
    port: number,
    database: string,
    useSsl: boolean,
  ) {
    let failures = 0;

    while (!this.destroyRequested) {
      await this.sleep(30000);
      if (this.destroyRequested) return;

      try {
        const connection = await this.pool.getConnection();
        connection.release();
        this.status = 'up';
        this.lastError = null;
        this.logger.log(
          'Conexión con MySQL restablecida correctamente tras reintentos.',
        );
        return;
      } catch (error: any) {
        failures++;
        this.status = 'down';
        this.lastError =
          `[code=${error?.code ?? 'n/a'}, errno=${error?.errno ?? 'n/a'}] ` +
          `${error?.message ?? error}`;

        // No inundar el log: detalle completo solo cada ~5 minutos
        if (failures === 1 || failures % 10 === 0) {
          this.logger.error(
            `Reintento de conexión a ${host}:${port}/${database} falló (ssl=${useSsl}): ${this.lastError}`,
          );
        }
      }
    }
  }

  getStatus(): { status: DbStatus; error: string | null } {
    return { status: this.status, error: this.lastError };
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    // Dentro de `transaction` se usa su conexión: así cualquier servicio que
    // llame a query() queda incluido en la transacción sin cambiar su código.
    const executor = this.transactionConnection.getStore() ?? this.pool;
    const [results] = await executor.query(sql, params);
    return results as T[];
  }

  /**
   * Ejecuta `work` en una transacción: si algo falla se deshace todo y no
   * quedan datos a medias (ej. un torneo sin partidos). Las transacciones
   * anidadas reutilizan la de afuera.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionConnection.getStore()) {
      return work();
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.transactionConnection.run(connection, work);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch((rollbackError) =>
        this.logger.error(`No se pudo deshacer la transacción: ${rollbackError?.message ?? rollbackError}`),
      );
      throw error;
    } finally {
      connection.release();
    }
  }

  async onModuleDestroy() {
    this.destroyRequested = true;
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Conexiones a MySQL cerradas.');
    }
  }
}
