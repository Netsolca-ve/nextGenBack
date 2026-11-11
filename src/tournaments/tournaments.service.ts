// src/tournaments/tournaments.service.ts
import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { createSlug } from '../common/slug';
import { DatabaseService } from '../database/database.service';
import { imageKeys } from '../storage/image-presets';
import { StorageService } from '../storage/storage.service';
import { CreateTournamentDto } from './dto/create-tounament.dto';

/**
 * Minutos mínimos entre el inicio de un partido y el siguiente (se juega en
 * una sola cancha). Si el partido dura más, se usa su duración.
 */
const ESPACIO_ENTRE_PARTIDOS_MINUTOS = 45;

/** Partido a programar en el calendario (ver scheduleMatches). */
type ScheduleItem = {
  fase: 'GRUPO' | 'TERCER_LUGAR' | 'FINAL';
  ronda: number;
  /** Jornadas de la fase de grupos de su categoría. */
  totalRondas: number;
  /** Índice de la categoría (0 si el torneo no tiene categorías). */
  categoria: number;
  /** Posición del partido dentro de su jornada. */
  orden: number;
};

/** Banner por defecto cuando el torneo no tiene uno propio. */
const DEFAULT_EVENT_BANNER = '/images/bannerEvento.jpg';

/** Imagen de los torneos aún no anunciados (estado PROXIMAMENTE). */
const PROXIMAMENTE_BANNER = '/images/proximamente.webp';


@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

