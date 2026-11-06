import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
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

  return { db: { query }, updates };
}

describe('TournamentsService', () => {
  let service: TournamentsService;
  let updates: Array<{ sql: string; params: any[] }>;

  beforeEach(async () => {
    const { db, updates: recorded } = createDb();
    updates = recorded;

    const module: TestingModule = await Test.createTestingModule({
      providers: [TournamentsService, { provide: DatabaseService, useValue: db }],
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
      providers: [TournamentsService, { provide: DatabaseService, useValue: db }],
    }).compile();
    const isolated = module.get<TournamentsService>(TournamentsService);

    await isolated.refreshDefinitoria(7);

    expect(recorded).toHaveLength(0);
  });
});
