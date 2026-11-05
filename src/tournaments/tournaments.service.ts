// src/tournaments/tournaments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { renameSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DatabaseService } from '../database/database.service';
import { CreateTournamentDto } from './dto/create-tounament.dto';


@Injectable()
export class TournamentsService {
  constructor(private readonly db: DatabaseService) {}

async createTournament(dto: CreateTournamentDto, banner?: Express.Multer.File) {
  const { equiposIds, nombre, categoria, fechaInicio, fechaFin, formato_config, status } = dto;

  if (!equiposIds || equiposIds.length < 4) {
    throw new BadRequestException('Se requieren al menos 4 equipos para generar el torneo.');
  }

  const slug = this.createSlug(nombre);
  const bannerPath = banner ? this.renameTournamentBanner(banner, slug) : dto.banner || null;

  // 1. Guardar el torneo
  const insertTorneoSql = `
    INSERT INTO torneos (nombre, categoria, formato_config, status, fechaInicio, fechaFin, banner)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  const torneoResult: any = await this.db.query(insertTorneoSql, [
    nombre,
    categoria,
    JSON.stringify(formato_config || {}),
    status || 'PROGRAMADO',
    fechaInicio || null,
    fechaFin || null,
    bannerPath,
  ]);
  const idTorneo = torneoResult.insertId;

  // 2. Inscribir equipos al torneo
  for (const idEquipo of equiposIds) {
    await this.db.query(
      `INSERT INTO equiposTorneo (idTorneo, idEquipo) VALUES (?, ?)`,
      [idTorneo, idEquipo]
    );
  }

  // 3. Algoritmo Round-Robin para Fase de Grupos
  const matchesToInsert: Array<{
    ronda: number;
    local: number;
    visitante: number;
  }> = [];

  const teams = [...equiposIds];
  const hasGhost = teams.length % 2 !== 0;
  if (hasGhost) teams.push(-1); // "Bye" para cantidad impar de equipos

  const numTeams = teams.length;
  const totalRounds = numTeams - 1;
  const half = numTeams / 2;

  for (let round = 0; round < totalRounds; round++) {
    for (let i = 0; i < half; i++) {
      const teamA = teams[i];
      const teamB = teams[numTeams - 1 - i];

      if (teamA !== -1 && teamB !== -1) {
        // Alternar condición de local por jornada
        const local = round % 2 === 0 ? teamA : teamB;
        const visitante = round % 2 === 0 ? teamB : teamA;

        matchesToInsert.push({
          ronda: round + 1,
          local,
          visitante,
        });
      }
    }

    // Rotación del círculo manteniendo el primer equipo estático
    const firstTeam = teams[0];
    const restTeams = teams.slice(1);
    restTeams.unshift(restTeams.pop()!);
    teams.splice(0, teams.length, firstTeam, ...restTeams);
  }

    // 4. Parámetros de tiempo y duración
    const duracionTiempo = dto.duracionTiempoMinutos || 20;
    const duracionDescanso = dto.duracionDescansoMinutos || 5;
    // Ventana por partido: 2 tiempos + descanso + 15 min de calentamiento / entrega de cancha
    const duracionTotalPartidoMinutos = duracionTiempo * 2 + duracionDescanso + 15;
    const baseDate = dto.fechaInicio ? new Date(dto.fechaInicio) : new Date();
    const playoffDate = dto.fechaFin ? new Date(dto.fechaFin) : baseDate;
    const groupDays = Math.max(
      1,
      Math.ceil((playoffDate.getTime() - baseDate.getTime()) / 86400000),
    );

  // 5. Inserción de partidos de grupos con fechas escalonadas
  for (let idx = 0; idx < matchesToInsert.length; idx++) {
    const m = matchesToInsert[idx];
    const dayIndex = Math.min(m.ronda - 1, groupDays - 1);
    const matchesInRound = matchesToInsert.filter((match) => match.ronda === m.ronda);
    const matchIndex = matchesInRound.findIndex(
      (match) => match.local === m.local && match.visitante === m.visitante,
    );
    const matchDate = new Date(
      baseDate.getTime() +
        dayIndex * 86400000 +
        matchIndex * duracionTotalPartidoMinutos * 60000,
    );

    await this.db.query(
      `INSERT INTO Partidos (
        idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, 
        duracionTiempoMinutos, duracionDescansoMinutos, fecha, status
      ) VALUES (?, 'GRUPO', ?, ?, ?, ?, ?, ?, 'SCHEDULED')`,
      [
        idTorneo,
        m.ronda,
        m.local,
        m.visitante,
        duracionTiempo,
        duracionDescanso,
        matchDate,
      ]
    );
  }

  const fechaFinalEstimada = new Date(
    playoffDate.getTime(),
  );

  return {
    idTorneo,
    message: 'Torneo, inscripciones y partidos de fase de grupos generados con éxito.',
    partidosGruposGenerados: matchesToInsert.length,
    jornadas: totalRounds,
    fechaInicioTorneo: baseDate,
    fechaFinalEstimada,
    banner: bannerPath,
  };
}

  private createSlug(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'torneo';
  }

  private renameTournamentBanner(
    banner: Express.Multer.File,
    slug: string,
  ): string {
    const extension = extname(banner.originalname).toLowerCase();
    const filename = `${basename(slug)}${extension}`;
    const destination = join(process.cwd(), 'assets', 'torneos', filename);

    renameSync(banner.path, destination);
    return `/assets/torneos/${filename}`;
  }

  async getTournamentMatches(idTorneo: number) {
    await this.ensureTournamentExists(idTorneo);

    return this.db.query(
      `
        SELECT
          p.*,
          el.nombre AS nombreEquipoLocal,
          ev.nombre AS nombreEquipoVisitante
        FROM Partidos p
        LEFT JOIN equipos el ON el.idEquipo = p.idEquipoLocal
        LEFT JOIN equipos ev ON ev.idEquipo = p.idEquipoVisitante
        WHERE p.idTorneo = ?
        ORDER BY p.fecha ASC, p.idPartido ASC;
      `,
      [idTorneo],
    );
  }

  async getStandings(idTorneo: number) {
    const tournament: any = await this.ensureTournamentExists(idTorneo);
    const teams: any[] = await this.db.query(
      `
        SELECT et.idEquipo, e.nombre, e.siglas
        FROM equiposTorneo et
        INNER JOIN equipos e ON e.idEquipo = et.idEquipo
        WHERE et.idTorneo = ?;
      `,
      [idTorneo],
    );
    const matches: any[] = await this.db.query(
      `
        SELECT idEquipoLocal, idEquipoVisitante, marcadorLocal, marcadorVisitante
        FROM Partidos
        WHERE idTorneo = ?
          AND fase = 'GRUPO'
          AND marcadorLocal IS NOT NULL
          AND marcadorVisitante IS NOT NULL;
      `,
      [idTorneo],
    );

    const standings = new Map<number, any>();
    for (const team of teams) {
      standings.set(team.idEquipo, {
        posicion: 0,
        idEquipo: team.idEquipo,
        nombre: team.nombre,
        siglas: team.siglas,
        partidosJugados: 0,
        ganados: 0,
        empatados: 0,
        perdidos: 0,
        golesFavor: 0,
        golesContra: 0,
        diferenciaGoles: 0,
        puntos: 0,
      });
    }

    for (const match of matches) {
      const local = standings.get(match.idEquipoLocal);
      const visitante = standings.get(match.idEquipoVisitante);
      if (!local || !visitante) continue;

      const golesLocal = Number(match.marcadorLocal);
      const golesVisitante = Number(match.marcadorVisitante);
      local.partidosJugados++;
      visitante.partidosJugados++;
      local.golesFavor += golesLocal;
      local.golesContra += golesVisitante;
      visitante.golesFavor += golesVisitante;
      visitante.golesContra += golesLocal;

      if (golesLocal > golesVisitante) {
        local.ganados++;
        local.puntos += 3;
        visitante.perdidos++;
      } else if (golesLocal < golesVisitante) {
        visitante.ganados++;
        visitante.puntos += 3;
        local.perdidos++;
      } else {
        local.empatados++;
        visitante.empatados++;
        local.puntos++;
        visitante.puntos++;
      }
    }

    const criteria = this.getStandingsCriteria(tournament.formato_config);
    const rows = [...standings.values()].map((row) => ({
      ...row,
      diferenciaGoles: row.golesFavor - row.golesContra,
    }));

    rows.sort((a, b) => {
      for (const criterion of criteria) {
        const difference = Number(b[criterion] ?? 0) - Number(a[criterion] ?? 0);
        if (difference !== 0) return difference;
      }
      return a.nombre.localeCompare(b.nombre);
    });

    rows.forEach((row, index) => {
      row.posicion = index + 1;
    });

    return rows;
  }

  async generatePlayoffs(idTorneo: number) {
    const tournament: any = await this.ensureTournamentExists(idTorneo);
    const standings = await this.getStandings(idTorneo);
    const pendingGroups: any[] = await this.db.query(
      `
        SELECT idPartido
        FROM Partidos
        WHERE idTorneo = ? AND fase = 'GRUPO'
          AND (marcadorLocal IS NULL OR marcadorVisitante IS NULL);
      `,
      [idTorneo],
    );

    if (pendingGroups.length) {
      throw new BadRequestException(
        'No se pueden generar los playoffs hasta completar todos los partidos de grupos.',
      );
    }
    if (standings.length < 4) {
      throw new BadRequestException('Se requieren al menos 4 equipos clasificados.');
    }

    const existing: any[] = await this.db.query(
      `SELECT idPartido FROM Partidos WHERE idTorneo = ? AND fase IN ('SEMI_FINAL', 'TERCER_LUGAR', 'FINAL')`,
      [idTorneo],
    );
    if (existing.length) {
      return { message: 'Las fases finales ya fueron generadas.', partidos: existing };
    }

    const fechaFin = tournament.fechaFin || tournament.fechaInicio || new Date();
    const baseDate = new Date(fechaFin);
    const duracionTiempo = tournament.duracionTiempoMinutos || 20;
    const duracionDescanso = tournament.duracionDescansoMinutos || 5;
    const matchWindow = duracionTiempo * 2 + duracionDescanso + 15;
    const first = standings[0].idEquipo;
    const second = standings[1].idEquipo;
    const third = standings[2].idEquipo;
    const fourth = standings[3].idEquipo;

    await this.db.query(
      `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
       VALUES (?, 'SEMI_FINAL', ?, ?, ?, ?, ?, ?, 'SCHEDULED')`,
      [idTorneo, standings.length, first, fourth, duracionTiempo, duracionDescanso, baseDate],
    );
    await this.db.query(
      `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
       VALUES (?, 'SEMI_FINAL', ?, ?, ?, ?, ?, ?, 'SCHEDULED')`,
      [
        idTorneo,
        standings.length,
        second,
        third,
        duracionTiempo,
        duracionDescanso,
        new Date(baseDate.getTime() + matchWindow * 60000),
      ],
    );
    await this.db.query(
      `INSERT INTO Partidos (idTorneo, fase, numeroRonda, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
       VALUES (?, 'TERCER_LUGAR', ?, ?, ?, ?, 'PENDING')`,
      [
        idTorneo,
        standings.length + 1,
        duracionTiempo,
        duracionDescanso,
        new Date(baseDate.getTime() + matchWindow * 2 * 60000),
      ],
    );
    await this.db.query(
      `INSERT INTO Partidos (idTorneo, fase, numeroRonda, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
       VALUES (?, 'FINAL', ?, ?, ?, ?, 'PENDING')`,
      [
        idTorneo,
        standings.length + 2,
        duracionTiempo,
        duracionDescanso,
        new Date(baseDate.getTime() + (matchWindow * 2 + 30) * 60000),
      ],
    );

    return {
      message: 'Semifinales, partido por el tercer lugar y final generados.',
      clasificados: standings.slice(0, 4),
      partidos: await this.getTournamentMatches(idTorneo),
    };
  }

  async generateFinals(idTorneo: number) {
    await this.ensureTournamentExists(idTorneo);
    const semifinals: any[] = await this.db.query(
      `SELECT * FROM Partidos WHERE idTorneo = ? AND fase = 'SEMI_FINAL' ORDER BY idPartido`,
      [idTorneo],
    );
    if (semifinals.length !== 2 || semifinals.some((match) => match.ganador == null)) {
      throw new BadRequestException('Las dos semifinales deben tener ganador antes de generar las finales.');
    }

    const winners = semifinals.map((match) => Number(match.ganador));
    const losers = semifinals.map((match) =>
      Number(match.idEquipoLocal) === Number(match.ganador)
        ? Number(match.idEquipoVisitante)
        : Number(match.idEquipoLocal),
    );
    await this.db.query(
      `UPDATE Partidos SET idEquipoLocal = ?, idEquipoVisitante = ?, status = 'SCHEDULED'
       WHERE idTorneo = ? AND fase = 'FINAL'`,
      [winners[0], winners[1], idTorneo],
    );
    await this.db.query(
      `UPDATE Partidos SET idEquipoLocal = ?, idEquipoVisitante = ?, status = 'SCHEDULED'
       WHERE idTorneo = ? AND fase = 'TERCER_LUGAR'`,
      [losers[0], losers[1], idTorneo],
    );

    return {
      message: 'Final y partido por el tercer lugar actualizados con los clasificados.',
      partidos: await this.getTournamentMatches(idTorneo),
    };
  }

  private async ensureTournamentExists(idTorneo: number) {
    const tournaments: any[] = await this.db.query(
      `SELECT * FROM torneos WHERE idTorneo = ?`,
      [idTorneo],
    );
    if (!tournaments.length) {
      throw new BadRequestException(`No se encontró el torneo ${idTorneo}.`);
    }
    return tournaments[0];
  }

  private getStandingsCriteria(formatoConfig: any): string[] {
    let config = formatoConfig;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch {
        config = {};
      }
    }

    const configured = Array.isArray(config?.criterios)
      ? config.criterios
          .map((criterion: any) => (typeof criterion === 'string' ? criterion : criterion?.campo || criterion?.tipo))
          .map((criterion: string) => this.mapCriterion(criterion))
          .filter(Boolean)
      : [];

    return configured.length
      ? configured
      : ['puntos', 'diferenciaGoles', 'golesFavor', 'ganados'];
  }

  private mapCriterion(criterion: string): string {
    const normalized = criterion?.toLowerCase().replace(/[_\s-]/g, '');
    const aliases: Record<string, string> = {
      puntos: 'puntos',
      puntosobtenidos: 'puntos',
      diferenciadegoles: 'diferenciaGoles',
      diferencia: 'diferenciaGoles',
      golesfavor: 'golesFavor',
      golesafavor: 'golesFavor',
      victorias: 'ganados',
      ganados: 'ganados',
    };
    return aliases[normalized] || '';
  }

  /**
   * Actualiza los datos y la configuración de un torneo.
   * Reemplaza la lista de equipos inscritos.
   * Los partidos ya generados NO se tocan para no perder resultados.
   */
  async updateTournament(
    idTorneo: number,
    dto: CreateTournamentDto,
    banner?: Express.Multer.File,
  ) {
    const { equiposIds, nombre, categoria, fechaInicio, fechaFin, formato_config, status } = dto;

    const existentes: any[] = await this.db.query(
      `SELECT idTorneo, banner FROM torneos WHERE idTorneo = ?`,
      [idTorneo],
    );

    if (!existentes.length) {
      throw new BadRequestException('No se encontró el torneo a actualizar.');
    }

    if (!equiposIds || equiposIds.length < 4) {
      throw new BadRequestException('Se requieren al menos 4 equipos para generar el torneo.');
    }

    const slug = this.createSlug(nombre);
    const currentBanner = existentes[0].banner;
    const bannerPath = banner
      ? this.renameTournamentBanner(banner, slug)
      : dto.banner !== undefined
        ? dto.banner
        : currentBanner;

    await this.db.query(
      `UPDATE torneos SET nombre = ?, categoria = ?, formato_config = ?, status = ?, fechaInicio = ?, fechaFin = ?, banner = ? WHERE idTorneo = ?`,
      [
        nombre,
        categoria,
        JSON.stringify(formato_config || {}),
        status || 'PROGRAMADO',
        fechaInicio || null,
        fechaFin || null,
        bannerPath,
        idTorneo,
      ],
    );

    if (banner && currentBanner && currentBanner !== bannerPath) {
      unlinkSync(join(process.cwd(), currentBanner.replace(/^\//, '')));
    }

    // Reemplazar los equipos inscritos
    await this.db.query(`DELETE FROM equiposTorneo WHERE idTorneo = ?`, [idTorneo]);

    for (const idEquipo of equiposIds) {
      await this.db.query(
        `INSERT INTO equiposTorneo (idTorneo, idEquipo) VALUES (?, ?)`,
        [idTorneo, idEquipo],
      );
    }

    return {
      idTorneo,
      message: 'Torneo actualizado con éxito.',
      equiposInscritos: equiposIds.length,
      banner: bannerPath,
    };
  }

    async getAllTournaments(){
        const sql = `
            SELECT 
            t.idTorneo,
            t.nombre,
            t.categoria,
            t.status,
            t.fechaInicio,
            t.fechaFin,
            t.banner,
            t.formato_config,
            COUNT(DISTINCT et.idEquipo) AS totalEquipos,
            COUNT(DISTINCT p.idPartido) AS totalPartidos
            FROM torneos t
            LEFT JOIN equiposTorneo et ON et.idTorneo = t.idTorneo
            LEFT JOIN Partidos p ON p.idTorneo = t.idTorneo
            GROUP BY t.idTorneo
            ORDER BY t.fechaInicio DESC, t.idTorneo DESC;
        `;
        return this.db.query(sql);
    }

    async getTournamentTeams(idTorneo: number) {
        const sql = `
            SELECT et.idEquipo, e.nombre, e.siglas, e.categoria
            FROM equiposTorneo et
            LEFT JOIN equipos e ON e.idEquipo = et.idEquipo
            WHERE et.idTorneo = ?
            ORDER BY e.nombre;
        `;
        return this.db.query(sql, [idTorneo]);
    }

    async getNearestTournament(){
        const sql = `
        SELECT 
        t.idTorneo,
        t.nombre,
        t.categoria,
        t.status,
        t.fechaInicio,
        t.fechaFin,
        t.banner,
        t.formato_config,
        COUNT(DISTINCT et.idEquipo) AS totalEquipos,
        COUNT(DISTINCT p.idPartido) AS totalPartidos
        FROM torneos t
        LEFT JOIN equiposTorneo et ON et.idTorneo = t.idTorneo
        LEFT JOIN Partidos p ON p.idTorneo = t.idTorneo
        GROUP BY t.idTorneo
        ORDER BY 
        CASE 
            WHEN t.status = 'EN_CURSO' THEN 1
            WHEN t.status = 'PROGRAMADO' AND t.fechaInicio >= CURDATE() THEN 2
            ELSE 3
        END ASC,
        t.fechaInicio ASC,
        t.idTorneo DESC
        LIMIT 1;
        `;

        const results = await this.db.query(sql);
        return results.length > 0 ? results[0] : null;
    } 
}