import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TournamentsService } from '../tournaments/tournaments.service';
import {
  CreateMatchAlignmentDto,
  CreateGoalDto,
  CreateSubstitutionDto,
  MatchAlignmentUpdateDto,
  MatchUpdateDto,
  UpdateGoalDto,
  UpdateSubstitutionDto,
} from './dto/matches.dto';

@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly tournamentsService: TournamentsService,
  ) {}

  async getAllMatches() {
    return this.db.query(`
      SELECT
        p.idPartido,
        p.fase,
        p.numeroRonda,
        p.marcadorLocal,
        p.marcadorVisitante,
        p.marcadorPenalesLocal,
        p.marcadorPenalesVisitante,
        p.duracionTiempoMinutos,
        p.duracionDescansoMinutos,
        p.tieneTiempoExtra,
        p.duracionExtraMinutos,
        p.tieneTandaPenales,
        p.status,
        p.ganador,
        DATE_FORMAT(CONVERT_TZ(p.fecha, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS fecha,
        p.direccion,
        p.idTorneo,
        p.idEquipoLocal,
        p.idEquipoVisitante,
        p.idArbitro,
        DATE_FORMAT(CONVERT_TZ(p.creadoEl, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS creadoEl,
        DATE_FORMAT(CONVERT_TZ(t.fechaInicio, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS fechaInicioTorneo,
        DATE_FORMAT(CONVERT_TZ(t.fechaFin, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS fechaFinTorneo,
        t.nombre AS nombreTorneo,
        t.categoria,
        el.nombre AS nombreEquipoLocal,
        ev.nombre AS nombreEquipoVisitante
      FROM Partidos p
      LEFT JOIN torneos t ON t.idTorneo = p.idTorneo
      LEFT JOIN equipos el ON el.idEquipo = p.idEquipoLocal
      LEFT JOIN equipos ev ON ev.idEquipo = p.idEquipoVisitante
      ORDER BY p.fecha ASC, p.idPartido ASC;
    `);
  }

  async getMatch(idPartido: number) {
    const matches: any[] = await this.db.query(
      `
        SELECT
          p.idPartido,
          p.fase,
          p.numeroRonda,
          p.marcadorLocal,
          p.marcadorVisitante,
          p.marcadorPenalesLocal,
          p.marcadorPenalesVisitante,
          p.duracionTiempoMinutos,
          p.duracionDescansoMinutos,
          p.tieneTiempoExtra,
          p.duracionExtraMinutos,
          p.tieneTandaPenales,
          p.status,
          p.ganador,
          DATE_FORMAT(CONVERT_TZ(p.fecha, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS fecha,
          p.direccion,
          p.idTorneo,
          p.idEquipoLocal,
          p.idEquipoVisitante,
          p.idArbitro,
          DATE_FORMAT(CONVERT_TZ(p.creadoEl, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS creadoEl,
          DATE_FORMAT(CONVERT_TZ(t.fechaInicio, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS fechaInicioTorneo,
          DATE_FORMAT(CONVERT_TZ(t.fechaFin, '+00:00', '-04:00'), '%Y-%m-%d %H:%i:%s') AS fechaFinTorneo,
          t.nombre AS nombreTorneo,
          t.categoria,
          el.nombre AS nombreEquipoLocal,
          ev.nombre AS nombreEquipoVisitante
        FROM Partidos p
        LEFT JOIN torneos t ON t.idTorneo = p.idTorneo
        LEFT JOIN equipos el ON el.idEquipo = p.idEquipoLocal
        LEFT JOIN equipos ev ON ev.idEquipo = p.idEquipoVisitante
        WHERE p.idPartido = ?;
      `,
      [idPartido],
    );

    if (!matches.length) {
      throw new NotFoundException(`Partido con ID ${idPartido} no encontrado`);
    }

    return matches[0];
  }

  async getAlignments(idPartido: number) {
    await this.getMatch(idPartido);

    return this.db.query(
      `
        SELECT
          ap.*,
          e.nombre AS nombreEquipo,
          j.nombre,
          j.apellido,
          j.foto
        FROM alineacionespartido ap
        LEFT JOIN equipos e ON e.idEquipo = ap.idEquipo
        LEFT JOIN jugadores j ON j.idJugador = ap.idJugador
        WHERE ap.idPartido = ?
        ORDER BY ap.idEquipo ASC, ap.numeroCamiseta ASC, j.apellido ASC;
      `,
      [idPartido],
    );
  }

  async createAlignment(idPartido: number, dto: CreateMatchAlignmentDto) {
    if (dto.idPartido !== undefined && dto.idPartido !== idPartido) {
      throw new BadRequestException(
        'El idPartido del body no coincide con el idPartido de la URL.',
      );
    }

    await this.getMatch(idPartido);

    const result: any = await this.db.query(
      `
        INSERT INTO alineacionespartido (
          esTitular, esCapitan, numeroCamiseta, posicion,
          idPartido, idEquipo, idJugador
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        dto.esTitular,
        dto.esCapitan,
        dto.numeroCamiseta,
        dto.posicion ?? null,
        idPartido,
        dto.idEquipo,
        dto.idJugador,
      ],
    );

    return {
      idAlineacionPartido: result.insertId,
      idPartido,
      message: 'Alineación creada con éxito',
    };
  }

  async getGoals(idPartido: number) {
    await this.getMatch(idPartido);

    return this.db.query(
      `
        SELECT
          g.*,
          j.nombre AS nombreJugador,
          j.apellido AS apellidoJugador,
          a.nombre AS nombreJugadorAsistencia,
          a.apellido AS apellidoJugadorAsistencia,
          e.nombre AS nombreEquipo
        FROM goles g
        LEFT JOIN jugadores j ON j.idJugador = g.idJugador
        LEFT JOIN jugadores a ON a.idJugador = g.idJugadorAsistencia
        LEFT JOIN equipos e ON e.idEquipo = g.idEquipo
        WHERE g.idPartido = ?
        ORDER BY g.minuto IS NULL, g.minuto ASC, g.idGol ASC;
      `,
      [idPartido],
    );
  }

  async getGoal(idPartido: number, idGol: number) {
    await this.getMatch(idPartido);
    const goals: any[] = await this.db.query(
      `SELECT * FROM goles WHERE idGol = ? AND idPartido = ?`,
      [idGol, idPartido],
    );

    if (!goals.length) {
      throw new NotFoundException(`Gol con ID ${idGol} no encontrado en el partido ${idPartido}`);
    }

    return goals[0];
  }

  async createGoal(idPartido: number, dto: CreateGoalDto) {
    await this.getMatch(idPartido);

    const result: any = await this.db.query(
      `
        INSERT INTO goles (
          minuto, esAutogol, idPartido, idJugador, idJugadorAsistencia, idEquipo
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        dto.minuto ?? null,
        dto.esAutogol,
        idPartido,
        dto.idJugador,
        dto.idJugadorAsistencia ?? null,
        dto.idEquipo,
      ],
    );

    return {
      idGol: result.insertId,
      idPartido,
      message: 'Gol registrado con éxito',
    };
  }

  async updateGoal(idPartido: number, idGol: number, dto: UpdateGoalDto) {
    await this.getGoal(idPartido, idGol);

    const fields: string[] = [];
    const values: any[] = [];
    const allowedFields = [
      'minuto',
      'esAutogol',
      'idJugador',
      'idJugadorAsistencia',
      'idEquipo',
    ];

    for (const field of allowedFields) {
      if ((dto as any)[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push((dto as any)[field]);
      }
    }

    if (!fields.length) {
      return { message: 'No hay cambios para actualizar' };
    }

    await this.db.query(
      `UPDATE goles SET ${fields.join(', ')} WHERE idGol = ? AND idPartido = ?`,
      [...values, idGol, idPartido],
    );

    return { message: 'Gol actualizado con éxito' };
  }

  async deleteGoal(idPartido: number, idGol: number) {
    await this.getGoal(idPartido, idGol);
    await this.db.query(
      `DELETE FROM goles WHERE idGol = ? AND idPartido = ?`,
      [idGol, idPartido],
    );

    return { message: 'Gol eliminado con éxito' };
  }

  async getSubstitutions(idPartido: number) {
    await this.getMatch(idPartido);

    return this.db.query(
      `
        SELECT
          s.*,
          e.nombre AS nombreEquipo,
          js.nombre AS nombreJugadorSale,
          js.apellido AS apellidoJugadorSale,
          je.nombre AS nombreJugadorEntra,
          je.apellido AS apellidoJugadorEntra
        FROM sustitucionespartido s
        LEFT JOIN equipos e ON e.idEquipo = s.idEquipo
        LEFT JOIN jugadores js ON js.idJugador = s.idJugadorSale
        LEFT JOIN jugadores je ON je.idJugador = s.idJugadorEntra
        WHERE s.idPartido = ?
        ORDER BY s.minuto IS NULL, s.minuto ASC, s.idSustitucionPartido ASC;
      `,
      [idPartido],
    );
  }

  async getSubstitution(idPartido: number, idSustitucionPartido: number) {
    await this.getMatch(idPartido);
    const substitutions: any[] = await this.db.query(
      `SELECT * FROM sustitucionespartido WHERE idSustitucionPartido = ? AND idPartido = ?`,
      [idSustitucionPartido, idPartido],
    );

    if (!substitutions.length) {
      throw new NotFoundException(
        `Sustitución con ID ${idSustitucionPartido} no encontrada en el partido ${idPartido}`,
      );
    }

    return substitutions[0];
  }

  async createSubstitution(idPartido: number, dto: CreateSubstitutionDto) {
    await this.getMatch(idPartido);

    const result: any = await this.db.query(
      `
        INSERT INTO sustitucionespartido (
          minuto, periodo, idPartido, idEquipo, idJugadorSale, idJugadorEntra
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        dto.minuto ?? null,
        dto.periodo,
        idPartido,
        dto.idEquipo,
        dto.idJugadorSale,
        dto.idJugadorEntra,
      ],
    );

    return {
      idSustitucionPartido: result.insertId,
      idPartido,
      message: 'Sustitución registrada con éxito',
    };
  }

  async updateSubstitution(
    idPartido: number,
    idSustitucionPartido: number,
    dto: UpdateSubstitutionDto,
  ) {
    await this.getSubstitution(idPartido, idSustitucionPartido);

    const fields: string[] = [];
    const values: any[] = [];
    const allowedFields = [
      'minuto',
      'periodo',
      'idEquipo',
      'idJugadorSale',
      'idJugadorEntra',
    ];

    for (const field of allowedFields) {
      if ((dto as any)[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push((dto as any)[field]);
      }
    }

    if (!fields.length) {
      return { message: 'No hay cambios para actualizar' };
    }

    await this.db.query(
      `UPDATE sustitucionespartido SET ${fields.join(', ')} WHERE idSustitucionPartido = ? AND idPartido = ?`,
      [...values, idSustitucionPartido, idPartido],
    );

    return { message: 'Sustitución actualizada con éxito' };
  }

  async deleteSubstitution(idPartido: number, idSustitucionPartido: number) {
    await this.getSubstitution(idPartido, idSustitucionPartido);
    await this.db.query(
      `DELETE FROM sustitucionespartido WHERE idSustitucionPartido = ? AND idPartido = ?`,
      [idSustitucionPartido, idPartido],
    );

    return { message: 'Sustitución eliminada con éxito' };
  }

  async updateMatch(idPartido: number, dto: MatchUpdateDto) {
    const match = await this.getMatch(idPartido);

    const fields: string[] = [];
    const values: any[] = [];
    const allowedFields = [
      'fase',
      'numeroRonda',
      'marcadorLocal',
      'marcadorVisitante',
      'marcadorPenalesLocal',
      'marcadorPenalesVisitante',
      'duracionTiempoMinutos',
      'duracionDescansoMinutos',
      'tieneTiempoExtra',
      'duracionExtraMinutos',
      'tieneTandaPenales',
      'status',
      'ganador',
      'fecha',
      'direccion',
      'idEquipoLocal',
      'idEquipoVisitante',
      'idArbitro',
    ];

    for (const field of allowedFields) {
      if ((dto as any)[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push((dto as any)[field]);
      }
    }

    if (!fields.length) {
      return { message: 'No hay cambios para actualizar' };
    }

    await this.db.query(
      `UPDATE Partidos SET ${fields.join(', ')} WHERE idPartido = ?`,
      [...values, idPartido],
    );

    // Con cada resultado de la fase de grupos se reacomoda la fase
    // definitoria (final 1° vs 2° y tercer lugar 3° vs 4°)
    if (match.idTorneo && fields.some((field) => ['marcadorLocal', 'marcadorVisitante', 'status', 'fase'].includes(field))) {
      try {
        await this.tournamentsService.refreshDefinitoria(Number(match.idTorneo));
      } catch (error) {
        // El partido ya quedó guardado; la fase definitoria se reacomoda en el
        // próximo guardado. Se registra el error para no perder el motivo.
        this.logger.error(
          `No se pudo refrescar la fase definitoria del torneo ${match.idTorneo}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { message: 'Partido actualizado con éxito' };
  }

  async updateAlignments(
    idPartido: number,
    alignments: MatchAlignmentUpdateDto[],
  ) {
    await this.getMatch(idPartido);

    for (const alignment of alignments) {
      const fields: string[] = [];
      const values: any[] = [];
      const allowedFields = [
        'esTitular',
        'esCapitan',
        'numeroCamiseta',
        'posicion',
      ];

      for (const field of allowedFields) {
        if ((alignment as any)[field] !== undefined) {
          fields.push(`${field} = ?`);
          values.push((alignment as any)[field]);
        }
      }

      if (fields.length) {
        await this.db.query(
          `UPDATE alineacionespartido SET ${fields.join(', ')} WHERE idAlineacionPartido = ? AND idPartido = ?`,
          [...values, alignment.idAlineacionPartido, idPartido],
        );
      }
    }

    return { message: 'Alineaciones actualizadas con éxito' };
  }
}