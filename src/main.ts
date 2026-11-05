import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.enableCors();

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

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
