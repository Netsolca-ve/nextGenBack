import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Elimina propiedades del body que no estén en el DTO
      forbidNonWhitelisted: true, // Lanza error 400 si envían campos no permitidos
      transform: true, // Convierte tipos automáticamente si es necesario
    }),
  )

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
