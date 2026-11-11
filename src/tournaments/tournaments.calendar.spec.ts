import { Test } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { TournamentsService } from './tournaments.service';

// StorageService real sin credenciales: los tests no suben imágenes a R2
const storageStub = new StorageService({
  get: (_name: string, fallback?: string) => fallback || 'test',
} as any);

type Partido = { fase: string; ronda: number; local: number | null; visitante: number | null; fecha: string };

/** BD simulada: guarda los partidos insertados y responde lo mínimo. */
function createDb(extra: (sql: string, params: any[]) => any = () => undefined) {
  const partidos: Partido[] = [];
  const transaction = jest.fn((work: () => Promise<unknown>) => work());
  const query = jest.fn(async (rawSql: string, params: any[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    const respuesta = extra(sql, params);
    if (respuesta !== undefined) return respuesta;
    if (sql.includes('INSERT INTO Partidos')) {
      partidos.push({ fase: params[1], ronda: params[2], local: params[3], visitante: params[4], fecha: params[7] });
      return { insertId: 1000 + partidos.length };
    }
    if (sql.includes('INSERT INTO torneos')) return { insertId: 9 };
    return { affectedRows: 1, insertId: 1 };
  });
  return { db: { query, transaction }, partidos, transaction };
}

async function buildService(db: any) {
  const module = await Test.createTestingModule({
    providers: [
      TournamentsService,
      { provide: DatabaseService, useValue: db },
      { provide: StorageService, useValue: storageStub },
    ],
  }).compile();
  return module.get(TournamentsService);
}

const categorias = (cantidad: number, equipos: number) =>
  Array.from({ length: cantidad }, (_, c) => ({
    categoria: `SUB ${9 + c * 3}`,
    equiposIds: Array.from({ length: equipos }, (_, i) => c * 10 + i + 1),
  }));

const torneo = (overrides: any = {}, config: any = {}) => ({
  nombre: 'Copa',
  categoria: 'SUB 9, SUB 12',
  status: 'PROGRAMADO',
  fechaInicio: '2026-12-05',
  fechaFin: '2026-12-13',
  equiposIds: [],
  categorias: categorias(2, 4),
  duracionTiempoMinutos: 20,
  duracionDescansoMinutos: 5,
  ...overrides,
  formato_config: {
    tipoTorneo: 'ROUND_ROBIN_CON_FINALES',
    horaInicioJornada: '08:30',
    tiemposPorPartido: 2,
    duracionTiempoMinutos: 20,
    duracionDescansoMinutos: 5,
    diasJuego: ['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13'],
    ...config,
  },
});

const minutos = (fecha: string) => {
  const [, hora] = fecha.split(' ');
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
};

describe('TournamentsService: calendario de partidos', () => {
  it('crea todo en una transacción', async () => {
    const { db, transaction } = createDb();
    await (await buildService(db)).createTournament(torneo() as any);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('separa los partidos 45 min y deja el último día solo para tercer lugar y final', async () => {
    const { db, partidos } = createDb();
    await (await buildService(db)).createTournament(torneo() as any);

    const porDia = new Map<string, Partido[]>();
    for (const partido of partidos) {
      const dia = partido.fecha.slice(0, 10);
      porDia.set(dia, [...(porDia.get(dia) ?? []), partido]);
    }

    for (const delDia of porDia.values()) {
      const horas = delDia.map((partido) => minutos(partido.fecha)).sort((a, b) => a - b);
      horas.forEach((hora, index) => expect(hora).toBe(8 * 60 + 30 + index * 45));
    }

    // 3 jornadas en 3 días de grupos: una jornada por día
    expect([...porDia.keys()]).toEqual(['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13']);
    const finales = porDia.get('2026-12-13')!;
    expect(finales.map((partido) => partido.fase)).toEqual([
      'TERCER_LUGAR',
      'TERCER_LUGAR',
      'FINAL',
      'FINAL',
    ]);
    expect(partidos.filter((partido) => partido.fase !== 'GRUPO').every((p) => p.fecha.startsWith('2026-12-13'))).toBe(true);
  });

  it('usa la duración real si el partido dura más de 45 min', async () => {
    const { db, partidos } = createDb();
    await (await buildService(db)).createTournament(
      torneo({}, { duracionTiempoMinutos: 25 }) as any,
    );
    const delPrimerDia = partidos
      .filter((partido) => partido.fecha.startsWith('2026-12-05'))
      .map((partido) => minutos(partido.fecha))
      .sort((a, b) => a - b);
    expect(delPrimerDia[1] - delPrimerDia[0]).toBe(55);
  });

  it('reparte las jornadas de forma pareja si hay menos días que jornadas', async () => {
    const { db, partidos } = createDb();
    await (await buildService(db)).createTournament(
      torneo(
        { categorias: categorias(2, 6), fechaFin: '2026-12-08' },
        { diasJuego: ['2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08'] },
      ) as any,
    );

    const grupos = partidos.filter((partido) => partido.fase === 'GRUPO');
    // 5 jornadas en 3 días: 2 + 2 + 1 (antes se amontonaban 4 en un día)
    for (const dia of ['2026-12-05', '2026-12-06', '2026-12-07']) {
      const jornadas = new Set(grupos.filter((p) => p.fecha.startsWith(dia)).map((p) => p.ronda));
      expect(jornadas.size).toBeLessThanOrEqual(2);
      // Ningún equipo juega más de 2 veces el mismo día
      const veces = new Map<number, number>();
      for (const partido of grupos.filter((p) => p.fecha.startsWith(dia))) {
        for (const equipo of [partido.local!, partido.visitante!]) veces.set(equipo, (veces.get(equipo) ?? 0) + 1);
      }
      expect(Math.max(...veces.values())).toBeLessThanOrEqual(2);
    }
  });

  it('rechaza días de juego fuera de las fechas del torneo', async () => {
    const { db, transaction } = createDb();
    await expect(
      (await buildService(db)).createTournament(
        torneo({}, { diasJuego: ['2026-11-01', '2026-12-13'] }) as any,
      ),
    ).rejects.toThrow('01/11/2026 está fuera de las fechas del torneo');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('exige al menos 2 días de juego (grupos + finales)', async () => {
    const { db } = createDb();
    await expect(
      (await buildService(db)).createTournament(torneo({}, { diasJuego: ['2026-12-05'] }) as any),
    ).rejects.toThrow('al menos 2 días de juego');
  });

  it('exige fecha de cierre posterior a la de inicio', async () => {
    const { db } = createDb();
    await expect(
      (await buildService(db)).createTournament(torneo({ fechaFin: '2026-12-01' }) as any),
    ).rejects.toThrow('no puede ser anterior');
  });

  it('avisa si los partidos de un día no caben antes de medianoche', async () => {
    const { db } = createDb();
    await expect(
      (await buildService(db)).createTournament(
        torneo({ categorias: categorias(2, 8) }, { horaInicioJornada: '20:00', diasJuego: ['2026-12-05', '2026-12-13'] }) as any,
      ),
    ).rejects.toThrow('no caben en el día');
  });
});

describe('TournamentsService: editar torneo', () => {
  const guardado = (gruposPorCategoria: any[]) => ({
    idTorneo: 9,
    banner: '/images/bannerEvento.jpg',
    formato_config: JSON.stringify({
      tipoTorneo: 'ROUND_ROBIN_CON_FINALES',
      fixturesPorCategoria: true,
      gruposPorCategoria,
    }),
  });

  function dbEdicion(partidosGuardados: any[]) {
    return createDb((sql) => {
      if (sql.startsWith('SELECT idTorneo, banner, formato_config')) {
        return [guardado(categorias(2, 4))];
      }
      if (sql.startsWith('SELECT idPartido, marcadorLocal, marcadorVisitante FROM Partidos')) {
        return partidosGuardados;
      }
      if (sql.startsWith('SELECT idEquipo FROM equiposTorneo')) return [];
      if (sql.includes('FROM Partidos') || sql.includes('FROM torneos')) return [];
      return undefined;
    });
  }

  it('no permite cambiar equipos si ya hay resultados', async () => {
    const { db, transaction } = dbEdicion([{ idPartido: 1, marcadorLocal: 2, marcadorVisitante: 1 }]);
    const cambiado = categorias(2, 4);
    cambiado[0].equiposIds[0] = 99;

    await expect(
      (await buildService(db)).updateTournament(9, torneo({ categorias: cambiado }) as any),
    ).rejects.toThrow('ya hay partidos con resultado');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('genera el calendario de nuevo si cambian los equipos y no hay resultados', async () => {
    const { db, partidos } = dbEdicion([{ idPartido: 1, marcadorLocal: null, marcadorVisitante: null }]);
    const cambiado = categorias(2, 4);
    cambiado[0].equiposIds[0] = 99;

    const result: any = await (await buildService(db)).updateTournament(
      9,
      torneo({ categorias: cambiado }) as any,
    );

    expect(result.calendarioRegenerado).toBe(true);
    expect(partidos.filter((partido) => partido.fase === 'GRUPO')).toHaveLength(12);
    expect(db.query.mock.calls.some(([sql]: any[]) => /DELETE FROM Partidos WHERE idTorneo/.test(sql))).toBe(true);
  });
});

describe('TournamentsService: editar sin tocar los partidos', () => {
  it('cambiar solo el nombre no modifica ni valida el calendario', async () => {
    const config = {
      tipoTorneo: 'ROUND_ROBIN_CON_FINALES',
      horaInicioJornada: '08:30',
      tiemposPorPartido: 2,
      duracionTiempoMinutos: 20,
      duracionDescansoMinutos: 5,
      // Torneo antiguo sin días de juego: no debe exigirlos para renombrarlo
      diasJuego: [],
      fixturesPorCategoria: true,
      gruposPorCategoria: categorias(2, 4),
    };
    const { db } = createDb((sql) => {
      if (sql.startsWith('SELECT idTorneo, banner, formato_config')) {
        return [{ idTorneo: 9, banner: '/images/bannerEvento.jpg', formato_config: JSON.stringify(config), fechaInicio: '2026-12-05', fechaFin: '2026-12-13' }];
      }
      if (sql.startsWith('SELECT idPartido, marcadorLocal')) return [{ idPartido: 1, marcadorLocal: 1, marcadorVisitante: 0 }];
      if (sql.startsWith('SELECT idEquipo FROM equiposTorneo')) return [];
      return undefined;
    });

    const result: any = await (await buildService(db)).updateTournament(
      9,
      torneo({ nombre: 'Copa renombrada' }, { diasJuego: [] }) as any,
    );

    expect(result.message).toBe('Torneo actualizado sin cambiar los partidos.');
    const tocaPartidos = db.query.mock.calls.some(([sql]: any[]) =>
      /(UPDATE|DELETE FROM|INSERT INTO) Partidos/.test(sql),
    );
    expect(tocaPartidos).toBe(false);
  });
});

describe('TournamentsService: sede', () => {
  async function sedeGuardada(dto: any) {
    let params: any[] = [];
    const { db } = createDb((sql, p) => {
      if (sql.includes('INSERT INTO torneos')) {
        params = p;
        return { insertId: 9 };
      }
      return undefined;
    });
    await (await buildService(db)).createTournament(dto);
    return params[2];
  }

  it('guarda la sede enviada en el campo sede', async () => {
    expect(await sedeGuardada(torneo({ sede: '  Club Bella Vista ' }))).toBe('Club Bella Vista');
  });

  it('usa formato_config.place si el formulario es antiguo', async () => {
    expect(await sedeGuardada(torneo({}, { place: 'Cancha Los Olivos' }))).toBe('Cancha Los Olivos');
  });

  it('guarda null si no hay sede', async () => {
    expect(await sedeGuardada(torneo())).toBeNull();
  });
});

describe('TournamentsService: goleadores', () => {
  it('devuelve los goleadores con la categoría del torneo y sin autogoles en la consulta', async () => {
    let sqlGoleadores = '';
    const { db } = createDb((sql) => {
      if (sql.includes('FROM torneos')) {
        return [{ idTorneo: 9, formato_config: JSON.stringify({ gruposPorCategoria: [{ categoria: 'SUB 9', equiposIds: [1] }] }) }];
      }
      if (sql.includes('FROM goles g')) {
        sqlGoleadores = sql;
        return [
          { idJugador: 7, nombre: 'Ana', apellido: 'Pérez', foto: null, idEquipo: 1, nombreEquipo: 'Leones', logoEquipo: null, categoriaEquipo: 'SUB-10', goles: '3' },
          { idJugador: 8, nombre: 'Luis', apellido: 'Gómez', foto: null, idEquipo: 2, nombreEquipo: 'Tigres', logoEquipo: null, categoriaEquipo: 'SUB 12', goles: '1' },
        ];
      }
      return undefined;
    });

    const goleadores: any[] = await (await buildService(db)).getTopScorers(9);

    expect(sqlGoleadores).toContain('esAutogol = 0');
    expect(goleadores.map((g) => [g.idJugador, g.categoria, g.goles])).toEqual([
      [7, 'SUB 9', 3],
      [8, 'SUB 12', 1],
    ]);
    expect(goleadores[0]).not.toHaveProperty('categoriaEquipo');
  });
});