async createTournament(dto: CreateTournamentDto, banner?: Express.Multer.File) {
  const { nombre, categoria, fechaInicio, fechaFin, formato_config, status } = dto;

  // Equipos agrupados por categoría (fixture por categoría) o una sola lista
  // mezclada (torneos antiguos).
  const { grupos, porCategoria } = this.normalizeGroups(dto);
  const sinEquipos = !grupos.length || grupos.every((grupo) => !grupo.equiposIds.length);

  // Un torneo "Próximamente" se crea vacío: sin equipos y sin calendario.
  // El resto necesita al menos 4 equipos por categoría para generar la fase de grupos.
  if (!sinEquipos && grupos.some((grupo) => grupo.equiposIds.length < 4)) {
    throw new BadRequestException(
      porCategoria
        ? 'Cada categoría requiere al menos 4 equipos para generar el torneo.'
        : 'Se requieren al menos 4 equipos para generar el torneo.',
    );
  }

  // Un torneo "Próximamente" guarda sus equipos pero aún no tiene calendario:
  // se genera al pasarlo a otro estado. El calendario se valida antes de
  // escribir nada en la BD.
  const generarCalendario = !sinEquipos && !this.isProximamente(status);
  const configJson = this.buildFormatoConfig(formato_config, grupos, porCategoria);
  if (generarCalendario) {
    this.resolveCalendar(this.parseFormatoConfig(configJson), fechaInicio, fechaFin);
  }

  // La columna banner no admite NULL: sin banner propio se usa la imagen
  // por defecto (la de "Próximamente" cuando el estado lo indica). El banner
  // subido se nombra con el idTorneo, así que se asigna tras guardar.
  const defaultBanner = status === 'PROXIMAMENTE' ? PROXIMAMENTE_BANNER : DEFAULT_EVENT_BANNER;
  const incomingBanner = banner
    ? await this.storage.uploadTemp(banner.buffer, 'tournament')
    : this.storage.toKey(dto.banner);
  let bannerPath = incomingBanner && !this.storage.isTempKey(incomingBanner)
    ? incomingBanner
    : defaultBanner;

  // Torneo, inscripciones y partidos en una sola transacción: si algo falla
  // no queda un torneo a medias (sin partidos o sin la fase definitoria).
  const { idTorneo, fixture } = await this.db.transaction(async () => {
    const torneoResult: any = await this.db.query(
      `INSERT INTO torneos (nombre, categoria, sede, formato_config, status, fechaInicio, fechaFin, banner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nombre,
        categoria,
        this.sedeFrom(dto),
        configJson,
        status || 'PROGRAMADO',
        fechaInicio || null,
        fechaFin || null,
        bannerPath,
      ],
    );
    const id = Number(torneoResult.insertId);

    await this.replaceInscritos(id, grupos);

    return {
      idTorneo: id,
      fixture: generarCalendario
        ? await this.generateFixtures(id, grupos, porCategoria, configJson, dto)
        : null,
    };
  });

  if (this.storage.isTempKey(incomingBanner)) {
    try {
      const bannerChange = await this.storage.assignImage({
        incoming: incomingBanner,
        currentKey: null,
        targetKey: imageKeys.tournament(createSlug(nombre, 'torneo'), idTorneo),
      });
      await this.db.query(`UPDATE torneos SET banner = ? WHERE idTorneo = ?`, [bannerChange.key, idTorneo]);
      await this.storage.commit(bannerChange);
      bannerPath = bannerChange.key ?? defaultBanner;
    } catch (error) {
      // El torneo ya quedó creado con el banner por defecto
      this.logger.error(
        `No se pudo asignar el banner del torneo ${idTorneo}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  return {
    idTorneo,
    message: fixture
      ? 'Torneo, inscripciones y partidos generados con éxito.'
      : 'Torneo creado sin equipos ni calendario.',
    partidosGruposGenerados: fixture?.partidosGrupos ?? 0,
    partidosDefinitoria: fixture?.partidosDefinitoria ?? 0,
    jornadas: fixture?.jornadas ?? 0,
    categorias: grupos.length,
    fechaInicioTorneo: fechaInicio || null,
    fechaFinalEstimada: fixture?.fechaFinal ?? null,
    banner: this.storage.url(bannerPath),
  };
}

  /** Reemplaza los equipos inscritos (sin duplicados entre categorías). */
  private async replaceInscritos(
    idTorneo: number,
    grupos: Array<{ categoria: string; equiposIds: number[] }>,
  ) {
    await this.db.query(`DELETE FROM equiposTorneo WHERE idTorneo = ?`, [idTorneo]);

    const inscritos = [...new Set(grupos.flatMap((grupo) => grupo.equiposIds))];
    for (const idEquipo of inscritos) {
      await this.db.query(
        `INSERT INTO equiposTorneo (idTorneo, idEquipo) VALUES (?, ?)`,
        [idTorneo, idEquipo],
      );
    }
  }

  /**
   * Genera todos los partidos del torneo: todos contra todos por categoría en
   * los días de grupos y, si el formato la tiene, la fase definitoria (tercer
   * lugar y final de cada categoría, sin equipos aún) en el último día.
   * Debe llamarse dentro de una transacción.
   */
  private async generateFixtures(
    idTorneo: number,
    grupos: Array<{ categoria: string; equiposIds: number[] }>,
    porCategoria: boolean,
    configJson: string,
    dto: CreateTournamentDto,
  ) {
    const config = this.parseFormatoConfig(configJson);
    const calendario = this.resolveCalendar(config, dto.fechaInicio, dto.fechaFin);
    const conDefinitoria = this.hasDefinitoria(config);
    const duracionTiempo = dto.duracionTiempoMinutos || Number(config.duracionTiempoMinutos) || 20;
    const duracionDescanso =
      dto.duracionDescansoMinutos ?? this.numberOr(config.duracionDescansoMinutos, 5);

    // Partidos a programar: cada categoría con su propio todos contra todos
    const items: Array<ScheduleItem & { local: number | null; visitante: number | null }> = [];
    let jornadas = 0;

    grupos.forEach((grupo, categoriaIndex) => {
      const { matches, totalRounds } = this.roundRobin(grupo.equiposIds);
      jornadas = Math.max(jornadas, totalRounds);
      const ordenPorRonda = new Map<number, number>();

      for (const match of matches) {
        const orden = ordenPorRonda.get(match.ronda) ?? 0;
        ordenPorRonda.set(match.ronda, orden + 1);
        items.push({
          fase: 'GRUPO',
          ronda: match.ronda,
          totalRondas: totalRounds,
          categoria: categoriaIndex,
          orden,
          local: match.local,
          visitante: match.visitante,
        });
      }

      if (conDefinitoria) {
        for (const fase of ['TERCER_LUGAR', 'FINAL'] as const) {
          items.push({
            fase,
            ronda: totalRounds + (fase === 'TERCER_LUGAR' ? 1 : 2),
            totalRondas: totalRounds,
            categoria: categoriaIndex,
            orden: 0,
            local: null,
            visitante: null,
          });
        }
      }
    });

    const fechas = this.scheduleMatches(items, calendario, config);

    // Se insertan en orden cronológico para que los IDs sigan el calendario
    const ordenados = [...items].sort(
      (a, b) => fechas.get(a)!.getTime() - fechas.get(b)!.getTime(),
    );
    const definitoria = grupos.map((grupo) => ({
      categoria: grupo.categoria as string | null,
      idTercerLugar: null as number | null,
      idFinal: null as number | null,
    }));

    for (const item of ordenados) {
      const result: any = await this.db.query(
        `INSERT INTO Partidos (
          idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante,
          duracionTiempoMinutos, duracionDescansoMinutos, fecha, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'programado')`,
        [
          idTorneo,
          item.fase,
          item.ronda,
          item.local,
          item.visitante,
          duracionTiempo,
          duracionDescanso,
          this.formatSqlDateTime(fechas.get(item)!),
        ],
      );
      if (item.fase === 'TERCER_LUGAR') definitoria[item.categoria].idTercerLugar = Number(result.insertId);
      if (item.fase === 'FINAL') definitoria[item.categoria].idFinal = Number(result.insertId);
    }

    // Mapeo de las filas de la fase definitoria por categoría (la tabla
    // Partidos no guarda categoría): lo usan refreshDefinitoria y la vista.
    if (porCategoria && conDefinitoria) {
      config.definitoriaPorCategoria = definitoria;
    } else {
      delete config.definitoriaPorCategoria;
    }
    await this.db.query(`UPDATE torneos SET formato_config = ? WHERE idTorneo = ?`, [
      JSON.stringify(config),
      idTorneo,
    ]);

    return {
      partidosGrupos: items.filter((item) => item.fase === 'GRUPO').length,
      partidosDefinitoria: items.filter((item) => item.fase !== 'GRUPO').length,
      jornadas,
      fechaFinal: this.formatSqlDate(
        calendario.diaDefinitoria ?? calendario.diasGrupos[calendario.diasGrupos.length - 1],
      ),
    };
  }

  /**
   * Round-Robin simple: genera las rondas de todos contra todos con bye
   * ("equipo fantasma") para cantidad impar de equipos.
   */
  private roundRobin(equiposIds: number[]): {
    matches: Array<{ ronda: number; local: number; visitante: number }>;
    totalRounds: number;
  } {
    const teams = [...equiposIds];
    if (teams.length % 2 !== 0) teams.push(-1); // "Bye" para cantidad impar de equipos

    const numTeams = teams.length;
    const totalRounds = Math.max(0, numTeams - 1);
    const half = numTeams / 2;
    const matches: Array<{ ronda: number; local: number; visitante: number }> = [];

    for (let round = 0; round < totalRounds; round++) {
      for (let i = 0; i < half; i++) {
        const teamA = teams[i];
        const teamB = teams[numTeams - 1 - i];

        if (teamA !== -1 && teamB !== -1) {
          // Alternar condición de local por jornada
          const local = round % 2 === 0 ? teamA : teamB;
          const visitante = round % 2 === 0 ? teamB : teamA;

          matches.push({ ronda: round + 1, local, visitante });
        }
      }

      // Rotación del círculo manteniendo el primer equipo estático
      const firstTeam = teams[0];
      const restTeams = teams.slice(1);
      restTeams.unshift(restTeams.pop()!);
      teams.splice(0, teams.length, firstTeam, ...restTeams);
    }

    return { matches, totalRounds };
  }

  /**
   * Grupos de equipos del torneo:
   * - Con `dto.categorias`: un grupo por categoría (fixtures independientes).
   * - Sin `categorias`: un solo grupo con `equiposIds` (torneos antiguos).
   * También valida que ningún equipo esté en dos categorías a la vez.
   */
  private normalizeGroups(dto: CreateTournamentDto): {
    grupos: Array<{ categoria: string; equiposIds: number[] }>;
    porCategoria: boolean;
  } {
    const enviadas = Array.isArray(dto.categorias)
      ? dto.categorias.filter((grupo) => grupo && Array.isArray(grupo.equiposIds))
      : [];

    if (!enviadas.length) {
      const equiposIds = Array.isArray(dto.equiposIds) ? dto.equiposIds : [];
      return {
        grupos: equiposIds.length ? [{ categoria: dto.categoria, equiposIds: [...equiposIds] }] : [],
        porCategoria: false,
      };
    }

    const grupos: Array<{ categoria: string; equiposIds: number[] }> = [];
    const categoriasVistas = new Map<string, string>(); // clave normalizada → nombre original
    const categoriaPorEquipo = new Map<number, string>();

    for (const grupo of enviadas) {
      const categoria = String(grupo.categoria ?? '').trim();
      if (!categoria) {
        throw new BadRequestException('Cada grupo de equipos debe indicar su categoría.');
      }

      const clave = this.normalizeCategoryKey(categoria);
      if (categoriasVistas.has(clave)) {
        throw new BadRequestException(`La categoría "${categoria}" está repetida en el torneo.`);
      }

      const equiposIds = [...new Set(grupo.equiposIds.map((id) => Number(id)))].filter((id) =>
        Number.isFinite(id),
      );
      if (equiposIds.length < 4) {
        throw new BadRequestException(
          `La categoría ${categoria} requiere al menos 4 equipos para generar el torneo.`,
        );
      }

      for (const idEquipo of equiposIds) {
        const otraCategoria = categoriaPorEquipo.get(idEquipo);
        if (otraCategoria) {
          throw new BadRequestException(
            `El equipo ${idEquipo} está inscrito en dos categorías (${otraCategoria} y ${categoria}).`,
          );
        }
        categoriaPorEquipo.set(idEquipo, categoria);
      }

      categoriasVistas.set(clave, categoria);
      grupos.push({ categoria, equiposIds });
    }

    return { grupos, porCategoria: true };
  }

  /** Clave comparable de categoría: 'SUB 9', 'sub-9' y 'SUB09' quedan iguales. */
  private normalizeCategoryKey(value?: string | null): string {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  /**
   * `formato_config` a guardar: parte de la configuración del formulario y
   * agrega las claves que solo gestiona el backend (grupos por categoría,
   * mapeo de la fase definitoria) para no perderlas en cada actualización.
   */
  private buildFormatoConfig(
    formato_config: Record<string, any> | undefined,
    grupos: Array<{ categoria: string; equiposIds: number[] }>,
    porCategoria: boolean,
    previo?: Record<string, any> | null,
  ): string {
    const config = this.parseFormatoConfig(formato_config);

    if (porCategoria) {
      config.fixturesPorCategoria = true;
      config.gruposPorCategoria = grupos.map((grupo) => ({
        categoria: grupo.categoria,
        equiposIds: [...grupo.equiposIds],
      }));
      config.categoriasHabilitadas = grupos.map((grupo) => grupo.categoria);
      // El mapeo de la fase definitoria se conserva si ya existía (se vuelve
      // a registrar al crear/regenerar las filas en refreshDefinitoria)
      const definitoriaPrevia = this.parseFormatoConfig(previo || null).definitoriaPorCategoria;
      if (Array.isArray(definitoriaPrevia) && definitoriaPrevia.length) {
        config.definitoriaPorCategoria = definitoriaPrevia;
      } else if (Array.isArray(config.definitoriaPorCategoria) && config.definitoriaPorCategoria.length) {
        config.definitoriaPorCategoria = [...config.definitoriaPorCategoria];
      } else {
        delete config.definitoriaPorCategoria;
      }
    } else {
      config.fixturesPorCategoria = false;
      delete config.gruposPorCategoria;
      delete config.definitoriaPorCategoria;
    }

    return JSON.stringify(config);
  }

  async getTournamentMatches(idTorneo: number) {
    const tournament: any = await this.ensureTournamentExists(idTorneo);

    const rows: any[] = await this.db.query(
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

    return this.enrichMatchCategories(rows, tournament);
  }

  /**
   * Categoría "oficial" de cada partido según la configuración del torneo:
   * en torneos multi-categoría cada fixture pertenece a una categoría, aunque
   * los equipos aún no tengan categoría cargada (p. ej. la final vacía) o su
   * categoría guardada no coincida con el grupo.
   */
  private enrichMatchCategories(rows: any[], tournament: any): any[] {
    const config = this.parseFormatoConfig(tournament?.formato_config);
    const grupos = Array.isArray(config.gruposPorCategoria) ? config.gruposPorCategoria : [];
    const definitoria = Array.isArray(config.definitoriaPorCategoria)
      ? config.definitoriaPorCategoria
      : [];
    if (!grupos.length && !definitoria.length) return rows;

    const categoriaPorEquipo = new Map<number, string>();
    for (const grupo of grupos) {
      for (const idEquipo of grupo.equiposIds ?? []) {
        categoriaPorEquipo.set(Number(idEquipo), String(grupo.categoria ?? ''));
      }
    }

    const categoriaPorPartido = new Map<number, string>();
    for (const fila of definitoria) {
      const categoria = String(fila.categoria ?? '');
      if (!categoria) continue;
      if (fila.idTercerLugar) categoriaPorPartido.set(Number(fila.idTercerLugar), categoria);
      if (fila.idFinal) categoriaPorPartido.set(Number(fila.idFinal), categoria);
    }

    return rows.map((row) => ({
      ...row,
      categoria:
        categoriaPorPartido.get(Number(row.idPartido)) ??
        categoriaPorEquipo.get(Number(row.idEquipoLocal)) ??
        categoriaPorEquipo.get(Number(row.idEquipoVisitante)) ??
        row.categoria ??
        null,
    }));
  }

  /**
   * Máximos goleadores del torneo (sin autogoles), con la categoría del
   * equipo dentro del torneo para filtrarlos igual que la tabla.
   */
  async getTopScorers(idTorneo: number) {
    const tournament: any = await this.ensureTournamentExists(idTorneo);
    const categoriaPorEquipo = this.categoriaPorEquipo(this.parseFormatoConfig(tournament.formato_config));
    const rows: any[] = await this.db.query(
      `
        SELECT g.idJugador, j.nombre, j.apellido, j.foto, g.idEquipo,
               e.nombre AS nombreEquipo, e.logo AS logoEquipo, e.categoria AS categoriaEquipo,
               COUNT(*) AS goles
        FROM goles g
        INNER JOIN Partidos p ON p.idPartido = g.idPartido
        INNER JOIN jugadores j ON j.idJugador = g.idJugador
        LEFT JOIN equipos e ON e.idEquipo = g.idEquipo
        WHERE p.idTorneo = ? AND (g.esAutogol = 0 OR g.esAutogol IS NULL)
        GROUP BY g.idJugador, j.nombre, j.apellido, j.foto, g.idEquipo, e.nombre, e.logo, e.categoria
        ORDER BY goles DESC, j.apellido ASC, j.nombre ASC;
      `,
      [idTorneo],
    );

    return rows.map(({ categoriaEquipo, ...row }) => ({
      ...row,
      goles: Number(row.goles),
      foto: this.storage.url(row.foto),
      logoEquipo: this.storage.url(row.logoEquipo),
      categoria: categoriaPorEquipo.get(Number(row.idEquipo)) ?? categoriaEquipo,
    }));
  }

  /**
   * En torneos multi-categoría la categoría "oficial" del equipo dentro del
   * torneo viene de formato_config (puede diferir de su categoría guardada).
   */
  private categoriaPorEquipo(config: any): Map<number, string> {
    const categorias = new Map<number, string>();
    const grupos = Array.isArray(config.gruposPorCategoria) ? config.gruposPorCategoria : [];
    for (const grupo of grupos) {
      for (const idEquipo of grupo.equiposIds ?? []) {
        categorias.set(Number(idEquipo), String(grupo.categoria ?? ''));
      }
    }
    return categorias;
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
    const categoriaPorEquipo = this.categoriaPorEquipo(config);

    for (const team of teams) {
      standings.set(team.idEquipo, {
        posicion: 0,
        idEquipo: team.idEquipo,
        nombre: team.nombre,
        siglas: team.siglas,
        categoria: categoriaPorEquipo.get(Number(team.idEquipo)) ?? team.categoria,
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

    if (config.fixturesPorCategoria) {
      // Posiciones dentro de cada categoría (cada una tiene su propio fixture):
      // SUB 9 y SUB 12 conviven en la misma tabla pero cada una se ordena sola.
      const contadorPorCategoria = new Map<string, number>();
      for (const row of rows) {
        const clave = this.normalizeCategoryKey(row.categoria);
        const posicion = (contadorPorCategoria.get(clave) ?? 0) + 1;
        contadorPorCategoria.set(clave, posicion);
        row.posicion = posicion;
      }
    } else {
      rows.forEach((row, index) => {
        row.posicion = index + 1;
      });
    }

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
    // En transacción: crear filas, guardar el mapeo y asignar equipos van juntos
    return this.db.transaction(() => this.applyDefinitoria(idTorneo));
  }

  private async applyDefinitoria(idTorneo: number) {
    const tournament: any = await this.ensureTournamentExists(idTorneo);
    const config = this.parseFormatoConfig(tournament.formato_config);

    if (config.tipoTorneo === 'ROUND_ROBIN') {
      return { message: 'Este torneo no tiene fase definitoria.', actualizado: false };
    }

    // Torneo con fixtures por categoría: cada categoría tiene su propia
    // FINAL y su partido por el tercer lugar, con sus cruces.
    const gruposConfig = Array.isArray(config.gruposPorCategoria) ? config.gruposPorCategoria : [];
    if (config.fixturesPorCategoria && gruposConfig.length) {
      return this.refreshDefinitoriaPorCategoria(idTorneo, tournament, config, gruposConfig);
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
      // En el último día de juego, después de lo que ya haya ese día
      const diaDefinitoria = this.definitoriaDay(config, tournament);
      const rondaBase = Math.max(0, ...grupos.map((match) => Number(match.numeroRonda) || 0));
      const fechaTercerLugar = this.nextFreeSlot(grupos.map((match) => match.fecha), diaDefinitoria, config);
      const fechaFinal = new Date(fechaTercerLugar.getTime() + this.slotMinutes(config) * 60000);

      if (!tieneTercerLugar) {
        await this.db.query(
          `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
           VALUES (?, 'TERCER_LUGAR', ?, NULL, NULL, ?, ?, ?, 'programado')`,
          [idTorneo, rondaBase + 1, duracionTiempo, duracionDescanso, this.formatSqlDateTime(fechaTercerLugar)],
        );
      }
      if (!tieneFinal) {
        await this.db.query(
          `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
           VALUES (?, 'FINAL', ?, NULL, NULL, ?, ?, ?, 'programado')`,
          [idTorneo, rondaBase + 2, duracionTiempo, duracionDescanso, this.formatSqlDateTime(fechaFinal)],
        );
      }
    }

    // Los cruces se definen cuando termina la fase de grupos: antes, la tabla
    // todavía puede cambiar y la final quedaría con equipos provisionales.
    const sinResultado: any[] = await this.db.query(
      `SELECT idPartido FROM Partidos WHERE idTorneo = ? AND fase = 'GRUPO'
        AND (marcadorLocal IS NULL OR marcadorVisitante IS NULL)`,
      [idTorneo],
    );

    if (sinResultado.length || !grupos.length) {
      const limpiados = await this.clearProvisionalDefinitoria(idTorneo);
      return {
        message: 'La final y el tercer lugar se definen al terminar la fase de grupos.',
        actualizado: limpiados > 0,
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
   * Fase definitoria de los torneos con fixture por categoría: cada
   * categoría (p. ej. SUB 9 y SUB 12) tiene su propia FINAL y su partido por
   * el tercer lugar, y los cruces salen de las posiciones de esa categoría.
   * Las filas se identifican por el mapeo `definitoriaPorCategoria` de
   * formato_config (la tabla Partidos no guarda categoría).
   */
  private async refreshDefinitoriaPorCategoria(
    idTorneo: number,
    tournament: any,
    config: any,
    gruposConfig: Array<{ categoria: string; equiposIds: number[] }>,
  ) {
    const todos: any[] = await this.db.query(
      `SELECT idPartido, fase, numeroRonda, idEquipoLocal, idEquipoVisitante,
              marcadorLocal, marcadorVisitante, fecha
       FROM Partidos WHERE idTorneo = ? ORDER BY idPartido`,
      [idTorneo],
    );
    const filasDefinitoria = todos.filter(
      (match) => match.fase === 'FINAL' || match.fase === 'TERCER_LUGAR',
    );
    const filasGrupo = todos.filter((match) => match.fase === 'GRUPO');

    const muestra: any[] = await this.db.query(
      `SELECT duracionTiempoMinutos, duracionDescansoMinutos FROM Partidos
       WHERE idTorneo = ? AND fase = 'GRUPO' ORDER BY idPartido LIMIT 1`,
      [idTorneo],
    );
    const duracionTiempo = Number(muestra[0]?.duracionTiempoMinutos) || 20;
    const duracionDescanso = Number(muestra[0]?.duracionDescansoMinutos) || 5;
    const diaDefinitoria = this.definitoriaDay(config, tournament);
    const rondaBase = Math.max(0, ...filasGrupo.map((match) => Number(match.numeroRonda) || 0));

    type FilaMapeo = { categoria: string; idTercerLugar: number | null; idFinal: number | null };
    const mappingPrevia: FilaMapeo[] = (Array.isArray(config.definitoriaPorCategoria)
      ? config.definitoriaPorCategoria
      : []
    )
      .filter((fila: any) => fila && fila.categoria)
      .map((fila: any) => ({
        categoria: String(fila.categoria),
        idTercerLugar: fila.idTercerLugar ? Number(fila.idTercerLugar) : null,
        idFinal: fila.idFinal ? Number(fila.idFinal) : null,
      }));

    const asignados = new Set<number>();
    for (const fila of mappingPrevia) {
      if (fila.idTercerLugar) asignados.add(fila.idTercerLugar);
      if (fila.idFinal) asignados.add(fila.idFinal);
    }

    const filaExiste = (fase: string, id: number | null) =>
      id != null &&
      filasDefinitoria.some(
        (match) => Number(match.idPartido) === Number(id) && match.fase === fase,
      );

    let cambiosConfig = false;
    const mappingNuevo: FilaMapeo[] = [];

    for (const grupo of gruposConfig) {
      const categoria = String(grupo.categoria ?? '');
      const claveCategoria = this.normalizeCategoryKey(categoria);
      let fila = mappingPrevia.find(
        (item) => this.normalizeCategoryKey(item.categoria) === claveCategoria,
      );

      if (!fila) {
        fila = { categoria, idTercerLugar: null, idFinal: null };
        cambiosConfig = true;
      }

      for (const fase of ['TERCER_LUGAR', 'FINAL'] as const) {
        const clave: 'idTercerLugar' | 'idFinal' =
          fase === 'TERCER_LUGAR' ? 'idTercerLugar' : 'idFinal';

        if (filaExiste(fase, fila[clave])) continue;
        cambiosConfig = true;

        // Adoptar una fila huérfana de esa fase (creada antes del mapeo)
        const libre = filasDefinitoria.find(
          (match) => match.fase === fase && !asignados.has(Number(match.idPartido)),
        );
        if (libre) {
          fila[clave] = Number(libre.idPartido);
          asignados.add(Number(libre.idPartido));
          continue;
        }

        // Crear la fila con el siguiente horario libre del día de la definitoria
        const fecha = this.nextFreeSlot(todos.map((match) => match.fecha), diaDefinitoria, config);
        const insert: any = await this.db.query(
          `INSERT INTO Partidos (idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'programado')`,
          [
            idTorneo,
            fase,
            rondaBase + (fase === 'TERCER_LUGAR' ? 1 : 2),
            duracionTiempo,
            duracionDescanso,
            this.formatSqlDateTime(fecha),
          ],
        );
        const idNuevo = Number(insert.insertId);
        fila[clave] = idNuevo;
        asignados.add(idNuevo);
        todos.push({ idPartido: idNuevo, fecha: this.formatSqlDateTime(fecha) });
      }

      mappingNuevo.push(fila);
    }

    // Filas huérfanas de categorías que ya no existen en el torneo (o
    // duplicadas sin dueño): se eliminan solo si no tienen resultado.
    // Iteración inversa para poder sacar filas del arreglo mientras se recorre.
    for (let indice = filasDefinitoria.length - 1; indice >= 0; indice--) {
      const match = filasDefinitoria[indice];
      if (asignados.has(Number(match.idPartido))) continue;
      if (match.marcadorLocal != null || match.marcadorVisitante != null) continue;
      await this.db.query(
        `DELETE FROM Partidos WHERE idPartido = ? AND marcadorLocal IS NULL AND marcadorVisitante IS NULL`,
        [match.idPartido],
      );
      filasDefinitoria.splice(indice, 1);
    }

    if (cambiosConfig) {
      config.definitoriaPorCategoria = mappingNuevo;
      await this.db.query(`UPDATE torneos SET formato_config = ? WHERE idTorneo = ?`, [
        JSON.stringify(config),
        idTorneo,
      ]);
    }

    // 2. Acomodar equipos según las posiciones actuales de cada categoría
    const categoriaPorEquipo = new Map<string, string>();
    for (const grupo of gruposConfig) {
      const clave = this.normalizeCategoryKey(grupo.categoria);
      for (const idEquipo of grupo.equiposIds ?? []) {
        categoriaPorEquipo.set(String(idEquipo), clave);
      }
    }

    const conResultado = filasGrupo.filter(
      (match) => match.marcadorLocal != null && match.marcadorVisitante != null,
    );
    const standings = conResultado.length ? await this.getStandings(idTorneo) : [];
    const cruces: Array<{ idPartido: number; local: number; visitante: number }> = [];
    const categoriasPendientes: string[] = [];
    let actualizado = false;

    for (const fila of mappingNuevo) {
      const claveCategoria = this.normalizeCategoryKey(fila.categoria);

      // La final y el tercer lugar de una categoría se definen cuando todos
      // sus partidos de grupos tienen resultado: antes la tabla puede cambiar.
      // Mientras tanto quedan sin equipos ("Por definir").
      const grupoDeLaCategoria = filasGrupo.filter(
        (match) =>
          categoriaPorEquipo.get(String(match.idEquipoLocal)) === claveCategoria &&
          categoriaPorEquipo.get(String(match.idEquipoVisitante)) === claveCategoria,
      );
      const completa =
        grupoDeLaCategoria.length > 0 &&
        grupoDeLaCategoria.every(
          (match) => match.marcadorLocal != null && match.marcadorVisitante != null,
        );
      if (!completa) {
        categoriasPendientes.push(fila.categoria);
        const ids = [fila.idTercerLugar, fila.idFinal].filter((id): id is number => id != null);
        if ((await this.clearProvisionalDefinitoria(idTorneo, ids)) > 0) actualizado = true;
        continue;
      }

      const tabla = standings.filter(
        (row) => this.normalizeCategoryKey(row.categoria) === claveCategoria,
      );
      if (tabla.length < 4) {
        categoriasPendientes.push(fila.categoria);
        continue;
      }

      if (fila.idFinal) {
        cruces.push({ idPartido: fila.idFinal, local: tabla[0].idEquipo, visitante: tabla[1].idEquipo });
      }
      if (fila.idTercerLugar) {
        cruces.push({
          idPartido: fila.idTercerLugar,
          local: tabla[2].idEquipo,
          visitante: tabla[3].idEquipo,
        });
      }
    }

    for (const cruce of cruces) {
      const registro = filasDefinitoria.find(
        (match) => Number(match.idPartido) === Number(cruce.idPartido),
      );
      if (!registro) continue;

      const tieneEquipos =
        registro.idEquipoLocal != null && registro.idEquipoVisitante != null;
      const tieneResultado =
        registro.marcadorLocal != null && registro.marcadorVisitante != null;

      // Ya se jugó con sus equipos definidos: no se toca (se preserva el resultado)
      if (tieneEquipos && tieneResultado) continue;

      // Un registro sin equipos no puede tener resultado real: se limpia
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
        [cruce.local, cruce.visitante, cruce.idPartido],
      );
      if (result.affectedRows > 0) actualizado = true;
    }

    return {
      message: actualizado
        ? 'Fase definitoria actualizada con las posiciones actuales.'
        : categoriasPendientes.length
          ? `La final y el tercer lugar se definen al terminar la fase de grupos de: ${categoriasPendientes.join(', ')}.`
          : 'La fase definitoria ya refleja las posiciones actuales.',
      actualizado,
      posiciones: standings,
      partidos: await this.getTournamentMatches(idTorneo),
    };
  }

  /**
   * Reprograma los partidos sin resultado según los días de juego del torneo
   * (mismo reparto que al crearlo). Los que ya tienen marcador conservan su
   * fecha y su horario queda ocupado.
   */
  private async reschedulePendingMatches(
    idTorneo: number,
    config: any,
    fechaInicio?: string | null,
    fechaFin?: string | null,
  ) {
    const todos: any[] = await this.db.query(
      `SELECT idPartido, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, fecha,
              marcadorLocal, marcadorVisitante
       FROM Partidos
       WHERE idTorneo = ? AND fase IN ('GRUPO', 'TERCER_LUGAR', 'FINAL')
       ORDER BY idPartido`,
      [idTorneo],
    );

    const jugado = (match: any) => match.marcadorLocal != null && match.marcadorVisitante != null;
    if (!todos.some((match) => !jugado(match))) return;

    const calendario = this.resolveCalendar(config, fechaInicio, fechaFin);

    // Categoría de cada partido: por sus equipos (grupos) o por el mapeo de
    // la fase definitoria. Sin categorías, todo es la categoría 0.
    const grupos: any[] = Array.isArray(config.gruposPorCategoria) ? config.gruposPorCategoria : [];
    const categoriaPorEquipo = new Map<number, number>();
    grupos.forEach((grupo, index) => {
      for (const idEquipo of grupo.equiposIds ?? []) categoriaPorEquipo.set(Number(idEquipo), index);
    });
    const categoriaPorDefinitoria = new Map<number, number>();
    (Array.isArray(config.definitoriaPorCategoria) ? config.definitoriaPorCategoria : []).forEach(
      (fila: any) => {
        const index = grupos.findIndex(
          (grupo) => this.normalizeCategoryKey(grupo.categoria) === this.normalizeCategoryKey(fila?.categoria),
        );
        if (fila?.idTercerLugar) categoriaPorDefinitoria.set(Number(fila.idTercerLugar), Math.max(0, index));
        if (fila?.idFinal) categoriaPorDefinitoria.set(Number(fila.idFinal), Math.max(0, index));
      },
    );
    const categoriaDe = (match: any) =>
      match.fase === 'GRUPO'
        ? categoriaPorEquipo.get(Number(match.idEquipoLocal)) ?? 0
        : categoriaPorDefinitoria.get(Number(match.idPartido)) ?? 0;

    const totalRondas = new Map<number, number>();
    for (const match of todos) {
      if (match.fase !== 'GRUPO') continue;
      const categoria = categoriaDe(match);
      totalRondas.set(categoria, Math.max(totalRondas.get(categoria) ?? 0, Number(match.numeroRonda) || 1));
    }

    const ordenPorRonda = new Map<string, number>();
    const items: Array<ScheduleItem & { idPartido: number }> = [];
    const fijos: Date[] = [];

    for (const match of todos) {
      const categoria = categoriaDe(match);
      const ronda = Number(match.numeroRonda) || 1;
      const claveOrden = `${match.fase}|${categoria}|${ronda}`;
      const orden = ordenPorRonda.get(claveOrden) ?? 0;
      ordenPorRonda.set(claveOrden, orden + 1);

      if (jugado(match)) {
        const fecha = this.parseDateTime(match.fecha);
        if (fecha) fijos.push(fecha);
        continue;
      }

      items.push({
        idPartido: Number(match.idPartido),
        fase: match.fase,
        ronda,
        totalRondas: totalRondas.get(categoria) ?? ronda,
        categoria,
        orden,
      });
    }

    const fechas = this.scheduleMatches(items, calendario, config, fijos);

    for (const item of items) {
      await this.db.query(`UPDATE Partidos SET fecha = ? WHERE idPartido = ?`, [
        this.formatSqlDateTime(fechas.get(item)!),
        item.idPartido,
      ]);
    }
  }

  /**
   * Asigna fecha y hora a cada partido:
   * - Las jornadas de cada categoría se reparten de forma pareja entre los
   *   días de grupos (nunca se amontonan en el último).
   * - El día de la definitoria solo tiene el tercer lugar y la final de cada
   *   categoría (primero todos los terceros lugares, luego las finales).
   * - Un partido por horario (una cancha), cada `slotMinutes` desde la hora
   *   de inicio; dentro de un día se alternan categorías para dar descanso.
   * - `fijos`: partidos ya jugados cuyo horario queda ocupado.
   */
  private scheduleMatches<T extends ScheduleItem>(
    items: T[],
    calendario: { diasGrupos: Date[]; diaDefinitoria: Date | null },
    config: any,
    fijos: Date[] = [],
  ): Map<T, Date> {
    const { diasGrupos, diaDefinitoria } = calendario;
    const horaInicio = this.parseHoraInicio(config);
    const slot = this.slotMinutes(config);
    const totalDias = diasGrupos.length;
    const rangoFase: Record<string, number> = { GRUPO: 0, TERCER_LUGAR: 1, FINAL: 2 };

    const porDia = new Map<number, { dia: Date; items: T[] }>();
    for (const item of items) {
      const dia =
        item.fase !== 'GRUPO' && diaDefinitoria
          ? diaDefinitoria
          : diasGrupos[
              Math.min(
                totalDias - 1,
                Math.floor(((item.ronda - 1) * totalDias) / Math.max(1, item.totalRondas)),
              )
            ];
      const entrada = porDia.get(dia.getTime()) ?? { dia, items: [] };
      entrada.items.push(item);
      porDia.set(dia.getTime(), entrada);
    }

    const fechas = new Map<T, Date>();

    for (const { dia, items: delDia } of porDia.values()) {
      delDia.sort(
        (a, b) =>
          rangoFase[a.fase] - rangoFase[b.fase] ||
          a.ronda - b.ronda ||
          a.orden - b.orden ||
          a.categoria - b.categoria,
      );

      // Horarios (en minutos desde medianoche) ocupados por partidos jugados
      const ocupados = fijos
        .filter((fecha) => this.isSameDay(fecha, dia))
        .map((fecha) => fecha.getHours() * 60 + fecha.getMinutes());

      let inicio = horaInicio;
      for (const item of delDia) {
        while (ocupados.some((ocupado) => inicio < ocupado + slot && ocupado < inicio + slot)) {
          inicio += slot;
        }
        if (inicio + slot > 24 * 60) {
          throw new BadRequestException(
            `Los partidos del ${this.formatDisplayDate(dia)} no caben en el día ` +
              `(${delDia.length} partidos de ${slot} min desde las ${this.formatClock(horaInicio)}). ` +
              'Agrega más días de juego o adelanta la hora de inicio.',
          );
        }
        fechas.set(item, new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 0, inicio));
        inicio += slot;
      }
    }

    return fechas;
  }

  /**
   * Días de juego validados (los elegidos en "Agregar día"):
   * - Obligatorios, entre la fecha de inicio y la de cierre.
   * - Con fase definitoria hacen falta al menos 2: los de grupos y el último,
   *   reservado para el tercer lugar y la final.
   */
  private resolveCalendar(
    config: any,
    fechaInicio?: string | null,
    fechaFin?: string | null,
  ): { diasGrupos: Date[]; diaDefinitoria: Date | null } {
    const inicio = this.parseDateOnly(fechaInicio);
    const fin = this.parseDateOnly(fechaFin);

    if (!inicio) throw new BadRequestException('Indica la fecha de inicio del torneo.');
    if (!fin) throw new BadRequestException('Indica la fecha de cierre del torneo.');
    if (fin < inicio) {
      throw new BadRequestException('La fecha de cierre no puede ser anterior a la de inicio.');
    }

    const conDefinitoria = this.hasDefinitoria(config);
    const textos = this.getDiasJuego(config);
    const dias = textos.map((texto) => {
      const dia = this.parseDateOnly(texto);
      if (!dia) throw new BadRequestException(`El día de juego "${texto}" no es una fecha válida.`);
      return dia;
    });
    const minimo = conDefinitoria ? 2 : 1;

    if (dias.length < minimo) {
      throw new BadRequestException(
        conDefinitoria
          ? 'Agrega al menos 2 días de juego: los de la fase de grupos y el último para el tercer lugar y la final.'
          : 'Agrega al menos un día de juego.',
      );
    }

    const fuera = dias.find((dia) => dia < inicio || dia > fin);
    if (fuera) {
      throw new BadRequestException(
        `El día de juego ${this.formatDisplayDate(fuera)} está fuera de las fechas del torneo ` +
          `(${this.formatDisplayDate(inicio)} al ${this.formatDisplayDate(fin)}).`,
      );
    }

    return conDefinitoria
      ? { diasGrupos: dias.slice(0, -1), diaDefinitoria: dias[dias.length - 1] }
      : { diasGrupos: dias, diaDefinitoria: null };
  }

  /** Datos que definen el calendario: si no cambian, no se reprograma nada. */
  private calendarSignature(config: any, fechaInicio?: string | null, fechaFin?: string | null): string {
    return JSON.stringify([
      String(fechaInicio ?? '').slice(0, 10),
      String(fechaFin ?? '').slice(0, 10),
      this.getDiasJuego(config),
      this.parseHoraInicio(config),
      this.slotMinutes(config),
      this.hasDefinitoria(config),
    ]);
  }

  /** Sede del torneo; los formularios antiguos la enviaban en formato_config.place. */
  private sedeFrom(dto: CreateTournamentDto): string | null {
    const place = this.parseFormatoConfig(dto.formato_config).place;
    return dto.sede?.trim() || (typeof place === 'string' ? place.trim() : '') || null;
  }

  private isProximamente(status?: string | null): boolean {
    return String(status ?? '').trim().toUpperCase() === 'PROXIMAMENTE';
  }

  /** El formato "todos contra todos" puro no tiene tercer lugar ni final. */
  private hasDefinitoria(config: any): boolean {
    return config?.tipoTorneo !== 'ROUND_ROBIN';
  }

  /**
   * Minutos entre el inicio de un partido y el siguiente: 45 como mínimo, o
   * lo que dure el partido (tiempos × duración + descansos) si es más largo,
   * para que nunca se solapen.
   */
  private slotMinutes(config: any): number {
    const tiempos = Math.max(1, Number(config?.tiemposPorPartido) || 2);
    const duracion = Number(config?.duracionTiempoMinutos) || 20;
    const descanso = this.numberOr(config?.duracionDescansoMinutos, 5);
    return Math.max(ESPACIO_ENTRE_PARTIDOS_MINUTOS, tiempos * duracion + descanso * (tiempos - 1));
  }

  private numberOr(value: unknown, fallback: number): number {
    const number = Number(value);
    return value === null || value === undefined || value === '' || Number.isNaN(number)
      ? fallback
      : number;
  }

  /** 'YYYY-MM-DD HH:MM:SS' guardado → Date local (sin desfase de zona horaria). */
  private parseDateTime(value: unknown): Date | null {
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
    if (!match) return null;
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
    );
  }

  private formatDisplayDate(date: Date): string {
    const [year, month, day] = this.formatSqlDate(date).split('-');
    return `${day}/${month}/${year}`;
  }

  /** "8:30 a. m." a partir de minutos desde medianoche. */
  private formatClock(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const suffix = hours < 12 ? 'a. m.' : 'p. m.';
    return `${hours % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
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

  /**
   * 'YYYY-MM-DD' a partir de un Date usando los componentes locales.
   * Se escribe como string para que MySQL guarde la hora "de pared" pretendida
   * sin importar la zona horaria del proceso ni del driver.
   */
  private formatSqlDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** 'YYYY-MM-DD HH:MM:SS' para escribir fechas de partidos en MySQL. */
  private formatSqlDateTime(date: Date): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${this.formatSqlDate(date)} ${hours}:${minutes}:${seconds}`;
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

  /** Día de la fase definitoria: el último día de juego (o la fecha de cierre en torneos antiguos). */
  private definitoriaDay(config: any, tournament: any): Date {
    const dias = this.getDiasJuego(config);
    return (
      this.parseDateOnly(dias[dias.length - 1]) ??
      this.parseDateOnly(tournament?.fechaFin || tournament?.fechaInicio) ??
      new Date()
    );
  }

  /** Primer horario libre de un día, después de los partidos que ya tiene. */
  private nextFreeSlot(fechas: unknown[], dia: Date, config: any): Date {
    const slot = this.slotMinutes(config);
    let inicio = this.parseHoraInicio(config);
    for (const value of fechas) {
      const fecha = this.parseDateTime(value);
      if (fecha && this.isSameDay(fecha, dia)) {
        inicio = Math.max(inicio, fecha.getHours() * 60 + fecha.getMinutes() + slot);
      }
    }
    return new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 0, inicio);
  }

  /**
   * Quita los equipos provisionales de la final y el tercer lugar que aún no
   * se jugaron (todos, o solo los indicados). Devuelve cuántas filas cambió.
   */
  private async clearProvisionalDefinitoria(idTorneo: number, ids?: number[]): Promise<number> {
    if (ids && !ids.length) return 0;
    const result: any = await this.db.query(
      `UPDATE Partidos SET idEquipoLocal = NULL, idEquipoVisitante = NULL
       WHERE idTorneo = ? AND fase IN ('FINAL', 'TERCER_LUGAR')
         AND marcadorLocal IS NULL AND marcadorVisitante IS NULL
         AND (idEquipoLocal IS NOT NULL OR idEquipoVisitante IS NOT NULL)
         ${ids ? `AND idPartido IN (${ids.map(() => '?').join(', ')})` : ''}`,
      ids ? [idTorneo, ...ids] : [idTorneo],
    );
    return Number(result?.affectedRows ?? 0);
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
   * Actualiza los datos y la configuración de un torneo, en una transacción.
   * - Si cambian los equipos o el formato y aún no hay resultados, el
   *   calendario se vuelve a generar completo.
   * - Si no cambian, los partidos sin resultado se reprograman según los días
   *   de juego (los ya jugados conservan su fecha).
   */
  async updateTournament(
    idTorneo: number,
    dto: CreateTournamentDto,
    banner?: Express.Multer.File,
  ) {
    const { nombre, categoria, fechaInicio, fechaFin, formato_config, status } = dto;

    const existentes: any[] = await this.db.query(
      `SELECT idTorneo, banner, formato_config, fechaInicio, fechaFin FROM torneos WHERE idTorneo = ?`,
      [idTorneo],
    );

    if (!existentes.length) {
      throw new BadRequestException('No se encontró el torneo a actualizar.');
    }

    const { grupos, porCategoria } = this.normalizeGroups(dto);
    const sinEquipos = !grupos.length || grupos.every((grupo) => !grupo.equiposIds.length);

    if (!sinEquipos && grupos.some((grupo) => grupo.equiposIds.length < 4)) {
      throw new BadRequestException(
        porCategoria
          ? 'Cada categoría requiere al menos 4 equipos para generar el torneo.'
          : 'Se requieren al menos 4 equipos para generar el torneo.',
      );
    }

    const previo = this.parseFormatoConfig(existentes[0].formato_config);
    const partidos: any[] = await this.db.query(
      `SELECT idPartido, marcadorLocal, marcadorVisitante FROM Partidos WHERE idTorneo = ?`,
      [idTorneo],
    );
    const inscritosPrevios: any[] = await this.db.query(
      `SELECT idEquipo FROM equiposTorneo WHERE idTorneo = ?`,
      [idTorneo],
    );
    const hayResultados = partidos.some(
      (match) => match.marcadorLocal != null && match.marcadorVisitante != null,
    );
    const nuevoConfig = this.parseFormatoConfig(formato_config);
    const cambiaFormato = this.hasDefinitoria(nuevoConfig) !== this.hasDefinitoria(previo);
    const cambianEquipos = this.teamsChanged(grupos, previo, inscritosPrevios);

    if ((cambianEquipos || cambiaFormato) && hayResultados) {
      throw new BadRequestException(
        'No se pueden cambiar los equipos ni el tipo de torneo porque ya hay partidos con resultado.',
      );
    }

    // Calendario completo nuevo: equipos o formato distintos, o un torneo
    // "Próximamente" que pasa a programado (todavía sin partidos)
    const conCalendario = !sinEquipos && !this.isProximamente(status);
    const regenerar = conCalendario && (cambianEquipos || cambiaFormato || !partidos.length);
    const configJson = this.buildFormatoConfig(
      formato_config,
      grupos,
      porCategoria,
      regenerar ? null : existentes[0].formato_config,
    );
    // Los partidos ya generados solo se tocan si cambia algo que los afecta:
    // equipos o formato (se regeneran) o fechas, días, horario y duración (se
    // reprograman los pendientes). Solo entonces se valida el calendario.
    const cambiaCalendario =
      this.calendarSignature(previo, existentes[0].fechaInicio, existentes[0].fechaFin) !==
      this.calendarSignature(this.parseFormatoConfig(configJson), fechaInicio, fechaFin);
    if (regenerar || (conCalendario && cambiaCalendario)) {
      this.resolveCalendar(this.parseFormatoConfig(configJson), fechaInicio, fechaFin);
    }

    // Banner nuevo, o el actual renombrado si cambió el nombre del torneo
    const currentBanner = existentes[0].banner;
    const bannerChange = await this.storage.assignImage({
      incoming: banner ? await this.storage.uploadTemp(banner.buffer, 'tournament') : dto.banner,
      currentKey: currentBanner,
      targetKey: imageKeys.tournament(createSlug(nombre, 'torneo'), idTorneo),
    });
    const bannerPath =
      bannerChange.key ?? (status === 'PROXIMAMENTE' ? PROXIMAMENTE_BANNER : DEFAULT_EVENT_BANNER);

    try {
      await this.db.transaction(async () => {
        await this.db.query(
          `UPDATE torneos SET nombre = ?, categoria = ?, sede = ?, formato_config = ?, status = ?, fechaInicio = ?, fechaFin = ?, banner = ? WHERE idTorneo = ?`,
          [
            nombre,
            categoria,
            this.sedeFrom(dto),
            configJson,
            status || 'PROGRAMADO',
            fechaInicio || null,
            fechaFin || null,
            bannerPath,
            idTorneo,
          ],
        );

        await this.replaceInscritos(idTorneo, grupos);

        if (regenerar || (!conCalendario && !hayResultados)) {
          await this.deleteTournamentMatches(idTorneo);
        }

        if (regenerar) {
          await this.generateFixtures(idTorneo, grupos, porCategoria, configJson, dto);
        } else if (conCalendario) {
          // Solo se reprograma si cambió el calendario: así no se pierden los
          // horarios que se ajustaron a mano en cada partido.
          if (cambiaCalendario) {
            await this.reschedulePendingMatches(idTorneo, this.parseFormatoConfig(configJson), fechaInicio, fechaFin);
            await this.refreshDefinitoria(idTorneo);
          }
        }
      });
    } catch (error) {
      await this.storage.rollback(bannerChange);
      throw error;
    }
    await this.storage.commit(bannerChange);

    return {
      idTorneo,
      message: regenerar
        ? 'Torneo actualizado y calendario generado de nuevo.'
        : conCalendario && cambiaCalendario
          ? 'Torneo actualizado; los partidos pendientes se reprogramaron.'
          : 'Torneo actualizado sin cambiar los partidos.',
      equiposInscritos: new Set(grupos.flatMap((grupo) => grupo.equiposIds)).size,
      categorias: grupos.length,
      calendarioRegenerado: regenerar,
      banner: this.storage.url(bannerPath),
    };
  }

  /**
   * Elimina el torneo con sus partidos (y sus goles, tarjetas, cambios y
   * alineaciones) e inscripciones, en una transacción. El banner se borra de
   * R2 después de confirmar.
   */
  async deleteTournament(idTorneo: number) {
    const torneos: any[] = await this.db.query(
      `SELECT idTorneo, nombre, banner FROM torneos WHERE idTorneo = ?`,
      [idTorneo],
    );
    if (!torneos.length) {
      throw new NotFoundException(`Torneo con ID ${idTorneo} no encontrado`);
    }

    await this.db.transaction(async () => {
      await this.deleteTournamentMatches(idTorneo);
      await this.db.query(`DELETE FROM equiposTorneo WHERE idTorneo = ?`, [idTorneo]);
      await this.db.query(`DELETE FROM torneos WHERE idTorneo = ?`, [idTorneo]);
    });
    await this.storage.delete(torneos[0].banner);

    return { idTorneo, message: `Torneo "${torneos[0].nombre}" eliminado con éxito.` };
  }

  /** Borra los partidos del torneo y sus registros (goles, tarjetas, cambios, alineaciones). */
  private async deleteTournamentMatches(idTorneo: number) {
    for (const tabla of ['goles', 'tarjetas', 'sustitucionespartido', 'alineacionespartido']) {
      await this.db.query(
        `DELETE FROM ${tabla} WHERE idPartido IN (SELECT idPartido FROM Partidos WHERE idTorneo = ?)`,
        [idTorneo],
      );
    }
    await this.db.query(`DELETE FROM Partidos WHERE idTorneo = ?`, [idTorneo]);
  }

  /** Huella comparable de los equipos por categoría (sin importar el orden). */
  private groupsSignature(grupos: Array<{ categoria: string; equiposIds: number[] }>): string {
    return JSON.stringify(
      grupos
        .filter((grupo) => grupo.equiposIds.length)
        .map((grupo) => [
          this.normalizeCategoryKey(grupo.categoria),
          [...grupo.equiposIds].map(Number).sort((a, b) => a - b),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  }

  /**
   * Si los equipos del formulario difieren de los guardados. En torneos
   * antiguos (una sola lista, sin categorías) solo se compara qué equipos
   * están inscritos, para no tomar el paso a categorías como un cambio.
   */
  private teamsChanged(
    grupos: Array<{ categoria: string; equiposIds: number[] }>,
    previo: any,
    inscritos: any[],
  ): boolean {
    if (previo.fixturesPorCategoria && Array.isArray(previo.gruposPorCategoria)) {
      return this.groupsSignature(grupos) !== this.groupsSignature(previo.gruposPorCategoria);
    }
    const ids = (values: number[]) => JSON.stringify([...new Set(values.map(Number))].sort((a, b) => a - b));
    return (
      ids(grupos.flatMap((grupo) => grupo.equiposIds)) !== ids(inscritos.map((row) => row.idEquipo))
    );
  }

    async getAllTournaments(){
        const sql = `
            SELECT 
            t.idTorneo,
            t.nombre,
            t.categoria,
            t.sede,
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
        const tournaments = await this.db.query(sql);
        return tournaments.map((tournament) => this.storage.withUrls(tournament, 'banner'));
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

    /**
     * Torneo destacado del home, según su fecha (en hora de Venezuela):
     * 1. el que se está jugando, 2. el próximo más cercano, 3. el último que
     * terminó (si no hay ninguno más). Devuelve `estadoCalendario` para que
     * el front muestre el contador, "en curso" o "finalizado".
     */
    async getNearestTournament(){
        const hoy = this.todayInVenezuela();
        const sql = `
        SELECT * FROM (
            SELECT
            t.idTorneo,
            t.nombre,
            t.categoria,
            t.sede,
            t.status,
            t.fechaInicio,
            t.fechaFin,
            t.banner,
            t.formato_config,
            -- Conteos en subconsultas: sin GROUP BY (ONLY_FULL_GROUP_BY en TiDB/MariaDB)
            (SELECT COUNT(*) FROM equiposTorneo et WHERE et.idTorneo = t.idTorneo) AS totalEquipos,
            (SELECT COUNT(*) FROM Partidos p WHERE p.idTorneo = t.idTorneo) AS totalPartidos,
            CASE
                WHEN t.status = 'PROXIMAMENTE' OR t.fechaInicio IS NULL THEN 'PROXIMAMENTE'
                WHEN t.status = 'FINALIZADO' THEN 'FINALIZADO'
                WHEN t.status = 'EN_CURSO' THEN 'EN_CURSO'
                WHEN t.fechaInicio > ? THEN 'PROXIMO'
                WHEN COALESCE(t.fechaFin, t.fechaInicio) >= ? THEN 'EN_CURSO'
                ELSE 'FINALIZADO'
            END AS estadoCalendario
            FROM torneos t
        ) torneo
        ORDER BY
        CASE estadoCalendario
            WHEN 'EN_CURSO' THEN 1
            WHEN 'PROXIMO' THEN 2
            WHEN 'FINALIZADO' THEN 3
            ELSE 4
        END ASC,
        CASE WHEN estadoCalendario = 'PROXIMO' THEN fechaInicio END ASC,
        COALESCE(fechaFin, fechaInicio) DESC,
        idTorneo DESC
        LIMIT 1;
        `;

        const results = await this.db.query(sql, [hoy, hoy]);
        return results.length > 0 ? this.storage.withUrls(results[0], 'banner') : null;
    }

    /** 'YYYY-MM-DD' de hoy en Venezuela (el servidor y la BD corren en UTC). */
    private todayInVenezuela(): string {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
    }
}