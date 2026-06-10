import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["@remotion/mcp@latest"],
  });

  const client = new Client(
    {
      name: "remotion-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  console.log("--- TOOLS ---");
  const tools = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));

  console.log("\n--- RESOURCES ---");
  try {
    const resources = await client.listResources();
    console.log(JSON.stringify(resources, null, 2));
  } catch (e) {
    console.log("No resources or error listing resources");
  }

  console.log("\n--- PROMPTS ---");
  try {
    const prompts = await client.listPrompts();
    console.log(JSON.stringify(prompts, null, 2));
  } catch (e) {
    console.log("No prompts or error listing prompts");
  }

  await client.close();
}

main().catch(console.error);
