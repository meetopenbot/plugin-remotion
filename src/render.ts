import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

export type RenderResult = {
  outputLocation: string;
  durationInFrames: number;
};

/**
 * Render a Remotion project from a custom entry point.
 */
export async function renderVideo(
  entryPoint: string,
  compositionId: string,
  outDir: string,
  inputProps: Record<string, any> = {},
  onProgress?: (progress: number) => void,
): Promise<RenderResult> {
  const serveUrl = await bundle({ entryPoint });

  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
  });

  const outputLocation = path.join(outDir, `remotion-${Date.now()}.mp4`);

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation,
    inputProps,
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
  });

  return { outputLocation, durationInFrames: composition.durationInFrames };
}
