import { executeEffectiveBootTool } from "@raiden/boot";
import {
  BootToolRuntimeError,
  executeBootTool,
  listBootTools,
  searchBootTools,
  type BootToolAuditEvent
} from "@raiden/shared/tools";

type EnvOverrides = Record<string, string | undefined>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function withEnv(overrides: EnvOverrides, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const next = overrides[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function mediaWikiMockFetch(url: string | URL | Request) {
  const href = url instanceof Request ? url.url : String(url);
  const requestUrl = new URL(href);
  const action = requestUrl.searchParams.get("action");
  const payload =
    action === "opensearch"
      ? ["雷电真", ["雷电真"], ["初代雷神。"], ["https://example.test/raiden-makoto"]]
      : {
          query: {
            pages: {
              "1": {
                title: "雷电真",
                extract: "初代雷神。"
              }
            }
          }
        };

  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" }
    })
  );
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

  await withEnv({ DATABASE_URL: "", BOOT_IMAGE_BASE_URL: "not-a-url" }, async () => {
    await expectBootToolRuntimeError(
      "effective web_search denied without image config parsing",
      () =>
        executeEffectiveBootTool(
          "web_search",
          {
            query: "runtime smoke",
            maxResults: 1
          },
          {
            permission: {
              deniedToolNames: ["web_search"]
            }
          }
        ),
      { code: "tool_permission_denied", statusCode: 403 }
    );

    const searchOutput = await executeEffectiveBootTool(
      "wikipedia_search",
      {
        query: "雷电真",
        maxResults: 1
      },
      {
        fetch: mediaWikiMockFetch
      }
    );
    assert(searchOutput.results[0]?.url === "https://example.test/raiden-makoto", "search tools should ignore invalid image config");
  });

  await withEnv({ DATABASE_URL: "", BOOT_WIKIPEDIA_API_URL: "not-a-url" }, async () => {
    await expectBootToolRuntimeError(
      "effective makoto_image denied without search config parsing",
      () =>
        executeEffectiveBootTool(
          "makoto_image",
          {
            prompt: "a quiet purple shrine under soft lightning",
            size: "1024x1024",
            n: 1
          },
          {
            permission: {
              deniedToolNames: ["makoto_image"]
            }
          }
        ),
      { code: "tool_permission_denied", statusCode: 403 }
    );

    const effectiveImage = await executeEffectiveBootTool(
      "makoto_image",
      {
        prompt: "a quiet purple shrine under soft lightning",
        size: "1024x1024",
        n: 1
      },
      {
        imageGenerator: async () => ({
          images: [
            {
              base64: "AA==",
              mediaType: "image/png"
            }
          ],
          warnings: []
        })
      }
    );
    assert(effectiveImage.images[0]?.base64 === "AA==", "image tools should ignore invalid search config");
  });

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
    "invalid image output",
    () =>
      executeBootTool(
        "makoto_image",
        {
          prompt: "a quiet purple shrine under soft lightning",
          size: "1024x1024",
          n: 1
        },
        {
          imageGenerator: async () => ({
            images: [],
            warnings: []
          })
        }
      ),
    { code: "tool_output_schema_invalid", statusCode: 502 }
  );

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

  const largeImageBase64 = "A".repeat(2_100_000);
  const budgetedImageResult = await executeBootTool(
    "makoto_image",
    {
      prompt: "several quiet purple shrine studies",
      size: "1024x1024",
      n: 4
    },
    {
      imageGenerator: async () => ({
        images: Array.from({ length: 4 }, () => ({
          base64: largeImageBase64,
          mediaType: "image/png"
        })),
        warnings: []
      })
    }
  );
  assert(budgetedImageResult.images.length > 0, "image budgeting should keep at least one generated image when possible");
  assert(budgetedImageResult.images.length < 4, "image budgeting should drop extra images over budget");
  assert(JSON.stringify(budgetedImageResult).length <= imageDescriptor.resultBudgetChars, "image result should honor descriptor budget");

  console.log("Boot tool runtime smoke passed.");
}

await main();
