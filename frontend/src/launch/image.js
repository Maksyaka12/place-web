// Logo and avatar uploads: the picked image is cut to a centred square and scaled to at most 512 px in the
// browser, so any photo fits the API's 600 KB pin limit. GIFs under the limit are kept as they are (animated).
import { placeApi } from '../place/api.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 600 * 1024;
const MAX_INPUT = 15 * 1024 * 1024;

const toBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(blob);
  });

async function squareWebp(file, size = 512) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(size, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) throw new Error('This browser could not convert the image');
  return blob;
}

/** Checks a picked file. Returns an error message, or null when it can be used. */
export function imageProblem(file) {
  if (!file) return 'Pick an image';
  if (!IMAGE_TYPES.includes(file.type)) return 'Use a PNG, JPG, WEBP or GIF image';
  if (file.size > MAX_INPUT) return 'The image is over 15 MB';
  return null;
}

/** Uploads an image to IPFS through the Place API and returns its ipfs:// URI. */
export async function uploadImage(file) {
  const problem = imageProblem(file);
  if (problem) throw new Error(problem);
  const keep = file.type === 'image/gif' && file.size <= MAX_BYTES;
  const blob = keep ? file : await squareWebp(file);
  if (blob.size > MAX_BYTES) throw new Error('The image is still over 600 KB after resizing; try a smaller one');
  const { uri } = await placeApi.pinImage({ data: await toBase64(blob), contentType: keep ? file.type : 'image/webp' });
  return uri;
}
