import { readDataUrl } from './transport.mjs';

export async function renderResult(result, imageIn) {
  const images = result.qr_image ? [result.qr_image] : [];
  for (const frame of result.frames ?? result.visual?.frames ?? []) if (frame.path) images.push(frame.path);
  const output = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  if (imageIn) for (const file of images) {
    try { output.push({ type: 'image_url', imageUrl: { url: await readDataUrl(file) } }); }
    catch (error) { output.push({ type: 'text', text: `Image unavailable at ${file}: ${error.message}` }); }
  }
  return { output };
}
