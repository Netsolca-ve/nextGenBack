import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ImagePreset } from '../storage/image-presets';
import { StorageService } from '../storage/storage.service';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const FOLDER_PRESETS: Record<string, ImagePreset> = {
  teams: 'team',
  players: 'player',
  tournaments: 'tournament',
};

type UploadImageBody = {
  image?: string;
  folder?: string;
};

@Controller('uploads')
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  /**
   * Sube una imagen a `tmp/` de R2 (redimensionada y en WebP) y devuelve su
   * URL para la vista previa. Al guardar el equipo, jugador o torneo con esa
   * URL, el backend la mueve a su nombre definitivo.
   */
  @Post('image')
  async uploadImage(@Body() body: UploadImageBody) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
      body?.image ?? '',
    );

    if (!match) {
      throw new BadRequestException('La imagen debe ser PNG, JPG o WebP.');
    }

    const buffer = Buffer.from(match[2], 'base64');

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('La imagen no puede superar los 5 MB.');
    }

    const preset = FOLDER_PRESETS[body.folder ?? ''] ?? 'team';
    const key = await this.storage.uploadTemp(buffer, preset);

    return { key, url: this.storage.url(key) };
  }
}
