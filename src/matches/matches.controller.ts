import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  CreateMatchAlignmentDto,
  CreateGoalDto,
  CreateSubstitutionDto,
  MatchAlignmentUpdateDto,
  MatchUpdateDto,
  UpdateGoalDto,
  UpdateSubstitutionDto,
} from './dto/matches.dto';
import { MatchesService } from './matches.service';

@Controller('matches')
export class MatchesController {
  constructor(private readonly matchesService: MatchesService) {}

  @Get()
  getAllMatches() {
    return this.matchesService.getAllMatches();
  }

  @Get(':id')
  getMatch(@Param('id', ParseIntPipe) id: number) {
    return this.matchesService.getMatch(id);
  }

  @Get(':id/alineaciones')
  getAlignments(@Param('id', ParseIntPipe) id: number) {
    return this.matchesService.getAlignments(id);
  }

  @Post(':id/alineaciones')
  createAlignment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateMatchAlignmentDto,
  ) {
    return this.matchesService.createAlignment(id, dto);
  }

  @Get(':id/tarjetas')
  getCards(@Param('id', ParseIntPipe) id: number) {
    return this.matchesService.getCards(id);
  }

  @Get(':id/goles')
  getGoals(@Param('id', ParseIntPipe) id: number) {
    return this.matchesService.getGoals(id);
  }

  @Post(':id/goles')
  createGoal(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateGoalDto,
  ) {
    return this.matchesService.createGoal(id, dto);
  }

  @Get(':id/goles/:idGol')
  getGoal(
    @Param('id', ParseIntPipe) id: number,
    @Param('idGol', ParseIntPipe) idGol: number,
  ) {
    return this.matchesService.getGoal(id, idGol);
  }

  @Put(':id/goles/:idGol')
  updateGoal(
    @Param('id', ParseIntPipe) id: number,
    @Param('idGol', ParseIntPipe) idGol: number,
    @Body() dto: UpdateGoalDto,
  ) {
    return this.matchesService.updateGoal(id, idGol, dto);
  }

  @Delete(':id/goles/:idGol')
  deleteGoal(
    @Param('id', ParseIntPipe) id: number,
    @Param('idGol', ParseIntPipe) idGol: number,
  ) {
    return this.matchesService.deleteGoal(id, idGol);
  }

  @Get(':id/sustituciones')
  getSubstitutions(@Param('id', ParseIntPipe) id: number) {
    return this.matchesService.getSubstitutions(id);
  }

  @Post(':id/sustituciones')
  createSubstitution(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateSubstitutionDto,
  ) {
    return this.matchesService.createSubstitution(id, dto);
  }

  @Get(':id/sustituciones/:idSustitucionPartido')
  getSubstitution(
    @Param('id', ParseIntPipe) id: number,
    @Param('idSustitucionPartido', ParseIntPipe) idSustitucionPartido: number,
  ) {
    return this.matchesService.getSubstitution(id, idSustitucionPartido);
  }

  @Put(':id/sustituciones/:idSustitucionPartido')
  updateSubstitution(
    @Param('id', ParseIntPipe) id: number,
    @Param('idSustitucionPartido', ParseIntPipe) idSustitucionPartido: number,
    @Body() dto: UpdateSubstitutionDto,
  ) {
    return this.matchesService.updateSubstitution(
      id,
      idSustitucionPartido,
      dto,
    );
  }

  @Delete(':id/sustituciones/:idSustitucionPartido')
  deleteSubstitution(
    @Param('id', ParseIntPipe) id: number,
    @Param('idSustitucionPartido', ParseIntPipe) idSustitucionPartido: number,
  ) {
    return this.matchesService.deleteSubstitution(id, idSustitucionPartido);
  }

  @Put(':id')
  updateMatch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MatchUpdateDto,
  ) {
    return this.matchesService.updateMatch(id, dto);
  }

  @Delete(':id')
  deleteMatch(@Param('id', ParseIntPipe) id: number) {
    return this.matchesService.deleteMatch(id);
  }

  @Put(':id/alineaciones')
  updateAlignments(
    @Param('id', ParseIntPipe) id: number,
    @Body() alignments: MatchAlignmentUpdateDto[],
  ) {
    return this.matchesService.updateAlignments(id, alignments);
  }
}