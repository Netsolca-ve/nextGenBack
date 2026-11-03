export class CreateTournamentDto {
  nombre: string;
  categoria: string; // ej: 'SUB-12'
  formato_config?: Record<string, any>; // JSON con reglas opcionales
  fechaInicio?: string;
  fechaFin?: string;
  equiposIds: number[]; // IDs de los equipos inscritos (mínimo 4)
  duracionTiempoMinutos?: number; // por defecto 20
  duracionDescansoMinutos?: number; // por defecto 5
}