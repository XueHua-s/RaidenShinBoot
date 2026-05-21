import {
  BootToolRuntimeError,
  executeBootTool,
  listBootTools,
  searchBootTools,
  type BootToolAuditEvent
} from "@raiden/shared/tools";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectBootToolRuntimeError(
  label: string,
  run: () => Promise<unknown>,
  expected: { code: string; statusCode: number }
) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof BootToolRuntimeError, `${label} should throw BootToolRuntimeError`);
    assert(error.code === expected.code, `${label} should throw code ${expected.code}, got ${error.code}`);
    assert(error.statusCode === expected.statusCode, `${label} should throw status ${expected.statusCode}, got ${error.statusCode}`);
    return;
  }

  throw new Error(`${label} should have failed`);
}

async function main() {
  const descriptors = listBootTools();
  const imageDescriptor = descriptors.find((tool) => tool.name === "makoto_image");
  assert(imageDescriptor, "makoto_image should be listed in tool descriptors");
  assert(!imageDescriptor.readOnly, "makoto_image should be marked as non-read-only");
  assert(imageDescriptor.capabilities.includes("image"), "makoto_image should advertise image capability");

  const searchResult = searchBootTools({ query: "select:makoto_image", maxResults: 3 });
  assert(searchResult.matches.length === 1, "select:makoto_image should return exactly one tool");
  assert(searchResult.matches[0]?.name === "makoto_image", "select:makoto_image should return makoto_image");

  const deniedAuditEvents: BootToolAuditEvent[] = [];
  await expectBootToolRuntimeError(
    "denied web_search",
    () =>
      executeBootTool(
        "web_search",
        {
          query: "runtime smoke",
          maxResults: 1
        },
        {
          permission: {
            deniedToolNames: ["web_search"]
          },
          audit: (event) => {
            deniedAuditEvents.push(event);
          }
        }
      ),
    { code: "tool_permission_denied", statusCode: 403 }
  );
  assert(deniedAuditEvents.some((event) => event.status === "denied"), "permission denial should emit denied audit event");

  await expectBootToolRuntimeError(
    "invalid image input",
    () =>
      executeBootTool("makoto_image", {
        prompt: "",
        size: "1024x1024",
        n: 1
      }),
    { code: "tool_input_schema_invalid", statusCode: 400 }
  );

  await expectBootToolRuntimeError(
    "missing image generator",
    () =>
      executeBootTool("makoto_image", {
        prompt: "a quiet purple shrine under soft lightning",
        size: "1024x1024",
        n: 1
      }),
    { code: "tool_context_missing", statusCode: 503 }
  );

  const completedAuditEvents: BootToolAuditEvent[] = [];
  const imageResult = await executeBootTool(
    "makoto_image",
    {
      prompt: "a quiet purple shrine under soft lightning",
      size: "1024x1024",
      n: 1
    },
    {
      imageGenerator: async (input) => {
        assert(input.n === 1, "mock image generator should receive parsed input");
        return {
          images: [
            {
              base64: "AA==",
              mediaType: "image/png"
            }
          ],
          warnings: []
        };
      },
      audit: (event) => {
        completedAuditEvents.push(event);
      }
    }
  );

  assert(imageResult.images[0]?.base64 === "AA==", "mock image generator result should round-trip through output schema");
  assert(completedAuditEvents.some((event) => event.status === "completed"), "successful execution should emit completed audit event");

  console.log("Boot tool runtime smoke passed.");
}

await main();
