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
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Type } from 'class-transformer';

const parseJson = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Equipos inscritos en una categoría dentro de un torneo multi-categoría. */
export class CategoriaEquiposDto {
  @IsString()
  @IsNotEmpty({ message: 'Cada grupo de equipos debe indicar su categoría.' })
  @MaxLength(100)
  categoria: string; // ej: 'SUB 9'

  @IsArray()
  @IsInt({ each: true, message: 'Los equipos deben enviarse como una lista de IDs numéricos.' })
  @ArrayMinSize(4, { message: 'Cada categoría requiere al menos 4 equipos.' })
  @Transform(parseJson)
  equiposIds: number[];
}

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
  @MaxLength(150)
  sede?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  banner?: string;

  @IsArray()
  @IsInt({ each: true, message: 'Los equipos deben enviarse como una lista de IDs numéricos.' })
  @ArrayMinSize(4, { message: 'Se requieren al menos 4 equipos para generar el torneo.' })
  @Transform(parseJson)
  equiposIds: number[]; // IDs de los equipos inscritos en total (mínimo 4)

  /**
   * Equipos agrupados por categoría: genera un fixture independiente por
   * categoría (p. ej. SUB 9 y SUB 12 en el mismo torneo, cada una con sus
   * 4 equipos jugando entre sí). Si no se envía, `equiposIds` se usa como
   * una sola lista mezclada (compatibilidad con torneos antiguos).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true, message: 'Cada categoría necesita su lista de equipos.' })
  @Type(() => CategoriaEquiposDto)
  @Transform(parseJson)
  categorias?: CategoriaEquiposDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  duracionTiempoMinutos?: number; // por defecto 20

  @IsOptional()
  @IsInt()
  @Min(0)
  duracionDescansoMinutos?: number; // por defecto 5
}
