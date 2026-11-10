import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';

// StorageService real sin credenciales: los tests no suben imágenes a R2
const storageStub = new StorageService({
  get: (_name: string, fallback?: string) => fallback || 'test',
} as any);
import { TournamentsService } from './tournaments.service';

const FORMATO_CONFIG = JSON.stringify({
  tipoTorneo: 'ROUND_ROBIN_CON_FINALES',
  fases: { fase1: { puntuacion: { victoria: 3, empate: 1, derrota: 0 } } },
});

/**
 * Resultados de una fase de grupos de 4 equipos (A=1, B=2, C=3, D=4) donde
 * cada uno le gana al que sigue: A 9 pts, B 6, C 3, D 0.
 */
const GRUPOS = [
  { idPartido: 1, idEquipoLocal: 1, idEquipoVisitante: 2, marcadorLocal: 1, marcadorVisitante: 0 },
  { idPartido: 2, idEquipoLocal: 3, idEquipoVisitante: 4, marcadorLocal: 1, marcadorVisitante: 0 },
  { idPartido: 3, idEquipoLocal: 1, idEquipoVisitante: 3, marcadorLocal: 1, marcadorVisitante: 0 },
  { idPartido: 4, idEquipoLocal: 2, idEquipoVisitante: 4, marcadorLocal: 1, marcadorVisitante: 0 },
  { idPartido: 5, idEquipoLocal: 1, idEquipoVisitante: 4, marcadorLocal: 1, marcadorVisitante: 0 },
  { idPartido: 6, idEquipoLocal: 2, idEquipoVisitante: 3, marcadorLocal: 1, marcadorVisitante: 0 },
];

