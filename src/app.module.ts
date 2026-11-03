import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import { DatabaseModule } from './database/database.module';
import { ConfigModule } from '@nestjs/config';
import { TournamentsService } from './tournaments/tournaments.service';
import { TournamentsController } from './tournaments/tournaments.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule],
  controllers: [AppController, TournamentsController],
  providers: [AppService, TournamentsService],
})
export class AppModule {}
