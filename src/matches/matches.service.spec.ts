import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { TournamentsService } from '../tournaments/tournaments.service';
import { MatchesService } from './matches.service';

/**
 * El backend recibe la fecha del formulario de edición:
 * - 'YYYY-MM-DD' (input date heredado) → debe conservar la hora del partido.
 * - 'YYYY-MM-DDTHH:mm' (datetime-local) → se guarda con su hora, con segundos.
 */
describe('MatchesService.updateMatch (fecha)', () => {
  const MATCH = {
    idPartido: 1,
    idTorneo: 5,
    fecha: '2026-11-07 08:30:00',
    marcadorLocal: null,
    marcadorVisitante: null,
    status: 'programado',
  };

  let updates: Array<{ sql: string; params: any[] }>;
  let refreshMock: jest.Mock;

  async function buildService(match: Partial<typeof MATCH> = {}) {
    updates = [];
    refreshMock = jest.fn().mockResolvedValue({ actualizado: true });

    const db = {
      transaction: (work: () => Promise<unknown>) => work(),
      query: jest.fn(async (rawSql: string, params: any[] = []) => {
        const sql = rawSql.replace(/\s+/g, ' ').trim();

        if (sql.includes('UPDATE Partidos')) {
          updates.push({ sql, params });
          return { affectedRows: 1 };
        }
        if (sql.includes('FROM Partidos p')) {
          return [{ ...MATCH, ...match }];
        }
        return [];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MatchesService,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: { withUrls: (row: any) => row } },
        { provide: TournamentsService, useValue: { refreshDefinitoria: refreshMock } },
      ],
    }).compile();

    return module.get<MatchesService>(MatchesService);
  }

  it('conserva la hora guardada cuando solo llega la fecha (YYYY-MM-DD)', async () => {
    const service = await buildService();

    await service.updateMatch(1, { fecha: '2026-11-20' } as any);

    expect(updates).toHaveLength(1);
    expect(updates[0].params[0]).toBe('2026-11-20 08:30:00');
  });

  it('guarda fecha y hora cuando llegan en formato ISO (YYYY-MM-DDTHH:mm)', async () => {
    const service = await buildService();

    await service.updateMatch(1, { fecha: '2026-11-20T15:45' } as any);

    expect(updates).toHaveLength(1);
    expect(updates[0].params[0]).toBe('2026-11-20 15:45:00');
  });

  it('no cambia la hora cuando el partido no tenía una guardada', async () => {
    const service = await buildService({ fecha: '2026-11-07' });

    await service.updateMatch(1, { fecha: '2026-11-20' } as any);

    expect(updates[0].params[0]).toBe('2026-11-20 00:00:00');
  });

  it('refresca la fase definitoria automáticamente al guardar un resultado', async () => {
    const service = await buildService();

    await service.updateMatch(1, { marcadorLocal: 2, marcadorVisitante: 1, status: 'finalizado' } as any);

    expect(refreshMock).toHaveBeenCalledWith(5);
  });

  it('no refresca la fase definitoria al cambiar solo la fecha', async () => {
    const service = await buildService();

    await service.updateMatch(1, { fecha: '2026-11-20T10:00' } as any);

    expect(refreshMock).not.toHaveBeenCalled();
  });
});

/**
 * Reemplazo de un equipo a última hora desde el formulario de edición:
 * se actualizan los equipos, se limpian los registros del reemplazado y se
 * reacomoda la fase definitoria.
 */
