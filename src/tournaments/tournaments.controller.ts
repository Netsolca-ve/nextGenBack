import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Put,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

    @Get(':id/equipos')
    getTournamentTeams(@Param('id', ParseIntPipe) id: number) {
        return this.tournamentsService.getTournamentTeams(id);
    }

    @Get(':id/partidos')
    getTournamentMatches(@Param('id', ParseIntPipe) id: number) {
        return this.tournamentsService.getTournamentMatches(id);
    }

    @Get(':id/posiciones')
    getStandings(@Param('id', ParseIntPipe) id: number) {
        return this.tournamentsService.getStandings(id);
    }

    @Post(':id/playoffs')
    generatePlayoffs(@Param('id', ParseIntPipe) id: number) {
        return this.tournamentsService.generatePlayoffs(id);
    }

    @Post(':id/finales')
    generateFinals(@Param('id', ParseIntPipe) id: number) {
        return this.tournamentsService.generateFinals(id);
    }

    @Post()
    @UseInterceptors(
        FileInterceptor('banner', {
            dest: join(process.cwd(), 'assets', 'torneos'),
            limits: { fileSize: 8 * 1024 * 1024 },
            fileFilter: (_request, file, callback) => {
                if (!file.mimetype.startsWith('image/')) {
                    return callback(
                        new BadRequestException('El banner debe ser una imagen'),
                        false,
                    );
                }
                callback(null, true);
            },
        }),
    )
    createTournament(
        @Body() dto: CreateTournamentDto,
        @UploadedFile() banner?: Express.Multer.File,
    )  {
        return this.tournamentsService.createTournament(dto, banner);
    }

    @Put(':id')
    @UseInterceptors(
        FileInterceptor('banner', {
            dest: join(process.cwd(), 'assets', 'torneos'),
            limits: { fileSize: 8 * 1024 * 1024 },
            fileFilter: (_request, file, callback) => {
                if (!file.mimetype.startsWith('image/')) {
                    return callback(
                        new BadRequestException('El banner debe ser una imagen'),
                        false,
                    );
                }
                callback(null, true);
            },
        }),
    )
    updateTournament(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreateTournamentDto,
        @UploadedFile() banner?: Express.Multer.File,
    ) {
        return this.tournamentsService.updateTournament(id, dto, banner);
    }
}

mkdirSync(join(process.cwd(), 'assets', 'torneos'), { recursive: true });
