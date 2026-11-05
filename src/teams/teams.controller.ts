import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TeamsService } from './teams.service';
import {
  CreateTeamDto,
  UpdateTeamDto,
  CreatePlayerDto,
  UpdatePlayerDto,
} from './dto/teams.dto';

const teamAssetsDirectory = join(process.cwd(), 'assets', 'temas');
mkdirSync(teamAssetsDirectory, { recursive: true });

@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  // --- EQUIPOS ---

  @Get()
  getAllTeams() {
    return this.teamsService.getAllTeams();
  }

  @Get(':id')
  getTeamById(@Param('id', ParseIntPipe) id: number) {
    return this.teamsService.getTeamById(id);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('logo', {
      dest: teamAssetsDirectory,
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_request, file, callback) => {
        if (!file.mimetype.startsWith('image/')) {
          return callback(
            new BadRequestException('El logo debe ser una imagen'),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  createTeam(
    @Body() dto: CreateTeamDto,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.teamsService.createTeam(dto, logo);
  }

  @Put(':id')
  updateTeam(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teamsService.updateTeam(id, dto);
  }

  @Delete(':id')
  deleteTeam(@Param('id', ParseIntPipe) id: number) {
    return this.teamsService.deleteTeam(id);
  }

  // --- JUGADORES / PLANTILLA ---

  @Get(':id/players')
  getPlayers(@Param('id', ParseIntPipe) id: number) {
    return this.teamsService.getPlayersByTeam(id);
  }

  @Post(':id/players')
  addPlayer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreatePlayerDto,
  ) {
    return this.teamsService.addPlayerToTeam(id, dto);
  }

  @Put('players/:idJugador')
  updatePlayer(
    @Param('idJugador', ParseIntPipe) idJugador: number,
    @Body() dto: UpdatePlayerDto,
  ) {
    return this.teamsService.updatePlayer(idJugador, dto);
  }

  @Delete('players/:idJugador')
  deletePlayer(@Param('idJugador', ParseIntPipe) idJugador: number) {
    return this.teamsService.deletePlayer(idJugador);
  }
}