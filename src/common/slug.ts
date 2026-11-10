/**
 * Convierte un texto en slug para URLs y nombres de archivo:
 * "Almirantes FC Sub-12" → "almirantes-fc-sub-12".
 */
export function createSlug(text: string | null | undefined, fallback = 'item'): string {
  const slug = (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || fallback;
}
