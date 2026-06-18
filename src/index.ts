import path from 'node:path';
import {
  definePlugin,
  shouldHandleInvoke,
  agentOutput,
  uiWidget,
  type OpenBotEvent,
} from '@meetopenbot/plugin-sdk';
import { runVideoAgent, resolveCredentials, type LlmProvider } from './agent.js';

/** Minimal async channel so the agent loop can stream events to the bus generator. */
function createEventChannel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      queue.push(item);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *drain(): AsyncGenerator<T, void, unknown> {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export default definePlugin({
  id: 'remotion',
  name: 'Remotion Video Agent',
  description: 'Generates short videos from natural language using Remotion and an AI agent loop.',
  configSchema: {
    type: 'object',
    properties: {
      provider: {
        type: 'string',
        description: 'LLM provider to use for the video agent.',
        enum: ['openai', 'anthropic'],
        default: 'openai',
      },
      openaiApiKey: {
        type: 'string',
        description: 'OpenAI API key (optional if provided via environment or shared storage).',
        format: 'password',
      },
      anthropicApiKey: {
        type: 'string',
        description: 'Anthropic API key (optional if provided via environment or shared storage).',
        format: 'password',
      },
      model: {
        type: 'string',
        description: 'Model id for the selected provider (e.g. gpt-4o, claude-sonnet-4-6).',
      },
    },
  },
  factory: (context) => {
    const getCredentials = async () => {
      const config = context.config as {
        provider?: LlmProvider;
        openaiApiKey?: string;
        anthropicApiKey?: string;
        model?: string;
      };
      const variables = await context.storage.getVariables();

      return resolveCredentials({
        provider: config.provider,
        model: config.model,
        openaiApiKey: config.openaiApiKey,
        anthropicApiKey: config.anthropicApiKey,
        variables,
      });
    };

    return (builder) => {
      builder.on('agent:invoke', async function* (event: any, handlerCtx: any) {
        if (!shouldHandleInvoke(event, context.agentId)) return;

        const threadId = event.meta?.threadId;
        const { provider, openaiApiKey, anthropicApiKey, model } = await getCredentials();
        const apiKey = provider === 'anthropic' ? anthropicApiKey : openaiApiKey;

        if (!apiKey) {
          const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
          const apiKeyField =
            provider === 'anthropic'
              ? {
                id: 'anthropicApiKey',
                label: 'Anthropic API Key',
                type: 'text' as const,
                placeholder: 'sk-ant-...',
                required: true,
              }
              : {
                id: 'openaiApiKey',
                label: 'OpenAI API Key',
                type: 'text' as const,
                placeholder: 'sk-...',
                required: true,
              };

          yield agentOutput({
            agentId: context.agentId,
            content: `I need a ${providerLabel} API key to generate videos. Please provide it below:`,
            threadId,
          });

          yield uiWidget({
            agentId: context.agentId,
            threadId,
            widget: {
              kind: 'form',
              widgetId: 'remotion-llm-config',
              title: `${providerLabel} Configuration`,
              description: `Enter your ${providerLabel} API key to get started.`,
              fields: [apiKeyField],
              submitLabel: 'Save Configuration',
            },
          });
          return;
        }

        const channelId = handlerCtx.state?.channelId;
        let outDir = process.cwd();
        if (channelId) {
          try {
            const channelDetails = await context.storage.getChannelDetails({ channelId });
            if (channelDetails.cwd) outDir = channelDetails.cwd;
          } catch {
            // fall back to process.cwd()
          }
        }

        yield agentOutput({
          agentId: context.agentId,
          content: `Generating a video for: "${event.data.content}"…`,
          threadId,
        });

        const channel = createEventChannel<OpenBotEvent>();
        let runError: string | null = null;

        const run = runVideoAgent({
          prompt: event.data.content,
          apiKey,
          provider,
          model,
          outDir,
          emit: ({ kind, text, title }) => {
            if (kind === 'tool') {
              channel.push(
                uiWidget({
                  agentId: context.agentId,
                  threadId,
                  widget: {
                    kind: 'message',
                    title: title || text,
                    body: text,
                    display: 'collapsed',
                    variant: 'basic'
                  },
                }),
              );
            } else {
              channel.push(
                agentOutput({ agentId: context.agentId, content: text, threadId }),
              );
            }
          },
        })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            runError = message;
            return undefined;
          })
          .finally(() => channel.close());

        for await (const ev of channel.drain()) {
          yield ev;
        }

        const result = await run;

        if (runError) {
          yield agentOutput({
            agentId: context.agentId,
            content: `Video generation failed: ${runError}`,
            threadId,
          });
          return;
        }

        if (!result || !result.videoPath) {
          yield agentOutput({
            agentId: context.agentId,
            content: `Video generation failed: ${result?.text || 'No video was produced.'}`,
            threadId,
          });
          return;
        }

        const relativeVideoPath = path.relative(
          path.resolve(outDir),
          path.resolve(result.videoPath),
        );
        const serveData = encodeURIComponent(
          JSON.stringify({ path: relativeVideoPath }),
        );

        yield uiWidget({
          agentId: context.agentId,
          threadId,
          widget: {
            kind: 'media',
            title: 'Your video is ready',
            size: "medium",
            items: [
              {
                type: 'video',
                // @ts-ignore
                url: `${context?.publicBaseUrl}/api/state?channelId=${channelId}&type=action:storage:serve-file&data=${serveData}`,
              }
            ],
          },
        });
      });

      builder.on('client:ui:widget:response', async function* (event: any) {
        console.log('client:ui:widget:response', event);
        const widgetId = event.data?.widgetId;
        if (widgetId !== 'remotion-llm-config' && widgetId !== 'remotion-openai-config') return;

        const values = event.data.values || {};
        const openaiApiKey = values.openaiApiKey as string | undefined;
        const anthropicApiKey = values.anthropicApiKey as string | undefined;

        if (openaiApiKey) {
          await context.storage.createVariable({
            key: 'OPENAI_API_KEY',
            value: openaiApiKey,
            secret: true,
          });

          yield agentOutput({
            agentId: context.agentId,
            content: 'OpenAI API key saved! You can now try generating a video again.',
            threadId: event.meta?.threadId,
          });
        }

        if (anthropicApiKey) {
          await context.storage.createVariable({
            key: 'ANTHROPIC_API_KEY',
            value: anthropicApiKey,
            secret: true,
          });

          yield agentOutput({
            agentId: context.agentId,
            content: 'Anthropic API key saved! You can now try generating a video again.',
            threadId: event.meta?.threadId,
          });
        }
      });
    };
  },
});
