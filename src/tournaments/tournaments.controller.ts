import { Body, Controller, Get, Post } from '@nestjs/common';
import { TournamentsService } from './tournaments.service';
import { CreateTournamentDto } from './dto/create-tounament.dto';

@Controller('tournaments')
export class TournamentsController {
    constructor(private readonly tournamentsService: TournamentsService) {}

    @Get()
    getAllTournaments() {
        return this.tournamentsService.getAllTournaments();
    }

    @Get('nearest')
    getNearestTournament() {
        return this.tournamentsService.getNearestTournament();
    }

    @Post()
    createTournament(@Body() dto: CreateTournamentDto)  {
        return this.tournamentsService.createTournament(dto);
    }
}
