import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { TeamsService } from './teams.service';

describe('TeamsService', () => {
  let service: TeamsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TeamsService, { provide: DatabaseService, useValue: { query: jest.fn() } }, { provide: StorageService, useValue: {} }],
    }).compile();

    service = module.get<TeamsService>(TeamsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('TeamsService.updateTeam (logo en R2)', () => {
  it('reemplazar el logo con la misma key confirma el cambio y borra la temporal', async () => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM equipos WHERE idEquipo')) {
          return [{ idEquipo: 1, nombre: 'Alpha', slug: 'alpha', logo: 'equipos/alpha.webp' }];
        }
        return [];
      }),
    };
    const change = {
      key: 'equipos/alpha.webp',
      written: null,
      obsolete: ['tmp/team/nuevo.webp'],
    };
    const storage = {
      assignImage: jest.fn().mockResolvedValue(change),
      commit: jest.fn().mockResolvedValue(undefined),
      url: (key: string) => `https://cdn.test/${key}`,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamsService,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    const result = await module.get(TeamsService).updateTeam(1, { logo: 'tmp/team/nuevo.webp' });

    expect(storage.assignImage).toHaveBeenCalledWith({
      incoming: 'tmp/team/nuevo.webp',
      currentKey: 'equipos/alpha.webp',
      targetKey: 'equipos/alpha.webp',
    });
    expect(storage.commit).toHaveBeenCalledWith(change);
    expect(result).toEqual({
      message: 'Equipo actualizado con éxito',
      slug: 'alpha',
      logo: 'https://cdn.test/equipos/alpha.webp',
    });
  });
});
