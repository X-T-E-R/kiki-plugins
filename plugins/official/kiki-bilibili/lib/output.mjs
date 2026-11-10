import { readDataUrl } from './transport.mjs';

export async function renderResult(result, imageIn) {
  const images = [];
  if (result.qr_image) images.push(result.qr_image);
  if (result.frames_sheet) images.push(result.frames_sheet);
  if (result.sheet) images.push(result.sheet);
  for (const frame of result.frames ?? result.visual?.frames ?? []) if (frame.path) images.push(frame.path);
  const output = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  if (imageIn) for (const file of images) {
    try { output.push({ type: 'image_url', imageUrl: { url: await readDataUrl(file) } }); }
    catch (error) { output.push({ type: 'text', text: `Image unavailable at ${file}: ${error.message}` }); }
  }
  return { output };
}
