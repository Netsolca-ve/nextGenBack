import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

const parseJson = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export class CreateTournamentDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre del torneo es obligatorio.' })
  @MaxLength(150)
  nombre: string;

  @IsString()
  @IsNotEmpty({ message: 'La categoría del torneo es obligatoria.' })
  @MaxLength(100)
  categoria: string; // ej: 'SUB 12, SUB 15'

  // JSON con toda la configuración del torneo (tipo, días, canchas, fases, criterios, etc.)
  @IsOptional()
  @IsObject()
  @Transform(parseJson)
  formato_config?: Record<string, any>;

  @IsOptional()
  @IsString()
  fechaInicio?: string;

  @IsOptional()
  @IsString()
  fechaFin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string; // PROXIMAMENTE | PROGRAMADO | EN_CURSO | INSCRIPCIONES_ABIERTAS | FINALIZADO

  @IsOptional()
  @IsString()
  @MaxLength(255)
  banner?: string;

  @IsArray()
  @IsInt({ each: true, message: 'Los equipos deben enviarse como una lista de IDs numéricos.' })
  @ArrayMinSize(4, { message: 'Se requieren al menos 4 equipos para generar el torneo.' })
  @Transform(parseJson)
  equiposIds: number[]; // IDs de los equipos inscritos (mínimo 4)

  @IsOptional()
  @IsInt()
  @Min(1)
  duracionTiempoMinutos?: number; // por defecto 20

  @IsOptional()
  @IsInt()
  @Min(0)
  duracionDescansoMinutos?: number; // por defecto 5
}
