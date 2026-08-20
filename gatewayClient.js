"use strict";

const MODELS_ENDPOINT = "https://ai-gateway.vercel.sh/v1/models";
const CHAT_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";

class GatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

function createBatches(blocks, maxCharacters) {
  const batches = [];
  let batch = [];
  let characters = 0;
  for (const block of blocks) {
    const size = block.sourceText.length + 100;
    if (batch.length > 0 && (characters + size > maxCharacters || batch.length >= 30)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(block);
    characters += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function extractJsonArray(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模型没有返回可识别的 JSON 翻译结果");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateTranslations(items, batch) {
  if (!Array.isArray(items)) throw new Error("模型翻译结果不是数组");
  const byId = new Map(items.map((item) => [item?.id, item?.translation]));
  return batch.map((block) => {
    const translatedText = byId.get(block.id);
    if (typeof translatedText !== "string" || !translatedText.trim()) {
      throw new Error(`模型遗漏了 ${block.id} 的翻译`);
    }
    for (const item of block.protectedInlines || []) {
      if (!translatedText.includes(item.placeholder)) {
        throw new Error(`模型未保留 ${block.id} 中的受保护内容`);
      }
    }
    return { ...block, translatedText: translatedText.trim() };
  });
}

function buildPrompt(batch, style) {
  const input = batch.map((block) => ({ id: block.id, text: block.sourceText }));
  return [
    "将输入 JSON 中每个 text 翻译成简体中文。",
    `风格要求：${style}。`,
    "规则：",
    "1. 只翻译自然语言，不解释、不总结、不增加信息。",
    "2. 所有 __NCP_PROTECTED_数字__ 占位符必须原样保留，字符、大小写、位置均不得改变。",
    "3. 保留产品名、变量名和必要的英文专有名词。",
    "4. 返回严格 JSON 数组，每项格式为 {\"id\":\"原ID\",\"translation\":\"中文\"}。",
    "5. 不要使用 Markdown 代码围栏，不要输出 JSON 之外的文字。",
    "输入：",
    JSON.stringify(input)
  ].join("\n");
}

function formatGatewayError(status, detail) {
  if (status === 401 || status === 403) return "Vercel AI Gateway Key 无效或没有访问权限";
  if (status === 402) return "Vercel AI Gateway 余额或预算额度不足";
  if (status === 404) return "所选模型不存在或已下线，请重新选择模型";
  if (status === 429) return "Vercel AI Gateway 请求过多，请稍后重试";
  if (status === 503) return "所选模型或上游提供商暂时不可用";
  return `Vercel AI Gateway 请求失败（HTTP ${status}${detail ? `：${detail}` : ""}）`;
}

async function fetchAvailableModels(fetchImpl = fetch) {
  const response = await fetchImpl(MODELS_ENDPOINT, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new GatewayError(formatGatewayError(response.status), response.status);
  const payload = await response.json();
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return models
    .filter((model) => model?.type === "language")
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.owned_by || String(model.id || "").split("/")[0],
      description: model.description || "",
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      pricing: model.pricing || {}
    }))
    .filter((model) => typeof model.id === "string" && model.id.includes("/"));
}

async function fetchWithTimeout(url, init, timeoutMs, cancellationToken, fetchImpl = fetch) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const subscription = cancellationToken?.onCancellationRequested?.(() => controller.abort());
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      if (cancellationToken?.isCancellationRequested) throw new Error("操作已取消");
      if (timedOut) throw new Error(`Vercel AI Gateway 请求超过 ${timeoutMs} 毫秒`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    subscription?.dispose?.();
  }
}

async function requestTranslation(apiKey, modelId, batch, options) {
  const response = await fetchWithTimeout(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "system",
          content: "你是一名专业技术文档译者。严格按照用户要求返回结构化翻译结果。"
        },
        { role: "user", content: buildPrompt(batch, options.style) }
      ]
    })
  }, options.timeoutMs, options.token, options.fetchImpl || fetch);

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || "";
    throw new GatewayError(formatGatewayError(response.status, detail), response.status);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型返回了空翻译结果");
  return validateTranslations(extractJsonArray(content), batch);
}

async function translateBlocks(apiKey, modelId, blocks, options) {
  const batches = createBatches(blocks, options.maxBatchCharacters || 6000);
  const translations = [];
  for (let index = 0; index < batches.length; index += 1) {
    if (options.token?.isCancellationRequested) throw new Error("操作已取消");
    const batchTranslations = await requestTranslation(apiKey, modelId, batches[index], options);
    translations.push(...batchTranslations);
    await options.onProgress?.(index + 1, batches.length, translations.slice());
  }
  return translations;
}

module.exports = {
  MODELS_ENDPOINT,
  CHAT_ENDPOINT,
  GatewayError,
  createBatches,
  extractJsonArray,
  validateTranslations,
  buildPrompt,
  formatGatewayError,
  fetchAvailableModels,
  requestTranslation,
  translateBlocks
};