describe('MatchesService.updateMatch (cambio de equipos)', () => {
  const MATCH = {
    idPartido: 1,
    idTorneo: 5,
    fecha: '2026-11-07 08:30:00',
    marcadorLocal: null,
    marcadorVisitante: null,
    status: 'programado',
    idEquipoLocal: 1,
    idEquipoVisitante: 2,
  };

  let updates: Array<{ sql: string; params: any[] }>;
  let deletes: Array<{ sql: string; params: any[] }>;
  let refreshMock: jest.Mock;

  async function buildService(match: Partial<typeof MATCH> = {}) {
    updates = [];
    deletes = [];
    refreshMock = jest.fn().mockResolvedValue({ actualizado: true });

    const db = {
      transaction: (work: () => Promise<unknown>) => work(),
      query: jest.fn(async (rawSql: string, params: any[] = []) => {
        const sql = rawSql.replace(/\s+/g, ' ').trim();

        if (sql.includes('UPDATE Partidos')) {
          updates.push({ sql, params });
          return { affectedRows: 1 };
        }
        if (sql.includes('FROM Partidos p')) {
          return [{ ...MATCH, ...match }];
        }
        if (sql.includes('SELECT idEquipo FROM equiposTorneo')) {
          return [{ idEquipo: 1 }, { idEquipo: 2 }, { idEquipo: 3 }];
        }
        if (sql.includes('SELECT nombre FROM equipos')) {
          return [{ nombre: 'Equipo Sorpresa' }];
        }
        if (sql.includes('DELETE FROM')) {
          deletes.push({ sql, params });
          return { affectedRows: 1 };
        }
        return [];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MatchesService,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: { withUrls: (row: any) => row } },
        { provide: TournamentsService, useValue: { refreshDefinitoria: refreshMock } },
      ],
    }).compile();

    return module.get<MatchesService>(MatchesService);
  }

  it('rechaza que el local y el visitante sean el mismo equipo', async () => {
    const service = await buildService();

    await expect(service.updateMatch(1, { idEquipoLocal: 2 } as any)).rejects.toThrow(
      'no pueden ser el mismo',
    );
    expect(updates).toHaveLength(0);
  });

  it('rechaza un equipo que no está inscrito en el torneo', async () => {
    const service = await buildService();

    await expect(service.updateMatch(1, { idEquipoLocal: 9 } as any)).rejects.toThrow(
      'no está inscrito en este torneo',
    );
    expect(updates).toHaveLength(0);
  });

  it('guarda el equipo nuevo, borra los registros del reemplazado y refresca la definitoria', async () => {
    const service = await buildService();

    await service.updateMatch(1, { idEquipoLocal: 3 } as any);

    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('idEquipoLocal = ?');
    expect(updates[0].params).toEqual([3, 1]);

    const borrados = deletes.map((item) => `${item.sql} ${JSON.stringify(item.params)}`);
    expect(borrados).toEqual([
      'DELETE FROM alineacionespartido WHERE idPartido = ? AND idEquipo = ? [1,1]',
      'DELETE FROM goles WHERE idPartido = ? AND idEquipo = ? [1,1]',
      'DELETE FROM sustitucionespartido WHERE idPartido = ? AND idEquipo = ? [1,1]',
      'DELETE FROM tarjetas WHERE idPartido = ? AND idEquipo = ? [1,1]',
    ]);
    expect(refreshMock).toHaveBeenCalledWith(5);
  });

  it('permite intercambiar local y visitante sin borrar ningún registro', async () => {
    const service = await buildService();

    await service.updateMatch(1, { idEquipoLocal: 2, idEquipoVisitante: 1 } as any);

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual([2, 1, 1]);
  });

  it('no toca los equipos cuando no se envían en el body', async () => {
    const service = await buildService();

    await service.updateMatch(1, { status: 'en_vivo' } as any);

    expect(deletes).toHaveLength(0);
    expect(updates[0].sql).not.toContain('idEquipoLocal');
  });
});

/**
 * Eliminación de un partido desde el panel de administración: se borran sus
 * registros dependientes antes del partido y, si era de grupos, se reacomoda
 * la fase definitoria.
 */
describe('MatchesService.deleteMatch', () => {
  let deletes: string[];
  let refreshMock: jest.Mock;

  async function buildService(match: Record<string, any> | null) {
    deletes = [];
    refreshMock = jest.fn().mockResolvedValue({ actualizado: true });

    const db = {
      transaction: (work: () => Promise<unknown>) => work(),
      query: jest.fn(async (rawSql: string, params: any[] = []) => {
        const sql = rawSql.replace(/\s+/g, ' ').trim();

        if (sql.includes('FROM Partidos p')) {
          return match ? [match] : [];
        }
        if (sql.startsWith('DELETE FROM')) {
          deletes.push(`${sql} ${JSON.stringify(params)}`);
          return { affectedRows: 1 };
        }
        return [];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MatchesService,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: { withUrls: (row: any) => row } },
        { provide: TournamentsService, useValue: { refreshDefinitoria: refreshMock } },
      ],
    }).compile();

    return module.get<MatchesService>(MatchesService);
  }

  it('borra goles, cambios y alineaciones antes del partido', async () => {
    const service = await buildService({ idPartido: 7, idTorneo: 5, fase: 'GRUPO' });

    const result = await service.deleteMatch(7);

    expect(deletes).toEqual([
      'DELETE FROM goles WHERE idPartido = ? [7]',
      'DELETE FROM tarjetas WHERE idPartido = ? [7]',
      'DELETE FROM sustitucionespartido WHERE idPartido = ? [7]',
      'DELETE FROM alineacionespartido WHERE idPartido = ? [7]',
      'DELETE FROM Partidos WHERE idPartido = ? [7]',
    ]);
    expect(result.message).toBe('Partido eliminado con éxito');
  });

  it('refresca la fase definitoria al eliminar un partido de grupos', async () => {
    const service = await buildService({ idPartido: 7, idTorneo: 5, fase: 'GRUPO' });

    await service.deleteMatch(7);

    expect(refreshMock).toHaveBeenCalledWith(5);
  });

  it('no refresca la definitoria al eliminar una final (no la recrea)', async () => {
    const service = await buildService({ idPartido: 9, idTorneo: 5, fase: 'FINAL' });

    await service.deleteMatch(9);

    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('responde 404 si el partido no existe y no borra nada', async () => {
    const service = await buildService(null);

    await expect(service.deleteMatch(99)).rejects.toThrow('no encontrado');
    expect(deletes).toHaveLength(0);
  });
});
