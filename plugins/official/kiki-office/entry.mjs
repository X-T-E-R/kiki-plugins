import { definitions } from './lib/definitions.mjs';
import { createOfficeCore } from './lib/office.mjs';
import { installPinnedBinary } from './lib/binary.mjs';

export const installPrerequisite = installPinnedBinary;

function previewLabel(data, file) {
  if (data.grid) {
    const span = data.pages ?? String(data.page ?? 1);
    return `Rendered contact sheet (pages ${span}, grid=${data.grid}) of ${file}.`;
  }
  if (data.pages) return `Rendered pages ${data.pages} of ${file}.`;
  if (data.range && data.page === undefined) return `Rendered range ${data.range} of ${file}.`;
  return `Rendered page ${data.page ?? 1} of ${file}.`;
}

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args, context) => {
      const core = createOfficeCore({
        scope: {
          workspaceRoot: context.workspaceRoot,
          approvedPaths: context.approvedPaths,
          binaryPath: context.settings?.officecliPath,
        },
      });
      const result = await core.run(definition.name, args, context);
      if (result.success && result.data?.image) {
        return {
          output: [
            { type: 'text', text: previewLabel(result.data, args.file) },
            { type: 'image_url', imageUrl: { url: result.data.image } },
          ],
        };
      }
      if (result.success && result.data?.html) return { output: result.data.html };
      return { output: result.success ? result.data?.text ?? result.data : JSON.stringify(result.error), isError: !result.success };
    });
  }
}
