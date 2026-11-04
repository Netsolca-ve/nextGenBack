import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import {
  CreateTeamDto,
  UpdateTeamDto,
  CreatePlayerDto,
  UpdatePlayerDto,
} from './dto/teams.dto';

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
  createTeam(@Body() dto: CreateTeamDto) {
    return this.teamsService.createTeam(dto);
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