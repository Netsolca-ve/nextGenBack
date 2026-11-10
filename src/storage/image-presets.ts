export type ImagePreset = 'team' | 'player' | 'tournament';

/**
 * Tamaño máximo (lado mayor, sin recortar) y calidad WebP por tipo de imagen.
 * Los banners de torneo se muestran a ancho completo, por eso son más grandes.
 */
export const IMAGE_PRESETS: Record<ImagePreset, { maxSize: number; quality: number }> = {
  team: { maxSize: 512, quality: 80 },
  player: { maxSize: 800, quality: 80 },
  tournament: { maxSize: 1600, quality: 80 },
};

/** Carpetas del bucket donde vive la imagen definitiva de cada entidad. */
export const imageKeys = {
  team: (teamSlug: string) => `equipos/${teamSlug}.webp`,
  player: (teamSlug: string, playerSlug: string, idJugador: number) =>
    `jugadores/${teamSlug}/${playerSlug}-${idJugador}.webp`,
  tournament: (tournamentSlug: string, idTorneo: number) =>
    `torneos/${tournamentSlug}-${idTorneo}.webp`,
};

/** Prefijo de las imágenes recién subidas que aún no se asignan a una entidad. */
export const TEMP_PREFIX = 'tmp/';
