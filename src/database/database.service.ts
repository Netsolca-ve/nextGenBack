import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
    private pool: mysql.Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const useSsl =
      this.configService.get<string>('DB_SSL', 'false') === 'true';

    // Normaliza DB_HOST: quita esquema (http://), rutas y espacios por error
    const host = (this.configService.get<string>('DB_HOST', 'localhost') ?? '')
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/+$/, '');
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
      // SSL para TiDB en producción: se activa con DB_SSL=true en el .env
      ssl: useSsl
        ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
        : undefined,
    });

    // Reintenta el arranque: la BD puede tardar en despertar (TiDB serverless)
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const connection = await this.pool.getConnection();
        this.logger.log('Conexión con MySQL establecida correctamente.');
        connection.release();
        return;
      } catch (error: any) {
        this.logger.error(
          `Intento ${attempt}/${maxAttempts} falló al conectar a MySQL ` +
            `[code=${error?.code ?? 'n/a'}, errno=${error?.errno ?? 'n/a'}, ` +
            `sqlState=${error?.sqlState ?? 'n/a'}]: ${error?.message ?? error}`,
        );

        if (attempt === maxAttempts) {
          this.logger.error(
            `No se pudo conectar a ${host}:${port}/${database} con ssl=${useSsl}. ` +
              'Revisa DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME y DB_SSL en las variables de entorno.',
          );
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const [results] = await this.pool.query(sql, params);
    return results as T[];
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Conexiones a MySQL cerradas.');
    }
  }
}
