import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type UploadImageBody = {
  image?: string;
  folder?: string;
};

@Controller('uploads')
export class UploadsController {
  @Post('image')
  uploadImage(@Body() body: UploadImageBody, @Req() request: Request) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
      body?.image ?? '',
    );

    if (!match) {
      throw new BadRequestException('La imagen debe ser PNG, JPG o WebP.');
    }

    const [, mimeType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('La imagen no puede superar los 5 MB.');
    }

    const folder = body.folder === 'players' ? 'players' : 'teams';
    const directory = join(process.cwd(), 'uploads', folder);
    mkdirSync(directory, { recursive: true });

    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${MIME_EXTENSIONS[mimeType]}`;
    writeFileSync(join(directory, filename), buffer);

    const baseUrl = `${request.protocol}://${request.get('host')}`;

    return {
      url: `${baseUrl}/uploads/${folder}/${filename}`,
    };
  }
}
