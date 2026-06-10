import { generateText, tool, stepCountIs, hasToolCall } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderVideo } from './render.js';
import { AVAILABLE_PACKAGES, ensureProjectDeps } from './remotion-deps.js';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type AgentEmit = (event: { kind: 'status' | 'tool'; text: string, title?: string }) => void;

export type LlmProvider = 'openai' | 'anthropic';

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
};

type ApiKeys = {
  openaiApiKey?: string;
  anthropicApiKey?: string;
};

function pickKey(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function readVariable(
  variables: Record<string, string | { value?: string } | undefined> | undefined,
  key: string,
): string | undefined {
  const value = variables?.[key];
  return typeof value === 'string' ? value : value?.value;
}

export function resolveApiKeys(sources: {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  variables?: Record<string, string | { value?: string } | undefined>;
}): ApiKeys {
  return {
    openaiApiKey: pickKey(
      sources.openaiApiKey,
      process.env.OPENAI_API_KEY,
      readVariable(sources.variables, 'OPENAI_API_KEY'),
    ),
    anthropicApiKey: pickKey(
      sources.anthropicApiKey,
      process.env.ANTHROPIC_API_KEY,
      readVariable(sources.variables, 'ANTHROPIC_API_KEY'),
    ),
  };
}

export function resolveProvider(
  provider?: string,
  model?: string,
  keys?: ApiKeys,
): LlmProvider {
  if (provider === 'anthropic' || provider === 'openai') return provider;

  const envProvider = pickKey(process.env.LLM_PROVIDER, process.env.REMOTION_LLM_PROVIDER);
  if (envProvider === 'anthropic' || envProvider === 'openai') return envProvider;

  if (model?.startsWith('claude')) return 'anthropic';
  if (model?.startsWith('gpt')) return 'openai';

  if (keys) {
    const hasOpenai = Boolean(keys.openaiApiKey);
    const hasAnthropic = Boolean(keys.anthropicApiKey);
    if (hasAnthropic && !hasOpenai) return 'anthropic';
    if (hasOpenai && !hasAnthropic) return 'openai';
  }

  return 'openai';
}

export function resolveCredentials(sources: {
  provider?: string;
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  variables?: Record<string, string | { value?: string } | undefined>;
}) {
  const { openaiApiKey, anthropicApiKey } = resolveApiKeys(sources);
  const provider = resolveProvider(sources.provider, sources.model, {
    openaiApiKey,
    anthropicApiKey,
  });
  const apiKey = provider === 'anthropic' ? anthropicApiKey : openaiApiKey;

  return {
    provider,
    apiKey,
    model: sources.model || DEFAULT_MODELS[provider],
    openaiApiKey,
    anthropicApiKey,
  };
}

export type RunVideoAgentArgs = {
  prompt: string;
  apiKey?: string;
  provider?: LlmProvider;
  outDir: string;
  model?: string;
  maxSteps?: number;
  emit?: AgentEmit;
};

export type RunVideoAgentResult = {
  text: string;
  videoPath?: string;
  durationInFrames?: number;
};

const SKILLS_LIST = [
  '3d', 'audio-visualization', 'audio', 'calculate-metadata', 'compositions', 
  'display-captions', 'ffmpeg', 'get-audio-duration', 'get-video-dimensions', 
  'get-video-duration', 'gifs', 'google-fonts', 'html-in-canvas', 'images', 
  'import-srt-captions', 'light-leaks', 'local-fonts', 'lottie', 'maplibre', 
  'measuring-dom-nodes', 'measuring-text', 'parameters', 'sequencing', 'sfx', 
  'silence-detection', 'subtitles', 'tailwind', 'text-animations', 'timing', 
  'transcribe-captions', 'transitions', 'transparent-videos', 'trimming', 
  'videos', 'voiceover'
] as const;

const SYSTEM_PROMPT = `You are a motion-graphics director and expert Remotion developer.
You turn a natural-language brief into a high-quality video by writing React code using Remotion.

Workflow:
1. **Explore**: Call list_files to see what's in the project. Use read_file to inspect existing source files, package.json, or errors from prior runs.
2. **Learn**: If you are unsure about a Remotion API, call search_docs to get information from the official Remotion documentation.
3. **Skills**: You have access to specialized Remotion skills. If you are working on a specific feature (like audio, transitions, or complex animations) and need deeper knowledge, call the 'get_skill' tool with one of these names: ${SKILLS_LIST.join(', ')}.
4. **Code**: Write the video code to the filesystem using write_file. 
   - You MUST create an entry point (usually index.ts) that calls registerRoot.
   - You MUST create a Root component (e.g., Root.tsx) that defines your <Composition />.
   - You can create as many helper components as you need.
   - Use standard Remotion APIs: Composition, AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig.
5. **Render**: Call render to produce the mp4. You must specify the entryPoint (e.g., "index.ts") and the compositionId you defined in your Root.
6. **Iterate**: If render fails, read the error (which often contains compiler or runtime errors), fix your code, and try again.
7. **Finalize**: Call finish once the video has rendered successfully and you are happy with the result.

Guidelines:
- **Visual Quality**: Create modern, beautiful UI/UX. Use gradients, shadows, and smooth animations.
- **Animations**: Use spring() for natural movement and interpolate() for transitions.
- **Assets**: You can use external image URLs if provided in the prompt.
- **Libraries**: These packages are pre-installed in the project — import them directly, no install step needed: ${AVAILABLE_PACKAGES.join(', ')}.
- **Entry Point Example**:
  \`\`\`typescript
  import { registerRoot } from 'remotion';
  import { RemotionRoot } from './Root';
  registerRoot(RemotionRoot);
  \`\`\`
- **Root Example**:
  \`\`\`tsx
  import { Composition } from 'remotion';
  import { MyVideo } from './MyVideo';
  export const RemotionRoot = () => (
    <Composition
      id="MyVideo"
      component={MyVideo}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
    />
  );
  \`\`\`
`;

const FALLBACK_CORE_SKILL = `
## Remotion Best Practices (Core)
Animate properties using \`useCurrentFrame()\` and \`interpolate()\`. Use Easing to customize the timing of the animation.

\`\`\`tsx
import { useCurrentFrame, Easing, interpolate, useVideoConfig } from "remotion";

export const FadeIn = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [0, 2 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return <div style={{ opacity }}>Hello World!</div>;
};
\`\`\`

CSS transitions or animations are FORBIDDEN - they will not render correctly. 
Tailwind animation class names are FORBIDDEN - they will not render correctly.

Place assets in the \`public/\` folder at your project root. Use \`staticFile()\` to reference files from the \`public/\` folder.

Add images using the \`<Img />\` component from \`remotion\`.
Add videos using the \`<Video />\` component from \`@remotion/media\`.
Add audio using the \`<Audio />\` component from \`@remotion/media\`.

Assets can be also referenced as remote URLs.

To delay content wrap it in \`<Sequence />\` and use \`from\`.
To limit the duration of an element, use \`durationInFrames\` of \`<Sequence />\`.
\`<Sequence />\` by default is an absolute fill. For inline content, use \`layout="none"\`.

\`\`\`tsx
import { Sequence, AbsoluteFill, useVideoConfig, interpolate, Easing, useCurrentFrame } from "remotion";

export const Title = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [0, 2 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return <div style={{ opacity }}>Title</div>;
};

export const Subtitle = () => {
  return <div>Subtitle</div>;
};

const Main = () => {
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence>
        <Background />
      </Sequence>
      <Sequence from={1 * fps} durationInFrames={2 * fps} layout="none">
        <Title />
      </Sequence>
      <Sequence from={2 * fps} durationInFrames={2 * fps} layout="none">
        <Subtitle />
      </Sequence>
    </AbsoluteFill>
  );
}
\`\`\`
`;

function resolveProjectPath(outDir: string, relativePath: string): string {
  const resolved = path.resolve(outDir, relativePath);
  const root = path.resolve(outDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path must be within the project directory');
  }
  return resolved;
}

function createLlmModel(provider: LlmProvider, apiKey: string | undefined, model?: string) {
  const modelId = model ?? DEFAULT_MODELS[provider];
  if (provider === 'anthropic') {
    return createAnthropic(apiKey ? { apiKey } : undefined)(modelId);
  }
  return createOpenAI(apiKey ? { apiKey } : undefined)(modelId);
}

export async function runVideoAgent(args: RunVideoAgentArgs): Promise<RunVideoAgentResult> {
  const keys = resolveApiKeys({
    openaiApiKey: args.provider === 'openai' ? args.apiKey : undefined,
    anthropicApiKey: args.provider === 'anthropic' ? args.apiKey : undefined,
  });
  const provider = resolveProvider(args.provider, args.model, keys);
  const apiKey = pickKey(
    args.apiKey,
    provider === 'anthropic' ? keys.anthropicApiKey : keys.openaiApiKey,
  );
  const model = args.model ?? DEFAULT_MODELS[provider];
  const emit = args.emit ?? (() => {});

  let videoPath: string | undefined;
  let durationInFrames: number | undefined;

  await ensureProjectDeps(args.outDir, (message) => {
    emit({ kind: 'tool', text: message, title: 'Setting up project' });
  });

  // Fetch core skills dynamically
  let coreSkill = FALLBACK_CORE_SKILL;
  try {
    const response = await fetch('https://raw.githubusercontent.com/remotion-dev/skills/main/skills/remotion/SKILL.md');
    if (response.ok) {
      coreSkill = await response.text();
    }
  } catch (error) {
    console.warn('Failed to fetch core Remotion skills, using fallback.', error);
  }

  // Initialize MCP client for Remotion documentation
  const mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["@remotion/mcp@latest"],
  });
  const mcpClient = new Client(
    { name: "remotion-agent-client", version: "1.0.0" },
    { capabilities: {} }
  );

  let mcpConnected = false;

  const connectMcp = async () => {
    if (mcpConnected) return;
    try {
      await mcpClient.connect(mcpTransport);
      mcpConnected = true;
    } catch (error) {
      console.error("Failed to connect to Remotion MCP:", error);
    }
  };

  try {
    const result = await generateText({
      model: createLlmModel(provider, apiKey, model),
      system: SYSTEM_PROMPT + '\n\n' + coreSkill,
      prompt: args.prompt,
      stopWhen: [stepCountIs(args.maxSteps ?? 15), hasToolCall('finish')],
      onStepFinish: (step) => {
        if (step.text) emit({ kind: 'status', text: step.text });
      },
      tools: {
        search_docs: tool({
          description: 'Search the official Remotion documentation for APIs, components, and best practices.',
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => {
            emit({ kind: 'tool', text: `Searching Remotion docs for: "${query}"...`, title: "Searching Remotion docs" });
            
            await connectMcp();
            
            if (!mcpConnected) {
              return { error: "Could not connect to Remotion documentation server." };
            }

            try {
              const mcpResult = await mcpClient.callTool({
                name: "remotion-documentation",
                arguments: { query },
              });
              return mcpResult;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { error: `MCP search failed: ${message}` };
            }
          },
        }),
        get_skill: tool({
          description: 'Fetch specialized Remotion knowledge for a specific topic.',
          inputSchema: z.object({
            skillName: z.enum(SKILLS_LIST).describe('The name of the skill to fetch (e.g., "animations")'),
          }),
          execute: async ({ skillName }) => {
            emit({ kind: 'tool', text: `Fetching Remotion skill: ${skillName}...`, title: "Loading Skill" });
            
            const baseUrl = 'https://raw.githubusercontent.com/remotion-dev/skills/main/skills/remotion/rules';
            const url = `${baseUrl}/${skillName}.md`;

            try {
              const response = await fetch(url);
              if (!response.ok) {
                throw new Error(`Failed to fetch skill: ${response.statusText}`);
              }
              const content = await response.text();
              return { skill: skillName, content };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { error: `Could not load skill remotely: ${message}` };
            }
          },
        }),
        list_files: tool({
          description: 'List files in the project directory.',
          inputSchema: z.object({}),
          execute: async () => {
            const files = await fs.readdir(args.outDir);
            return { files };
          },
        }),
        read_file: tool({
          description: 'Read a file from the project directory (source code, package.json, config, etc.).',
          inputSchema: z.object({
            path: z.string().describe('Relative path to the file (e.g., "Root.tsx", "package.json")'),
          }),
          execute: async ({ path: filePath }) => {
            try {
              const fullPath = resolveProjectPath(args.outDir, filePath);
              const content = await fs.readFile(fullPath, 'utf-8');
              emit({ kind: 'tool', text: `Read file: ${filePath}`, title: 'Reading file' });
              return { ok: true, path: filePath, content };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { ok: false, error: message };
            }
          },
        }),
        write_file: tool({
          description: 'Write a file to the project directory.',
          inputSchema: z.object({
            path: z.string().describe('Relative path to the file (e.g., "Root.tsx")'),
            content: z.string().describe('Full content of the file'),
          }),
          execute: async ({ path: filePath, content }) => {
            const fullPath = resolveProjectPath(args.outDir, filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content, 'utf-8');
            emit({ kind: 'tool', text: `Wrote file: ${filePath}`, title: "Writing file" });
            return { ok: true, path: filePath };
          },
        }),
        render: tool({
          description: 'Render a Remotion composition to an mp4.',
          inputSchema: z.object({
            entryPoint: z.string().default('index.ts').describe('The entry point file (calls registerRoot)'),
            compositionId: z.string().describe('The ID of the composition to render'),
            inputProps: z.record(z.string(), z.any()).optional().describe('Optional props to pass to the composition'),
          }),
          execute: async ({ entryPoint, compositionId, inputProps }) => {
            try {
              emit({ kind: 'tool', text: `Rendering composition "${compositionId}"…`, title: "Rendering composition" });
              const entryPath = path.join(args.outDir, entryPoint);
              const rendered = await renderVideo(entryPath, compositionId, args.outDir, inputProps);
              videoPath = rendered.outputLocation;
              durationInFrames = rendered.durationInFrames;
              emit({ kind: 'tool', text: 'Render complete.', title: "Render complete" });
              return { ok: true, path: rendered.outputLocation };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              emit({ kind: 'tool', text: `Render failed: ${message}`, title: "Render failed" });
              return { ok: false, error: message };
            }
          },
        }),
        finish: tool({
          description: 'Finalize once the rendered video satisfies the brief.',
          inputSchema: z.object({ summary: z.string().describe('A short summary of the video.') }),
        }),
      },
    });

    return {
      text: result.text,
      videoPath,
      durationInFrames,
    };
  } finally {
    if (mcpConnected) {
      await mcpClient.close();
    }
  }
}
