import { Module } from '@nestjs/common';
import { TournamentsService } from './tournaments.service';
import { TournamentsController } from './tournaments.controller';

@Module({
    controllers: [TournamentsController],
    providers: [TournamentsService],
    exports: [TournamentsService],
})
export class TournamentsModule {}
