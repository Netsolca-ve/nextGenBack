// src/tournaments/tournaments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { renameSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DatabaseService } from '../database/database.service';
import { CreateTournamentDto } from './dto/create-tounament.dto';

/** Minutos de diferencia entre el inicio de un partido y el siguiente. */
const ESPACIO_ENTRE_PARTIDOS_MINUTOS = 40;

/** Banner por defecto cuando el torneo no tiene uno propio. */
const DEFAULT_EVENT_BANNER = '/images/bannerEvento.jpg';

/** Imagen de los torneos aún no anunciados (estado PROXIMAMENTE). */
const PROXIMAMENTE_BANNER = '/images/proximamente.webp';


@Injectable()
export class TournamentsService {
  constructor(private readonly db: DatabaseService) {}

async createTournament(dto: CreateTournamentDto, banner?: Express.Multer.File) {
  const { equiposIds, nombre, categoria, fechaInicio, fechaFin, formato_config, status } = dto;

  // Un torneo "Próximamente" se crea vacío: sin equipos y sin calendario.
  // El resto necesita al menos 4 equipos para generar la fase de grupos.
  const sinEquipos = !equiposIds || equiposIds.length === 0;
  if (!sinEquipos && equiposIds.length < 4) {
    throw new BadRequestException('Se requieren al menos 4 equipos para generar el torneo.');
  }

  const slug = this.createSlug(nombre);
  // La columna banner no admite NULL: sin banner propio se usa la imagen
  // por defecto (la de "Próximamente" cuando el estado lo indica).
  const bannerPath = banner
    ? this.renameTournamentBanner(banner, slug)
    : dto.banner || (status === 'PROXIMAMENTE' ? PROXIMAMENTE_BANNER : DEFAULT_EVENT_BANNER);

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

    // 4. Parámetros de tiempo, duración y calendario de partidos
    const config = this.parseFormatoConfig(formato_config);
    const duracionTiempo = dto.duracionTiempoMinutos || 20;
    const duracionDescanso = dto.duracionDescansoMinutos || 5;
    // Cada partido se programa con 40 min de diferencia respecto al anterior
    const duracionTotalPartidoMinutos = ESPACIO_ENTRE_PARTIDOS_MINUTOS;
    const baseDate = this.parseDateOnly(dto.fechaInicio) ?? new Date();
    const playoffDate = this.parseDateOnly(dto.fechaFin) ?? baseDate;
    // Los días del "Calendario de partidos" (diasJuego): los grupos usan todos
    // salvo el último, que queda reservado para la final y el tercer lugar
    const diasGrupos = this.groupDays(config, baseDate, playoffDate);
    const diaDefinitoria = this.definitoriaDay(config, playoffDate);
    const horaInicio = this.parseHoraInicio(config);

    // 5. Inserción de partidos de grupos en los días del calendario
    const slotsPorDia = new Map<number, number>();

    for (const m of matchesToInsert) {
      const dayIndex = Math.min(m.ronda - 1, diasGrupos.length - 1);
      const slot = slotsPorDia.get(dayIndex) ?? 0;
      slotsPorDia.set(dayIndex, slot + 1);
      const matchDate = new Date(
        diasGrupos[dayIndex].getTime() + (horaInicio + slot * duracionTotalPartidoMinutos) * 60000,
      );

      await this.db.query(
        `INSERT INTO Partidos (
          idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, 
          duracionTiempoMinutos, duracionDescansoMinutos, fecha, status
        ) VALUES (?, 'GRUPO', ?, ?, ?, ?, ?, ?, 'programado')`,
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

    // 6. Registros de la fase definitoria (sin semifinales):
    //    FINAL = 1° vs 2° y TERCER_LUGAR = 3° vs 4°. Se crean vacíos y
    //    refreshDefinitoria() va acomodando los equipos según los resultados.
    //    Se juegan en el último día del calendario de partidos.
    let partidosDefinitoria = 0;

    if (config.tipoTorneo !== 'ROUND_ROBIN') {
      const rondaBase = totalRounds;
      const ultimoDiaGrupos = diasGrupos[diasGrupos.length - 1];
      const mismoDia = this.isSameDay(diaDefinitoria, ultimoDiaGrupos);
      const slotBase = mismoDia ? (slotsPorDia.get(diasGrupos.length - 1) ?? 0) : 0;
      const fechaTercerLugar = new Date(
        diaDefinitoria.getTime() + (horaInicio + slotBase * duracionTotalPartidoMinutos) * 60000,
      );
      const fechaFinal = new Date(
        diaDefinitoria.getTime() + (horaInicio + (slotBase + 1) * duracionTotalPartidoMinutos) * 60000,
      );

      await this.db.query(
        `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
         VALUES (?, 'TERCER_LUGAR', ?, NULL, NULL, ?, ?, ?, 'programado')`,
        [idTorneo, rondaBase + 1, duracionTiempo, duracionDescanso, fechaTercerLugar],
      );
      await this.db.query(
        `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
         VALUES (?, 'FINAL', ?, NULL, NULL, ?, ?, ?, 'programado')`,
        [idTorneo, rondaBase + 2, duracionTiempo, duracionDescanso, fechaFinal],
      );
      partidosDefinitoria = 2;
    }

    const fechaFinalEstimada = new Date(diaDefinitoria.getTime());

  return {
    idTorneo,
    message: 'Torneo, inscripciones y partidos de fase de grupos generados con éxito.',
    partidosGruposGenerados: matchesToInsert.length,
    partidosDefinitoria,
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
          COALESCE(NULLIF(TRIM(el.categoria), ''), NULLIF(TRIM(ev.categoria), '')) AS categoria,
          el.categoria AS categoriaEquipoLocal,
          ev.categoria AS categoriaEquipoVisitante,
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
    const config = this.parseFormatoConfig(tournament.formato_config);
    const puntuacion = config.fases?.fase1?.puntuacion ?? { victoria: 3, empate: 1, derrota: 0 };
    const puntosVictoria = Number(puntuacion.victoria) || 3;
    const puntosEmpate = Number.isFinite(Number(puntuacion.empate)) ? Number(puntuacion.empate) : 1;
    const puntosDerrota = Number.isFinite(Number(puntuacion.derrota)) ? Number(puntuacion.derrota) : 0;
    const teams: any[] = await this.db.query(
      `
        SELECT et.idEquipo, e.nombre, e.siglas, e.categoria
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
        categoria: team.categoria,
        partidosJugados: 0,
        ganados: 0,
        empatados: 0,
        perdidos: 0,
        golesFavor: 0,
        golesContra: 0,
        diferenciaGoles: 0,
        vallasInvictas: 0,
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

      // Vallas invictas: partidos sin recibir goles
      if (golesVisitante === 0) local.vallasInvictas++;
      if (golesLocal === 0) visitante.vallasInvictas++;

      if (golesLocal > golesVisitante) {
        local.ganados++;
        local.puntos += puntosVictoria;
        visitante.perdidos++;
        visitante.puntos += puntosDerrota;
      } else if (golesLocal < golesVisitante) {
        visitante.ganados++;
        visitante.puntos += puntosVictoria;
        local.perdidos++;
        local.puntos += puntosDerrota;
      } else {
        local.empatados++;
        visitante.empatados++;
        local.puntos += puntosEmpate;
        visitante.puntos += puntosEmpate;
      }
    }

    const criteria = this.getStandingsCriteria(config);
    // Sorteo oficial estable: valor fijo por equipo para no "barajar" la tabla en cada consulta
    const sorteo = new Map<number, number>(
      [...standings.values()].map((row) => [row.idEquipo, this.stableDraw(idTorneo, row.idEquipo)]),
    );
    const rows = [...standings.values()].map((row) => ({
      ...row,
      diferenciaGoles: row.golesFavor - row.golesContra,
    }));

    rows.sort((a, b) => {
      // 1. Siempre priman los puntos
      const puntosDiff = Number(b.puntos ?? 0) - Number(a.puntos ?? 0);
      if (puntosDiff !== 0) return puntosDiff;

      // 2. Criterios de desempate configurados, en orden
      for (const criterion of criteria) {
        if (criterion === 'sorteo') continue; // el sorteo se aplica al final
        const difference = Number(b[criterion] ?? 0) - Number(a[criterion] ?? 0);
        if (difference !== 0) return difference;
      }

      // 3. Sorteo oficial (solo si todo lo anterior empata)
      if (criteria.includes('sorteo')) {
        return Number(sorteo.get(b.idEquipo) ?? 0) - Number(sorteo.get(a.idEquipo) ?? 0);
      }

      return a.nombre.localeCompare(b.nombre);
    });

    rows.forEach((row, index) => {
      row.posicion = index + 1;
    });

    return rows;
  }

  /**
   * Genera (si faltan) y acomoda los registros de la fase definitoria:
   * FINAL = 1° vs 2° y TERCER_LUGAR = 3° vs 4°. No hay semifinales.
   */
  async generatePlayoffs(idTorneo: number) {
    await this.ensureTournamentExists(idTorneo);
    return this.refreshDefinitoria(idTorneo);
  }

  /**
   * Crea (si faltan) y actualiza los registros de FINAL y TERCER_LUGAR según
   * las posiciones actuales de la fase de grupos. Se ejecuta automáticamente
   * con cada resultado para ir acomodando quién juega la final y el partido
   * por el tercer lugar. Los partidos que ya tienen marcador no se tocan.
   */
  async refreshDefinitoria(idTorneo: number) {
    const tournament: any = await this.ensureTournamentExists(idTorneo);
    const config = this.parseFormatoConfig(tournament.formato_config);

    if (config.tipoTorneo === 'ROUND_ROBIN') {
      return { message: 'Este torneo no tiene fase definitoria.', actualizado: false };
    }

    const grupos: any[] = await this.db.query(
      `SELECT idPartido, numeroRonda, fecha FROM Partidos WHERE idTorneo = ? AND fase = 'GRUPO'`,
      [idTorneo],
    );

    // Asegurar que existan los registros de la fase definitoria: se juegan
    // en el último día del calendario de partidos (o en la fecha de cierre)
    const existentes: any[] = await this.db.query(
      `SELECT fase FROM Partidos WHERE idTorneo = ? AND fase IN ('FINAL', 'TERCER_LUGAR')`,
      [idTorneo],
    );
    const tieneFinal = existentes.some((match) => match.fase === 'FINAL');
    const tieneTercerLugar = existentes.some((match) => match.fase === 'TERCER_LUGAR');

    if (!tieneFinal || !tieneTercerLugar) {
      const muestra: any[] = await this.db.query(
        `SELECT duracionTiempoMinutos, duracionDescansoMinutos FROM Partidos
         WHERE idTorneo = ? AND fase = 'GRUPO' ORDER BY idPartido LIMIT 1`,
        [idTorneo],
      );
      const duracionTiempo = Number(muestra[0]?.duracionTiempoMinutos) || 20;
      const duracionDescanso = Number(muestra[0]?.duracionDescansoMinutos) || 5;
      const ventana = ESPACIO_ENTRE_PARTIDOS_MINUTOS;
      const baseDate =
        this.parseDateOnly(tournament.fechaFin || tournament.fechaInicio) ?? new Date();
      const diaDefinitoria = this.definitoriaDay(config, baseDate);
      const horaInicio = this.parseHoraInicio(config);
      // Los partidos de grupos que ya caen en ese día consumen los primeros horarios
      const ocupados = grupos.filter((match) => {
        const fecha = this.parseDateOnly(match.fecha);
        return fecha ? this.isSameDay(fecha, diaDefinitoria) : false;
      }).length;
      const rondaBase = Math.max(0, ...grupos.map((match) => Number(match.numeroRonda) || 0));
      const fechaTercerLugar = new Date(
        diaDefinitoria.getTime() + (horaInicio + ocupados * ventana) * 60000,
      );
      const fechaFinal = new Date(
        diaDefinitoria.getTime() + (horaInicio + (ocupados + 1) * ventana) * 60000,
      );

      if (!tieneTercerLugar) {
        await this.db.query(
          `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
           VALUES (?, 'TERCER_LUGAR', ?, NULL, NULL, ?, ?, ?, 'programado')`,
          [idTorneo, rondaBase + 1, duracionTiempo, duracionDescanso, fechaTercerLugar],
        );
      }
      if (!tieneFinal) {
        await this.db.query(
          `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
           VALUES (?, 'FINAL', ?, NULL, NULL, ?, ?, ?, 'programado')`,
          [idTorneo, rondaBase + 2, duracionTiempo, duracionDescanso, fechaFinal],
        );
      }
    }

    const conResultado: any[] = await this.db.query(
      `SELECT idPartido FROM Partidos WHERE idTorneo = ? AND fase = 'GRUPO'
        AND marcadorLocal IS NOT NULL AND marcadorVisitante IS NOT NULL`,
      [idTorneo],
    );

    if (!conResultado.length) {
      return {
        message: 'Aún no hay resultados en la fase de grupos.',
        actualizado: false,
        partidos: await this.getTournamentMatches(idTorneo),
      };
    }

    const standings = await this.getStandings(idTorneo);
    if (standings.length < 4) {
      return {
        message: 'Se requieren al menos 4 equipos clasificados.',
        actualizado: false,
        partidos: await this.getTournamentMatches(idTorneo),
      };
    }

    // 1° vs 2° en la final y 3° vs 4° por el tercer lugar
    const cruces = [
      { fase: 'FINAL', local: standings[0].idEquipo, visitante: standings[1].idEquipo },
      { fase: 'TERCER_LUGAR', local: standings[2].idEquipo, visitante: standings[3].idEquipo },
    ];
    const registros: any[] = await this.db.query(
      `SELECT * FROM Partidos WHERE idTorneo = ? AND fase IN ('FINAL', 'TERCER_LUGAR')`,
      [idTorneo],
    );
    let actualizado = false;

    for (const cruce of cruces) {
      const registro = registros.find((match) => match.fase === cruce.fase);
      if (!registro) continue;

      const tieneEquipos =
        registro.idEquipoLocal != null && registro.idEquipoVisitante != null;
      const tieneResultado =
        registro.marcadorLocal != null && registro.marcadorVisitante != null;

      // Ya se jugó con sus equipos definidos: no se toca (se preserva el resultado)
      if (tieneEquipos && tieneResultado) continue;

      // Un registro sin equipos no puede tener resultado real: si trae marcador
      // (p. ej. se marcó "finalizado" antes de definir a los clasificados) se limpia
      const limpiarResultado = !tieneEquipos && tieneResultado;

      const result: any = await this.db.query(
        `UPDATE Partidos
         SET idEquipoLocal = ?, idEquipoVisitante = ?${
           limpiarResultado
             ? `, marcadorLocal = NULL, marcadorVisitante = NULL,
                marcadorPenalesLocal = NULL, marcadorPenalesVisitante = NULL,
                ganador = NULL, status = 'programado'`
             : ''
         }
         WHERE idPartido = ?`,
        [cruce.local, cruce.visitante, registro.idPartido],
      );
      if (result.affectedRows > 0) actualizado = true;
    }

    return {
      message: actualizado
        ? 'Fase definitoria actualizada con las posiciones actuales.'
        : 'La fase definitoria ya refleja las posiciones actuales.',
      actualizado,
      posiciones: standings.slice(0, 4),
      partidos: await this.getTournamentMatches(idTorneo),
    };
  }

  /**
   * Reprograma los partidos sin resultado según el calendario del torneo
   * (diasJuego + horaInicioJornada). Los grupos se reparten en los días del
   * calendario salvo el último, que queda para la final y el tercer lugar.
   * Los partidos que ya tienen marcador conservan su fecha.
   */
  private async reschedulePendingMatches(
    idTorneo: number,
    config: any,
    baseDate: Date,
    playoffDate: Date,
  ) {
    const todos: any[] = await this.db.query(
      `SELECT idPartido, fase, numeroRonda, fecha, marcadorLocal, marcadorVisitante,
              duracionTiempoMinutos, duracionDescansoMinutos
       FROM Partidos
       WHERE idTorneo = ? AND fase IN ('GRUPO', 'TERCER_LUGAR', 'FINAL')
       ORDER BY CASE fase WHEN 'GRUPO' THEN 0 WHEN 'TERCER_LUGAR' THEN 1 ELSE 2 END,
                numeroRonda, idPartido`,
      [idTorneo],
    );

    const pendientes = todos.filter(
      (match) => match.marcadorLocal == null && match.marcadorVisitante == null,
    );
    if (!pendientes.length) return;

    const diasGrupos = this.groupDays(config, baseDate, playoffDate);
    const diaDefinitoria = this.definitoriaDay(config, playoffDate);
    const horaInicio = this.parseHoraInicio(config);
    const slotsPorDia = new Map<number, number>();

    // Los partidos ya jugados siguen ocupando su horario en los días del calendario
    for (const match of todos) {
      if (match.marcadorLocal == null || match.marcadorVisitante == null) continue;
      const fecha = this.parseDateOnly(match.fecha);
      if (!fecha) continue;
      const dayIndex = diasGrupos.findIndex((dia) => this.isSameDay(dia, fecha));
      if (dayIndex >= 0) {
        slotsPorDia.set(dayIndex, (slotsPorDia.get(dayIndex) ?? 0) + 1);
      }
    }

    for (const match of pendientes) {
      const ventana = ESPACIO_ENTRE_PARTIDOS_MINUTOS;
      let fecha: Date;

      if (match.fase === 'GRUPO') {
        const dayIndex = Math.min(
          (Number(match.numeroRonda) || 1) - 1,
          diasGrupos.length - 1,
        );
        const slot = slotsPorDia.get(dayIndex) ?? 0;
        slotsPorDia.set(dayIndex, slot + 1);
        fecha = new Date(
          diasGrupos[dayIndex].getTime() + (horaInicio + slot * ventana) * 60000,
        );
      } else {
        // Fase definitoria: el último día del calendario
        const ultimoDiaGrupos = diasGrupos[diasGrupos.length - 1];
        const slotBase = this.isSameDay(diaDefinitoria, ultimoDiaGrupos)
          ? (slotsPorDia.get(diasGrupos.length - 1) ?? 0)
          : 0;
        const slot = match.fase === 'TERCER_LUGAR' ? slotBase : slotBase + 1;
        fecha = new Date(
          diaDefinitoria.getTime() + (horaInicio + slot * ventana) * 60000,
        );
      }

      await this.db.query(`UPDATE Partidos SET fecha = ? WHERE idPartido = ?`, [
        fecha,
        match.idPartido,
      ]);
    }
  }

  /** Valor pseudoaleatorio estable por equipo (sorteo oficial sin "barajar" la tabla en cada consulta). */
  private stableDraw(idTorneo: number, idEquipo: number): number {
    const seed = (Number(idTorneo) * 31 + Number(idEquipo) * 17) % 997;
    return (seed * 2654435761) % 1000003;
  }

  /** `formato_config` llega como objeto o como string JSON desde MySQL. */
  private parseFormatoConfig(value: any): any {
    if (!value) return {};
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }
    return typeof value === 'object' ? value : {};
  }

  /** Fecha 'YYYY-MM-DD' como medianoche local (evita el desfase UTC de new Date(string)). */
  private parseDateOnly(value?: string | Date | null): Date | null {
    if (!value) return null;

    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? null
        : new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }

    const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? null
      : new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /** Hora de inicio de jornada en minutos desde medianoche (por defecto 08:30). */
  private parseHoraInicio(config: any): number {
    const match = String(config?.horaInicioJornada ?? '')
      .trim()
      .match(/^(\d{1,2}):(\d{2})/);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
    return 8 * 60 + 30;
  }

  /** Días del "Calendario de partidos" (diasJuego), ordenados y sin repetidos. */
  private getDiasJuego(config: any): string[] {
    if (!Array.isArray(config?.diasJuego)) return [];
    const dias: string[] = config.diasJuego
      .map((dia: any) => String(dia ?? '').trim())
      .filter((dia: string) => dia.length > 0);
    return [...new Set<string>(dias)].sort();
  }

  /**
   * Días de la fase de grupos: todos los del calendario salvo el último,
   * que queda reservado para la final y el partido por el tercer lugar.
   * Sin calendario, días consecuentes desde la fecha de inicio.
   */
  private groupDays(config: any, baseDate: Date, playoffDate: Date): Date[] {
    const dias = this.getDiasJuego(config);
    const diasGrupos = dias.length > 1 ? dias.slice(0, -1) : dias;

    if (diasGrupos.length) {
      return diasGrupos.map((dia) => this.parseDateOnly(dia)!);
    }

    const totalDias = Math.max(
      1,
      Math.ceil((playoffDate.getTime() - baseDate.getTime()) / 86400000),
    );
    return Array.from({ length: totalDias }, (_, index) =>
      new Date(baseDate.getTime() + index * 86400000),
    );
  }

  /** Último día del calendario (o la fecha de cierre) para la definitoria. */
  private definitoriaDay(config: any, playoffDate: Date): Date {
    const dias = this.getDiasJuego(config);
    return dias.length ? this.parseDateOnly(dias[dias.length - 1])! : playoffDate;
  }

  private isSameDay(first: Date, second: Date): boolean {
    return (
      first.getFullYear() === second.getFullYear() &&
      first.getMonth() === second.getMonth() &&
      first.getDate() === second.getDate()
    );
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
    const config = this.parseFormatoConfig(formatoConfig);
    // El front guarda criteriosDesempate (claves en mayúsculas); `criterios` es el alias legacy
    const source = Array.isArray(config?.criteriosDesempate)
      ? config.criteriosDesempate
      : Array.isArray(config?.criterios)
        ? config.criterios
        : [];

    const configured = source
      .map((criterion: any) => (typeof criterion === 'string' ? criterion : criterion?.campo || criterion?.tipo))
      .map((criterion: string) => this.mapCriterion(criterion))
      .filter(Boolean);

    return configured.length
      ? configured
      : ['diferenciaGoles', 'golesFavor', 'ganados', 'vallasInvictas', 'sorteo'];
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
      partidosganados: 'ganados',
      vallasinvictas: 'vallasInvictas',
      sorteo: 'sorteo',
      sorteoooficial: 'sorteo',
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

    // Reprogramar los partidos sin resultado según el calendario guardado
    // (diasJuego + horaInicioJornada; el último día es para la definitoria)
    const config = this.parseFormatoConfig(formato_config);
    const baseDate = this.parseDateOnly(fechaInicio) ?? new Date();
    const playoffDate = this.parseDateOnly(fechaFin) ?? baseDate;
    await this.reschedulePendingMatches(idTorneo, config, baseDate, playoffDate);

    // Reacomodar la fase definitoria si ya hay resultados de grupos
    await this.refreshDefinitoria(idTorneo);

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