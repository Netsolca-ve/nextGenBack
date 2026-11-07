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

    this.pool = mysql.createPool({
      host: this.configService.get<string>('DB_HOST', 'localhost'),
      port: Number(this.configService.get<string>('DB_PORT', '3306')),
      user: this.configService.get<string>('DB_USER', 'root'),
      password: this.configService.get<string>('DB_PASSWORD', ''),
      database: this.configService.get<string>('DB_NAME', 'sports_management_db'),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      decimalNumbers: true, // Convierte valores DECIMAL de MySQL a números JS en lugar de strings
      // SSL para TiDB en producción: se activa con DB_SSL=true en el .env
      ssl: useSsl
        ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
        : undefined,
    });

    try {
      const connection = await this.pool.getConnection();
      this.logger.log('Conexión con MySQL establecida correctamente.');
      connection.release();
    } catch (error: any) {
      this.logger.error('Error al conectar con MySQL:', error.message);
      throw error;
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
