import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { ConfigModule } from '@nestjs/config';
import { TournamentsModule } from './tournaments/tournaments.module';
import { TeamsModule } from './teams/teams.module';
import { AuthModule } from './auth/auth.module';
import { CatalogsModule } from './catalogs/catalogs.module';
import { UploadsModule } from './uploads/uploads.module';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    TournamentsModule,
    TeamsModule,
    AuthModule,
    CatalogsModule,
    UploadsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