function createDb() {
  const updates: Array<{ sql: string; params: any[] }> = [];

  const query = jest.fn(async (rawSql: string, params: any[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    if (sql.includes('UPDATE Partidos')) {
      updates.push({ sql, params });
      return { affectedRows: 1 };
    }
    if (sql.includes('FROM torneos')) {
      return [
        {
          idTorneo: 7,
          nombre: 'Torneo piloto',
          formato_config: FORMATO_CONFIG,
          fechaInicio: '2026-11-07',
          fechaFin: '2026-11-15',
        },
      ];
    }
    if (sql.includes('et.idEquipo')) {
      return [1, 2, 3, 4].map((id) => ({ idEquipo: id, nombre: `Equipo ${id}`, siglas: `E${id}` }));
    }
    if (sql.includes('numeroRonda, fecha')) {
      return GRUPOS.map((match, index) => ({
        idPartido: match.idPartido,
        numeroRonda: Math.floor(index / 2) + 1,
        fecha: '2026-11-07',
      }));
    }
    if (sql.includes("SELECT fase FROM Partidos")) {
      return [{ fase: 'TERCER_LUGAR' }, { fase: 'FINAL' }];
    }
    if (sql.includes('SELECT * FROM Partidos')) {
      // La final quedó con marcador 0-0 pero SIN equipos (el bug reportado);
      // el partido por el tercer lugar quedó vacío y sin marcador
      return [
        { idPartido: 100, fase: 'TERCER_LUGAR', idEquipoLocal: null, idEquipoVisitante: null, marcadorLocal: null, marcadorVisitante: null },
        { idPartido: 101, fase: 'FINAL', idEquipoLocal: null, idEquipoVisitante: null, marcadorLocal: 0, marcadorVisitante: 0 },
      ];
    }
    if (sql.includes('idEquipoLocal, idEquipoVisitante')) {
      return GRUPOS.map(({ idEquipoLocal, idEquipoVisitante, marcadorLocal, marcadorVisitante }) => ({
        idEquipoLocal,
        idEquipoVisitante,
        marcadorLocal,
        marcadorVisitante,
      }));
    }
    if (sql.includes('marcadorLocal IS NOT NULL')) {
      return GRUPOS.map((match) => ({ idPartido: match.idPartido }));
    }
    if (sql.includes('FROM Partidos p')) {
      return [];
    }
    return [];
  });

  return { db: { query, transaction: (work: () => Promise<unknown>) => work() }, updates };
}

describe('TournamentsService', () => {
  let service: TournamentsService;
  let updates: Array<{ sql: string; params: any[] }>;

  beforeEach(async () => {
    const { db, updates: recorded } = createDb();
    updates = recorded;

    const module: TestingModule = await Test.createTestingModule({
      providers: [TournamentsService, { provide: DatabaseService, useValue: db }, { provide: StorageService, useValue: storageStub }],
    }).compile();

    service = module.get<TournamentsService>(TournamentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('asigna la final y el tercer lugar cuando todos los grupos están finalizados', async () => {
    const result: any = await service.refreshDefinitoria(7);

    expect(result.actualizado).toBe(true);

    const final = updates.find((update) => update.params[2] === 101);
    const tercerLugar = updates.find((update) => update.params[2] === 100);

    // 1° (A) vs 2° (B) en la final y 3° (C) vs 4° (D) por el tercer lugar
    expect(final?.params.slice(0, 2)).toEqual([1, 2]);
    expect(tercerLugar?.params.slice(0, 2)).toEqual([3, 4]);
  });

  it('limpia el marcador de un registro que tiene resultado pero no equipos', async () => {
    await service.refreshDefinitoria(7);

    const final = updates.find((update) => update.params[2] === 101);
    const tercerLugar = updates.find((update) => update.params[2] === 100);

    // La final venía con 0-0 sin equipos: el marcador es inválido y se limpia
    expect(final?.sql).toContain('marcadorLocal = NULL');
    expect(final?.sql).toContain("status = 'programado'");

    // El tercer lugar no tenía marcador: solo se le asignan los equipos
    expect(tercerLugar?.sql).not.toContain('marcadorLocal = NULL');
  });

  it('no toca un partido definitorio que ya tiene equipos y resultado', async () => {
    const { db, updates: recorded } = createDb();
    const baseQuery = db.query as jest.Mock;

    db.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('SELECT * FROM Partidos')) {
        return [
          { idPartido: 100, fase: 'TERCER_LUGAR', idEquipoLocal: 3, idEquipoVisitante: 4, marcadorLocal: 2, marcadorVisitante: 1 },
          { idPartido: 101, fase: 'FINAL', idEquipoLocal: 1, idEquipoVisitante: 2, marcadorLocal: 1, marcadorVisitante: 0 },
        ];
      }
      return baseQuery(sql, params);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [TournamentsService, { provide: DatabaseService, useValue: db }, { provide: StorageService, useValue: storageStub }],
    }).compile();
    const isolated = module.get<TournamentsService>(TournamentsService);

    await isolated.refreshDefinitoria(7);

    expect(recorded).toHaveLength(0);
  });
});

describe('TournamentsService (torneos multi-categoría)', () => {
  const DTO_MULTI = {
    nombre: 'Copa Mixta',
    categoria: 'SUB 9, SUB 12',
    status: 'PROGRAMADO',
    fechaInicio: '2026-11-07',
    fechaFin: '2026-11-08',
    equiposIds: [1, 2, 3, 4, 5, 6, 7, 8],
    formato_config: {
      tipoTorneo: 'ROUND_ROBIN_CON_FINALES',
      horaInicioJornada: '08:30',
      categoriasHabilitadas: ['SUB 9', 'SUB 12'],
      diasJuego: ['2026-11-07', '2026-11-08'],
    },
    categorias: [
      { categoria: 'SUB 9', equiposIds: [1, 2, 3, 4] },
      { categoria: 'SUB 12', equiposIds: [5, 6, 7, 8] },
    ],
  } as any;

  function createService() {
    const insertsPartido: any[][] = [];
    const updatesTorneo: any[][] = [];
    let idPartido = 500;

    const query = jest.fn(async (rawSql: string, params: any[] = []) => {
      const sql = rawSql.replace(/\s+/g, ' ').trim();

      if (sql.includes('INSERT INTO torneos')) {
        return { insertId: 77 };
      }
      if (sql.includes('INSERT INTO Partidos')) {
        insertsPartido.push(params);
        return { insertId: ++idPartido };
      }
      if (sql.includes('UPDATE torneos SET formato_config')) {
        updatesTorneo.push(params);
        return { affectedRows: 1 };
      }
      if (sql.includes('INSERT INTO equiposTorneo')) {
        return { insertId: 1 };
      }
      return [];
    });

    return {
      db: { query, transaction: (work: () => Promise<unknown>) => work() },
      insertsPartido,
      updatesTorneo,
    };
  }

  async function buildService(db: any) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TournamentsService, { provide: DatabaseService, useValue: db }, { provide: StorageService, useValue: storageStub }],
    }).compile();
    return module.get<TournamentsService>(TournamentsService);
  }

  it('genera un fixture independiente por categoría (nunca cruzan SUB 9 con SUB 12)', async () => {
    const { db, insertsPartido } = createService();
    const service = await buildService(db);

    const result: any = await service.createTournament(DTO_MULTI);

    // Fase de grupos: 6 partidos por categoría (4 equipos, todos contra todos)
    expect(result.partidosGruposGenerados).toBe(12);
    // Un par de definitoria (final + tercer lugar) por categoría
    expect(result.partidosDefinitoria).toBe(4);
    expect(result.categorias).toBe(2);

    // INSERT: [idTorneo, fase, ronda, local, visitante, duración, descanso, fecha]
    const grupoParams = insertsPartido.filter((params) => params[1] === 'GRUPO');
    expect(grupoParams).toHaveLength(12);
    const sub9 = new Set([1, 2, 3, 4]);
    const sub12 = new Set([5, 6, 7, 8]);

    for (const params of grupoParams) {
      const local = params[3];
      const visitante = params[4];
      const enSub9 = sub9.has(local) && sub9.has(visitante);
      const enSub12 = sub12.has(local) && sub12.has(visitante);
      // Cada partido debe quedar completamente dentro de una categoría
      expect(enSub9 || enSub12).toBe(true);
    }
  });

  it('escribe las fechas como "YYYY-MM-DD HH:MM:SS" (sin objetos Date)', async () => {
    const { db, insertsPartido } = createService();
    const service = await buildService(db);

    await service.createTournament(DTO_MULTI);

    for (const params of insertsPartido) {
      const fecha = params[params.length - 1];
      expect(typeof fecha).toBe('string');
      expect(fecha).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }

    // El primer partido del día de inicio queda a la hora de inicio (08:30)
    expect(insertsPartido[0][7]).toBe('2026-11-07 08:30:00');
    // La fase definitoria se juega en el último día de juego
    const definitorias = insertsPartido.filter((params) => params[1] !== 'GRUPO');
    expect(definitorias).toHaveLength(4);
    for (const params of definitorias) {
      expect(params[7]).toMatch(/^2026-11-08 \d{2}:\d{2}:\d{2}$/);
    }
  });

  it('guarda grupos y mapeo de la fase definitoria en formato_config', async () => {
    const { db, updatesTorneo } = createService();
    const service = await buildService(db);

    await service.createTournament(DTO_MULTI);

    // El torneo se guarda con las claves del servidor...
    expect(updatesTorneo).toHaveLength(1);
    const config = JSON.parse(updatesTorneo[0][0]);
    expect(config.fixturesPorCategoria).toBe(true);
    expect(config.gruposPorCategoria).toHaveLength(2);
    expect(config.gruposPorCategoria[0]).toEqual({ categoria: 'SUB 9', equiposIds: [1, 2, 3, 4] });
    // ...y el mapeo de finales por categoría se agrega al crearlas
    expect(config.definitoriaPorCategoria).toHaveLength(2);
    expect(config.definitoriaPorCategoria.map((fila: any) => fila.categoria)).toEqual(['SUB 9', 'SUB 12']);
    for (const fila of config.definitoriaPorCategoria) {
      expect(fila.idTercerLugar).toEqual(expect.any(Number));
      expect(fila.idFinal).toEqual(expect.any(Number));
    }
  });

  it('rechaza un equipo inscrito en dos categorías', async () => {
    const { db } = createService();
    const service = await buildService(db);

    await expect(
      service.createTournament({
        ...DTO_MULTI,
        categorias: [
          { categoria: 'SUB 9', equiposIds: [1, 2, 3, 4] },
          { categoria: 'SUB 12', equiposIds: [4, 6, 7, 8] },
        ],
      }),
    ).rejects.toThrow(/dos categorías/);
  });

  it('rechaza una categoría con menos de 4 equipos', async () => {
    const { db } = createService();
    const service = await buildService(db);

    await expect(
      service.createTournament({
        ...DTO_MULTI,
        categorias: [
          { categoria: 'SUB 9', equiposIds: [1, 2, 3, 4] },
          { categoria: 'SUB 12', equiposIds: [5, 6, 7] },
        ],
      }),
    ).rejects.toThrow(/al menos 4 equipos/);
  });
});
