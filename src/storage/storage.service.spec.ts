import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { StorageService } from './storage.service';

const PUBLIC_URL = 'https://pub-test.r2.dev';

function buildService() {
  const env: Record<string, string> = {
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'nextgen-media',
    R2_PUBLIC_URL: `${PUBLIC_URL}/`,
  };
  const config = { get: (name: string, fallback?: string) => env[name] ?? fallback };
  const service = new StorageService(config as unknown as ConfigService);

  const sent: Array<{ command: string; input: any }> = [];
  (service as any).client = {
    send: jest.fn(async (command: any) => {
      sent.push({ command: command.constructor.name, input: command.input });
      return {};
    }),
  };

  return { service, sent };
}

describe('StorageService', () => {
  it('arma la URL pública solo para keys de R2', () => {
    const { service } = buildService();

    expect(service.url('equipos/alpha.webp')).toBe(`${PUBLIC_URL}/equipos/alpha.webp`);
    expect(service.url('/images/bannerEvento.jpg')).toBe('/images/bannerEvento.jpg');
    expect(service.url('https://otro.com/a.png')).toBe('https://otro.com/a.png');
    expect(service.url(null)).toBeNull();
  });

  it('convierte la URL pública de vuelta a key', () => {
    const { service } = buildService();

    expect(service.toKey(`${PUBLIC_URL}/equipos/alpha.webp`)).toBe('equipos/alpha.webp');
    expect(service.toKey('equipos/alpha.webp')).toBe('equipos/alpha.webp');
    expect(service.toKey('')).toBeNull();
  });

  it('procesa a WebP sin pasar del tamaño máximo', async () => {
    const { service } = buildService();
    const png = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: '#f00' },
    })
      .png()
      .toBuffer();

    const output = await service.processImage(png, 'team');
    const meta = await sharp(output).metadata();

    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(256);
  });

  describe('assignImage', () => {
    it('imagen nueva: copia la temporal a su nombre y luego borra temporal y anterior', async () => {
      const { service, sent } = buildService();

      const change = await service.assignImage({
        incoming: `${PUBLIC_URL}/tmp/team/abc.webp`,
        currentKey: 'equipos/viejo.webp',
        targetKey: 'equipos/nuevo.webp',
      });

      expect(change.key).toBe('equipos/nuevo.webp');
      expect(sent).toEqual([
        {
          command: 'CopyObjectCommand',
          input: expect.objectContaining({
            CopySource: 'nextgen-media/tmp/team/abc.webp',
            Key: 'equipos/nuevo.webp',
          }),
        },
      ]);

      await service.commit(change);
      expect(sent.slice(1).map((entry) => entry.input.Key)).toEqual([
        'tmp/team/abc.webp',
        'equipos/viejo.webp',
      ]);
    });

    it('renombrado: mueve la imagen actual si cambió el nombre', async () => {
      const { service, sent } = buildService();

      const change = await service.assignImage({
        incoming: undefined,
        currentKey: 'equipos/alpha.webp',
        targetKey: 'equipos/alpha-fc.webp',
      });

      expect(change).toEqual({
        key: 'equipos/alpha-fc.webp',
        written: 'equipos/alpha-fc.webp',
        obsolete: ['equipos/alpha.webp'],
      });
      expect(sent[0].command).toBe('CopyObjectCommand');
    });

    it('sin cambios: no toca R2', async () => {
      const { service, sent } = buildService();

      const change = await service.assignImage({
        incoming: `${PUBLIC_URL}/equipos/alpha.webp`,
        currentKey: 'equipos/alpha.webp',
        targetKey: 'equipos/alpha.webp',
      });

      expect(change).toEqual({ key: 'equipos/alpha.webp', written: null, obsolete: [] });
      expect(sent).toHaveLength(0);
    });

    it('URL vieja de R2 (formulario desactualizado): conserva la imagen actual', async () => {
      const { service, sent } = buildService();

      const change = await service.assignImage({
        incoming: `${PUBLIC_URL}/equipos/alpha.webp`,
        currentKey: 'equipos/alpha-fc.webp',
        targetKey: 'equipos/alpha-fc.webp',
      });

      expect(change).toEqual({ key: 'equipos/alpha-fc.webp', written: null, obsolete: [] });
      expect(sent).toHaveLength(0);
    });

    it('quitar la imagen: guarda null y borra la anterior', async () => {
      const { service } = buildService();

      const change = await service.assignImage({
        incoming: '',
        currentKey: 'equipos/alpha.webp',
        targetKey: 'equipos/alpha.webp',
      });

      expect(change).toEqual({ key: null, written: null, obsolete: ['equipos/alpha.webp'] });
    });

    it('reemplazo con la misma key: el rollback no borra la imagen actual', async () => {
      const { service, sent } = buildService();

      const change = await service.assignImage({
        incoming: 'tmp/team/abc.webp',
        currentKey: 'equipos/alpha.webp',
        targetKey: 'equipos/alpha.webp',
      });
      await service.rollback(change);

      expect(change.obsolete).toEqual(['tmp/team/abc.webp']);
      expect(sent.map((entry) => entry.command)).toEqual(['CopyObjectCommand']);
    });
  });
});
