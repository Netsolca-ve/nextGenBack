import {
  Allow,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class MatchUpdateDto {
  @IsOptional()
  @Allow()
  tarjetas?: unknown;

  @IsOptional()
  @Allow()
  cambios?: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  fase?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  numeroRonda?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  marcadorLocal?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  marcadorVisitante?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  marcadorPenalesLocal?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  marcadorPenalesVisitante?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  duracionTiempoMinutos?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  duracionDescansoMinutos?: number;

  @IsOptional()
  @IsBoolean()
  tieneTiempoExtra?: boolean | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  duracionExtraMinutos?: number | null;

  @IsOptional()
  @IsBoolean()
  tieneTandaPenales?: boolean | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  ganador?: number | null;

  @IsOptional()
  @IsDateString()
  fecha?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  direccion?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  idEquipoLocal?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  idEquipoVisitante?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  idArbitro?: number | null;
}

export class MatchAlignmentUpdateDto {
  @IsInt()
  @Min(1)
  idAlineacionPartido: number;

  @IsOptional()
  @IsBoolean()
  esTitular?: boolean;

  @IsOptional()
  @IsBoolean()
  esCapitan?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  numeroCamiseta?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  posicion?: string | null;
}

export class CreateMatchAlignmentDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  idPartido?: number;

  @IsBoolean()
  esTitular: boolean;

  @IsBoolean()
  esCapitan: boolean;

  @IsInt()
  @Min(0)
  numeroCamiseta: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  posicion?: string | null;

  @IsInt()
  @Min(1)
  idEquipo: number;

  @IsInt()
  @Min(1)
  idJugador: number;
}

export class CreateGoalDto {
  @IsInt()
  @Min(0)
  minuto: number;

  @IsBoolean()
  esAutogol: boolean;

  @IsInt()
  @Min(1)
  idJugador: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  idJugadorAsistencia?: number | null;

  @IsInt()
  @Min(1)
  idEquipo: number;
}

export class UpdateGoalDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  minuto?: number;

  @IsOptional()
  @IsBoolean()
  esAutogol?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  idJugador?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  idJugadorAsistencia?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  idEquipo?: number;
}

export class CreateSubstitutionDto {
  @IsInt()
  @Min(0)
  minuto: number;

  @IsInt()
  @Min(1)
  periodo: number;

  @IsInt()
  @Min(1)
  idEquipo: number;

  @IsInt()
  @Min(1)
  idJugadorSale: number;

  @IsInt()
  @Min(1)
  idJugadorEntra: number;
}

export class UpdateSubstitutionDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  minuto?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  periodo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  idEquipo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  idJugadorSale?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  idJugadorEntra?: number;
}
