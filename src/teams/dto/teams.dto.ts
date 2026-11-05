import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  MaxLength,
  Matches,
} from 'class-validator';

export class CreateTeamDto {
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El nombre del equipo es obligatorio' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  nombre: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  siglas?: string;

  @IsString({ message: 'La categoría debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'La categoría es obligatoria' })
  @MaxLength(50)
  categoria: string; // ej: 'SUB-12', 'SUB-10'

  @IsOptional()
  @IsString()
  @MaxLength(255)
  logo?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'El color local debe ser un código hexadecimal válido (ej: #0284c7)',
  })
  colorLocal?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'El color visitante debe ser un código hexadecimal válido (ej: #ffffff)',
  })
  colorVisitante?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  horarioEntrenamientos?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  diasEntrenamientos?: string;

  @IsOptional()
  @IsInt()
  idAcademia?: number | null;

  @IsOptional()
  @IsInt()
  idEntrenador?: number | null;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  siglas?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoria?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  logo?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
  colorLocal?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
  colorVisitante?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  horarioEntrenamientos?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  diasEntrenamientos?: string;

  @IsOptional()
  @IsInt()
  idAcademia?: number | null;

  @IsOptional()
  @IsInt()
  idEntrenador?: number | null;
}

export class CreatePlayerDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(100)
  nombre: string;

  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(100)
  apellido: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tipoIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  identificacion?: string;

  @IsOptional()
  @IsString()
  fechaNacimiento?: string;

  @IsInt({ message: 'El dorsal debe ser un número entero' })
  numeroCamiseta: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  foto?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  posicion?: string;
}

export class UpdatePlayerDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  apellido?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tipoIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  identificacion?: string;

  @IsOptional()
  @IsString()
  fechaNacimiento?: string;

  @IsOptional()
  @IsInt()
  numeroCamiseta?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  foto?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  posicion?: string;
}