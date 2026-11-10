import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { IMAGE_PRESETS, ImagePreset, TEMP_PREFIX } from './image-presets';

/**
 * Resultado de asignar una imagen a una entidad. La BD se actualiza con `key`;
 * después se llama a `commit` (borra lo que quedó obsoleto) o, si falló el
 * guardado, a `rollback` (borra la copia nueva).
 */
export type ImageChange = {
  key: string | null;
  written: string | null;
  obsolete: string[];
};

/**
 * Imágenes en Cloudflare R2 (API compatible con S3).
 *
 * En la BD se guarda solo la key (ej. `equipos/almirantes-fc.webp`); la URL
 * pública se arma con R2_PUBLIC_URL, así cambiar de dominio solo toca esa
 * variable.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(config: ConfigService) {
    const accountId = config.get<string>('R2_ACCOUNT_ID', '');

    this.bucket = config.get<string>('R2_BUCKET', '');
    this.publicBaseUrl = config.get<string>('R2_PUBLIC_URL', '').replace(/\/+$/, '');
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get<string>('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: config.get<string>('R2_SECRET_ACCESS_KEY', ''),
      },
    });

    if (!accountId || !this.bucket || !this.publicBaseUrl) {
      this.logger.warn(
        'Faltan variables de R2 (R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_URL): la subida de imágenes fallará.',
      );
    }
  }

  // ==========================================
  // URLS Y KEYS
  // ==========================================

  /** URL pública de lo guardado en la BD. Rutas absolutas o URLs se devuelven tal cual. */
  url(value: string | null | undefined): string | null {
    if (!value) return null;
    if (!this.isManagedKey(value)) return value;
    return `${this.publicBaseUrl}/${value}`;
  }

  /** Copia de una fila con las columnas indicadas convertidas a URL pública. */
  withUrls<T extends Record<string, any>>(row: T, ...columns: (keyof T)[]): T {
    if (!row) return row;
    const copy: Record<string, any> = { ...row };
    for (const column of columns) {
      copy[column as string] = this.url(row[column]);
    }
    return copy as T;
  }

  /** Pasa lo que llega del front (URL pública o key) a key. '' → null. */
  toKey(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (this.publicBaseUrl && trimmed.startsWith(`${this.publicBaseUrl}/`)) {
      return decodeURIComponent(trimmed.slice(this.publicBaseUrl.length + 1).split('?')[0]);
    }
    return trimmed || null;
  }

  /** Una key de R2 no tiene esquema ni empieza por "/" (esas son rutas del front). */
  isManagedKey(value: string | null | undefined): value is string {
    return !!value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('/');
  }

  isTempKey(value: string | null | undefined): value is string {
    return this.isManagedKey(value) && value.startsWith(TEMP_PREFIX);
  }

  // ==========================================
  // PROCESADO Y SUBIDA
  // ==========================================

  /** Redimensiona (sin agrandar ni recortar) y convierte a WebP. */
  async processImage(input: Buffer, preset: ImagePreset): Promise<Buffer> {
    const { maxSize, quality } = IMAGE_PRESETS[preset];

    try {
      return await sharp(input)
        .rotate() // respeta la orientación EXIF de las fotos de móvil
        .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
    } catch {
      throw new BadRequestException('No se pudo procesar la imagen.');
    }
  }

  /**
   * Procesa y sube una imagen a `tmp/`. Queda ahí hasta que se guarda la
   * entidad (equipo, jugador, torneo), que la mueve a su nombre definitivo.
   */
  async uploadTemp(input: Buffer, preset: ImagePreset): Promise<string> {
    const body = await this.processImage(input, preset);
    const key = `${TEMP_PREFIX}${preset}/${randomUUID()}.webp`;
    await this.put(key, body);
    return key;
  }

  async put(key: string, body: Buffer, contentType = 'image/webp') {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Las keys definitivas se reutilizan al cambiar la imagen: el navegador
        // revalida con ETag en vez de mostrar la versión vieja.
        CacheControl: 'public, no-cache',
      }),
    );
  }

  async copy(fromKey: string, toKey: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
        Key: toKey,
        ContentType: 'image/webp',
        CacheControl: 'public, no-cache',
        MetadataDirective: 'REPLACE',
      }),
    );
  }

  /** Borra objetos de R2. Ignora valores que no son keys y no lanza error si falla. */
  async delete(...keys: (string | null | undefined)[]) {
    const unique = [...new Set(keys.filter((key) => this.isManagedKey(key)))] as string[];

    for (const key of unique) {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (error) {
        this.logger.warn(
          `No se pudo borrar ${key} de R2: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  // ==========================================
  // ASIGNAR IMAGEN A UNA ENTIDAD
  // ==========================================

  /**
   * Decide qué key guardar para la imagen de una entidad y deja el objeto en
   * `targetKey` (el nombre que corresponde a su nombre actual).
   *
   * - `incoming` undefined: no se envió → se conserva la actual (renombrándola
   *   si cambió el nombre de la entidad).
   * - null / '': se quita la imagen.
   * - key temporal: imagen nueva recién subida.
   * - la key actual (o su URL pública): sin cambios, salvo renombrado.
   * - otra key definitiva de R2: se ignora y se conserva la actual.
   * - cualquier otra cosa (URL externa, ruta del front): se guarda tal cual.
   */
  async assignImage(params: {
    incoming: string | null | undefined;
    currentKey: string | null | undefined;
    targetKey: string;
  }): Promise<ImageChange> {
    const currentKey = params.currentKey || null;
    let incoming = params.incoming === undefined ? currentKey : this.toKey(params.incoming);
    const { targetKey } = params;
    const managedCurrent = this.isManagedKey(currentKey) ? currentKey : null;

    // Una key definitiva que no es la actual (ej. la URL vieja de un formulario
    // abierto antes de un renombrado) no se acepta: se conserva la actual.
    if (this.isManagedKey(incoming) && !this.isTempKey(incoming) && incoming !== currentKey) {
      incoming = currentKey;
    }

    if (!incoming) {
      return { key: null, written: null, obsolete: managedCurrent ? [managedCurrent] : [] };
    }

    if (this.isTempKey(incoming) || (incoming === managedCurrent && incoming !== targetKey)) {
      await this.copy(incoming, targetKey);
      return {
        key: targetKey,
        // Si se pisó la imagen actual (misma key) ya no hay nada que deshacer.
        written: targetKey !== managedCurrent ? targetKey : null,
        obsolete: [...new Set([incoming, managedCurrent])].filter(
          (key): key is string => !!key && key !== targetKey,
        ),
      };
    }

    return {
      key: incoming,
      written: null,
      obsolete: managedCurrent && managedCurrent !== incoming ? [managedCurrent] : [],
    };
  }

  /** Tras guardar en la BD: borra la imagen temporal y la anterior. */
  commit(change: ImageChange | null | undefined) {
    return change ? this.delete(...change.obsolete) : Promise.resolve();
  }

  /** Si falló el guardado en la BD: borra la copia nueva (si no pisó a la actual). */
  rollback(change: ImageChange | null | undefined) {
    return change?.written ? this.delete(change.written) : Promise.resolve();
  }
}
