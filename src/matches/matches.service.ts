import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { TournamentsService } from '../tournaments/tournaments.service';
import {
  CreateCardDto,
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
  constructor(
    private readonly db: DatabaseService,
    private readonly tournamentsService: TournamentsService,
    private readonly storage: StorageService,
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
        -- Las fechas se guardan y se leen como hora local "de pared" (sin CONVERT_TZ):
        -- convierte mal según la zona horaria del servidor y "movía" los partidos.
        p.fecha,
        p.direccion,
        p.idTorneo,
        p.idEquipoLocal,
        p.idEquipoVisitante,
        p.idArbitro,
        p.creadoEl,
        t.fechaInicio AS fechaInicioTorneo,
        t.fechaFin AS fechaFinTorneo,
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
          p.fecha,
          p.direccion,
          p.idTorneo,
          p.idEquipoLocal,
          p.idEquipoVisitante,
          p.idArbitro,
          p.creadoEl,
          t.fechaInicio AS fechaInicioTorneo,
          t.fechaFin AS fechaFinTorneo,
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

    const alignments = await this.db.query(
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
    return alignments.map((alignment) => this.storage.withUrls(alignment, 'foto'));
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

  async getCards(idPartido: number) {
    await this.getMatch(idPartido);

    return this.db.query(
      `
        SELECT
          t.idTarjeta,
          t.color AS tipo,
          t.minuto,
          t.motivo AS descripcion,
          t.idEquipo,
          t.idJugador,
          j.nombre AS nombreJugador,
          j.apellido AS apellidoJugador
        FROM tarjetas t
        LEFT JOIN jugadores j ON j.idJugador = t.idJugador
        WHERE t.idPartido = ?
        ORDER BY t.minuto IS NULL, t.minuto ASC, t.idTarjeta ASC;
      `,
      [idPartido],
    );
  }

  async createCard(idPartido: number, dto: CreateCardDto) {
    const tipo = dto.tipo.trim().toLowerCase();
    const color = ['red', 'roja'].includes(tipo) ? 'roja' : ['yellow', 'amarilla'].includes(tipo) ? 'amarilla' : null;
    if (!color) {
      throw new BadRequestException('La tarjeta debe ser amarilla o roja.');
    }

    const result: any = await this.db.query(
      `INSERT INTO tarjetas (color, minuto, motivo, idPartido, idJugador, idEquipo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [color, dto.minuto ?? null, dto.descripcion?.trim() || null, idPartido, dto.idJugador, dto.idEquipo],
    );

    return { idTarjeta: result.insertId, idPartido, message: 'Tarjeta registrada con éxito' };
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

  /**
   * Normaliza la fecha de un partido a 'YYYY-MM-DD HH:MM:SS' sin pisar la hora:
   * - 'YYYY-MM-DD'  → conserva la hora ya guardada en el partido.
   * - 'YYYY-MM-DDTHH:mm[:SS]' → se usa tal cual (T → espacio, con segundos).
   */
  private normalizeFecha(nueva: string, actual?: string | null): string {
    const value = String(nueva).trim();

    const soloFecha = value.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (soloFecha) {
      const hora = String(actual ?? '').match(/\b(\d{2}:\d{2}:\d{2})\b/);
      return `${soloFecha[1]} ${hora ? hora[1] : '00:00:00'}`;
    }

    const completo = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
    if (completo) {
      return `${completo[1]} ${completo[2]}:${completo[3] ?? '00'}`;
    }

    // Cualquier otro formato aceptado por el DTO se guarda tal cual.
    return value;
  }

  /**
   * Guarda los cambios de un partido en una transacción: equipos, registros,
   * resultado y la fase definitoria se guardan juntos o no se guarda nada.
   */
  async updateMatch(idPartido: number, dto: MatchUpdateDto) {
    return this.db.transaction(() => this.applyMatchUpdate(idPartido, dto));
  }

  private async applyMatchUpdate(idPartido: number, dto: MatchUpdateDto) {
    const match = await this.getMatch(idPartido);

    // Cambio de equipos (reemplazo de última hora): los dos lados deben ser
    // equipos distintos e inscritos en el torneo, y los registros del equipo
    // reemplazado (alineaciones, goles y cambios) quedan sin sentido.
    const viejoLocal = Number(match.idEquipoLocal ?? 0);
    const viejoVisitante = Number(match.idEquipoVisitante ?? 0);
    const nuevoLocal = dto.idEquipoLocal != null ? Number(dto.idEquipoLocal) : viejoLocal;
    const nuevoVisitante =
      dto.idEquipoVisitante != null ? Number(dto.idEquipoVisitante) : viejoVisitante;
    const cambiaLocal = nuevoLocal !== viejoLocal;
    const cambiaVisitante = nuevoVisitante !== viejoVisitante;

    if (cambiaLocal || cambiaVisitante) {
      if (!(nuevoLocal > 0) || !(nuevoVisitante > 0)) {
        throw new BadRequestException('Debes indicar los dos equipos del partido.');
      }
      if (nuevoLocal === nuevoVisitante) {
        throw new BadRequestException('El equipo local y el visitante no pueden ser el mismo.');
      }

      const cambiados = [cambiaLocal ? nuevoLocal : null, cambiaVisitante ? nuevoVisitante : null].filter(
        (id): id is number => id != null,
      );

      if (Number(match.idTorneo)) {
        const inscritos: any[] = await this.db.query(
          `SELECT idEquipo FROM equiposTorneo WHERE idTorneo = ?`,
          [match.idTorneo],
        );
        const inscritosIds = new Set(inscritos.map((fila) => Number(fila.idEquipo)));

        // Solo se exige inscripción si el torneo tiene equipos anotados
        // (datos heredados sin inscripciones no quedan bloqueados).
        if (inscritosIds.size) {
          for (const idEquipo of cambiados) {
            if (!inscritosIds.has(idEquipo)) {
              const equipos: any[] = await this.db.query(
                `SELECT nombre FROM equipos WHERE idEquipo = ?`,
                [idEquipo],
              );
              throw new BadRequestException(
                `El equipo "${equipos[0]?.nombre ?? idEquipo}" no está inscrito en este torneo.`,
              );
            }
          }
        }
      }

      // Equipos que dejan de jugar este partido: sus registros se borran aquí
      // (si el equipo sigue en el otro lado del fixture, no se tocan).
      const reemplazados = [
        cambiaLocal && viejoLocal !== nuevoVisitante ? viejoLocal : null,
        cambiaVisitante && viejoVisitante !== nuevoLocal ? viejoVisitante : null,
      ].filter((id): id is number => id != null && id > 0);

      for (const idEquipo of reemplazados) {
        await this.db.query(
          `DELETE FROM alineacionespartido WHERE idPartido = ? AND idEquipo = ?`,
          [idPartido, idEquipo],
        );
        await this.db.query(`DELETE FROM goles WHERE idPartido = ? AND idEquipo = ?`, [
          idPartido,
          idEquipo,
        ]);
        await this.db.query(
          `DELETE FROM sustitucionespartido WHERE idPartido = ? AND idEquipo = ?`,
          [idPartido, idEquipo],
        );
        await this.db.query(`DELETE FROM tarjetas WHERE idPartido = ? AND idEquipo = ?`, [
          idPartido,
          idEquipo,
        ]);
      }
    }

    // Los registros nuevos deben ser de alguno de los dos equipos del partido
    const equiposDelPartido = new Set([nuevoLocal, nuevoVisitante]);
    const registros = [
      ...(dto.nuevasAlineaciones ?? []),
      ...(dto.goles ?? []),
      ...(dto.sustituciones ?? []),
      ...(dto.tarjetas ?? []),
    ];
    if (registros.some((registro) => !equiposDelPartido.has(Number(registro.idEquipo)))) {
      throw new BadRequestException(
        'Hay goles, tarjetas, cambios o alineaciones de un equipo que no juega este partido.',
      );
    }
    const hayRegistros = registros.length > 0 || (dto.alineaciones?.length ?? 0) > 0;

    const fields: string[] = [];
    // Nombres "crudos" de los campos actualizados (sin '= ?'): se usan para
    // decidir si hay que refrescar la fase definitoria
    const updatedFields: string[] = [];
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
        updatedFields.push(field);
        values.push(
          field === 'fecha' && dto.fecha != null
            ? // Si solo llega 'YYYY-MM-DD' (input date) se conserva la hora que
              // ya tenía el partido; nunca se guarda a las 00:00 "moviendo" el día.
              this.normalizeFecha(dto.fecha, match.fecha)
            : (dto as any)[field],
        );
      }
    }

    if (!fields.length && !hayRegistros) {
      return { message: 'No hay cambios para actualizar' };
    }

    if (fields.length) {
      await this.db.query(
        `UPDATE Partidos SET ${fields.join(', ')} WHERE idPartido = ?`,
        [...values, idPartido],
      );
    }

    // Alineaciones, goles, cambios y tarjetas: después del cambio de equipos,
    // en orden y dentro de la misma transacción
    if (dto.alineaciones?.length) await this.updateAlignments(idPartido, dto.alineaciones);
    for (const alineacion of dto.nuevasAlineaciones ?? []) await this.createAlignment(idPartido, alineacion);
    for (const gol of dto.goles ?? []) await this.createGoal(idPartido, gol);
    for (const cambio of dto.sustituciones ?? []) await this.createSubstitution(idPartido, cambio);
    for (const tarjeta of dto.tarjetas ?? []) await this.createCard(idPartido, tarjeta);

    // Con cada resultado de la fase de grupos se reacomoda la fase
    // definitoria (final 1° vs 2° y tercer lugar 3° vs 4°); también si cambian
    // los equipos, porque la tabla y los cruces dependen de ellos.
    // Va en la misma transacción: si falla, el partido tampoco se guarda
    if (match.idTorneo && updatedFields.some((field) => ['marcadorLocal', 'marcadorVisitante', 'status', 'fase', 'idEquipoLocal', 'idEquipoVisitante'].includes(field))) {
      await this.tournamentsService.refreshDefinitoria(Number(match.idTorneo));
    }

    return { message: 'Partido actualizado con éxito' };
  }

  /**
   * Elimina un partido junto con sus registros dependientes (goles, cambios y
   * alineaciones), en ese orden para no chocar con las llaves foráneas.
   * Si era de fase de grupos se reacomoda la fase definitoria, porque la tabla
   * de posiciones cambia sin ese resultado.
   */
  async deleteMatch(idPartido: number) {
    return this.db.transaction(() => this.applyMatchDelete(idPartido));
  }

  private async applyMatchDelete(idPartido: number) {
    const match = await this.getMatch(idPartido);

    await this.db.query(`DELETE FROM goles WHERE idPartido = ?`, [idPartido]);
    await this.db.query(`DELETE FROM tarjetas WHERE idPartido = ?`, [idPartido]);
    await this.db.query(`DELETE FROM sustitucionespartido WHERE idPartido = ?`, [idPartido]);
    await this.db.query(`DELETE FROM alineacionespartido WHERE idPartido = ?`, [idPartido]);
    await this.db.query(`DELETE FROM Partidos WHERE idPartido = ?`, [idPartido]);

    if (match.idTorneo && match.fase === 'GRUPO') {
      await this.tournamentsService.refreshDefinitoria(Number(match.idTorneo));
    }

    return { idPartido, message: 'Partido eliminado con éxito' };
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