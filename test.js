"use strict";

const assert = require("assert");
const MarkdownIt = require("markdown-it");
const { collectBlocks, stripFrontMatter } = require("./blocks");
const {
  MODELS_ENDPOINT,
  CHAT_ENDPOINT,
  createBatches,
  extractJsonArray,
  validateTranslations,
  fetchAvailableModels,
  requestTranslation,
  formatGatewayError
} = require("./gatewayClient");
const { setTranslations, extendMarkdownIt, clearAllTranslations } = require("./preview");

const source = `---
title: ignored
---
# A Quiet Morning

This is **important** and [useful](https://example.com). Use \`npm test\`.

- First item
- Second item

| Name | Value |
| --- | --- |
| Mode | Fast |

\`\`\`js
console.log("unchanged");
\`\`\`
`;

async function run() {
  const blocks = collectBlocks(source);
  assert.deepStrictEqual(blocks.map((block) => block.sourceText), [
    "A Quiet Morning",
    "This is __NCP_PROTECTED_0__important__NCP_PROTECTED_1__ and __NCP_PROTECTED_2__useful__NCP_PROTECTED_3__. Use __NCP_PROTECTED_4__.",
    "First item",
    "Second item",
    "Name",
    "Value",
    "Mode",
    "Fast"
  ]);
  assert.strictEqual(blocks[1].protectedInlines.length, 5);
  assert.strictEqual(createBatches(blocks, 1000).length, 1);

  const parsed = extractJsonArray("```json\n[{\"id\":\"block-0\",\"translation\":\"宁静的清晨\"}]\n```");
  assert.strictEqual(validateTranslations(parsed, blocks.slice(0, 1))[0].translatedText, "宁静的清晨");
  assert.throws(
    () => validateTranslations([{ id: "block-1", translation: "缺少占位符" }], blocks.slice(1, 2)),
    /未保留/
  );

  const translations = blocks.map((block, index) => ({
    ...block,
    translatedText: index === 0
      ? "宁静的清晨"
      : `中文${index} ${(block.protectedInlines || []).map((item) => item.placeholder).join("")}`.trim()
  }));
  const md = extendMarkdownIt(new MarkdownIt());
  setTranslations("file:///test.md", translations);
  const html = md.render(stripFrontMatter(source), { currentDocument: "file:///test.md" });
  assert.ok(html.includes("<h1>宁静的清晨</h1>"));
  assert.ok(html.includes("<code>npm test</code>"));
  assert.ok(html.includes("<a href=\"https://example.com\"></a>"));
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("console.log(&quot;unchanged&quot;);"));
  assert.ok(!html.includes("A Quiet Morning"));
  clearAllTranslations();

  let requestedUrl;
  const models = await fetchAvailableModels(async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      async json() {
        return {
          data: [
            { id: "openai/example", type: "language", name: "Example", owned_by: "openai", pricing: { input: "0.000001" } },
            { id: "google/image", type: "image", name: "Image" }
          ]
        };
      }
    };
  });
  assert.strictEqual(requestedUrl, MODELS_ENDPOINT);
  assert.deepStrictEqual(models.map((model) => model.id), ["openai/example"]);

  const batch = blocks.slice(0, 1);
  let requestBody;
  let authHeader;
  const translated = await requestTranslation("secret-key", "openai/example", batch, {
    style: "自然中文",
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      assert.strictEqual(url, CHAT_ENDPOINT);
      requestBody = JSON.parse(init.body);
      authHeader = init.headers.Authorization;
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '[{"id":"block-0","translation":"宁静的清晨"}]' } }] };
        }
      };
    }
  });
  assert.strictEqual(authHeader, "Bearer secret-key");
  assert.strictEqual(requestBody.model, "openai/example");
  assert.strictEqual(translated[0].translatedText, "宁静的清晨");
  assert.match(formatGatewayError(402), /余额|预算/);
  assert.match(formatGatewayError(429), /请求过多/);

  console.log("All tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
