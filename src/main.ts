import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // CORS: refleja el origen de la petición y permite credenciales.
  // Con origin:'*' + credentials el navegador rechaza el preflight.
  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.useBodyParser('json', { limit: '8mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '8mb' });
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });
  app.useStaticAssets(join(process.cwd(), 'assets'), { prefix: '/assets/' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Elimina propiedades del body que no estén en el DTO
      forbidNonWhitelisted: true, // Lanza error 400 si envían campos no permitidos
      transform: true, // Convierte tipos automáticamente si es necesario
    }),
  );

  // Koyeb inyecta PORT con el puerto expuesto del servicio (normalmente 8000).
  // Si no existe, 8000 es el valor por defecto de Koyeb.
  const port = Number(process.env.PORT ?? 8000);

  if (!process.env.PORT) {
    console.warn(
      'PORT no está definida: usando 8000 por defecto (puerto expuesto de Koyeb).',
    );
  }

  await app.listen(port, '0.0.0.0');
  console.log(
    `Servidor escuchando en el puerto ${port} (0.0.0.0). ` +
      'El puerto expuesto en Koyeb debe coincidir con este.',
  );
}

bootstrap().catch((error) => {
  console.error('Fallo al arrancar la aplicación:', error);
  process.exit(1);
});
