"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { collectBlocks } = require("./blocks");
const { fetchAvailableModels, translateBlocks } = require("./gatewayClient");
const { setTranslations, clearTranslations, clearAllTranslations, hasTranslations, extendMarkdownIt, renderTranslation } = require("./preview");
const { renderPreviewHtml } = require("./customPreview");

const SECRET_KEY = "naturalChinesePreview.aiGatewayApiKey";
const MODEL_KEY = "naturalChinesePreview.selectedModel";
const CACHE_KEY = "naturalChinesePreview.paragraphCache.v2";
const MAX_CACHE_ENTRIES = 1000;
let lastMarkdownUri;
let customPreview;

function parseEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function findWorkspaceRoot(resource) {
  const folder = vscode.workspace.getWorkspaceFolder(resource);
  return folder ? folder.uri.fsPath : undefined;
}

function readApiKeyFromCandidateFiles(resource, extensionPath) {
  const candidates = [];
  const workspaceRoot = findWorkspaceRoot(resource);
  if (workspaceRoot) candidates.push(path.join(workspaceRoot, ".env"));
  if (extensionPath) candidates.push(path.join(extensionPath, ".env"));
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const env = parseEnvFile(candidate);
      const key = env.AI_GATEWAY_API_KEY;
      if (key && key.trim()) return key.trim();
    } catch {
      // ignore parse/read errors
    }
  }
  return undefined;
}

function rememberMarkdownEditor(editor) {
  if (editor?.document.languageId === "markdown") lastMarkdownUri = editor.document.uri;
}

async function resolveMarkdownDocument(resource) {
  if (resource?.scheme !== "webview-panel" && /\.(md|markdown|mdown|mkd|mdwn|mdtxt|mdtext)$/i.test(resource?.path || "")) {
    const document = await vscode.workspace.openTextDocument(resource);
    if (document.languageId === "markdown") return document;
  }
  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId === "markdown") return active;
  const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.languageId === "markdown")?.document;
  if (visible) return visible;
  if (lastMarkdownUri) {
    const document = await vscode.workspace.openTextDocument(lastMarkdownUri);
    if (document.languageId === "markdown") return document;
  }
  return undefined;
}

async function promptAndStoreApiKey(context) {
  const apiKey = await vscode.window.showInputBox({
    title: "设置 Vercel AI Gateway Key",
    prompt: "Key 仅保存在 VS Code SecretStorage，不会写入设置文件或日志。",
    placeHolder: "输入 AI Gateway API Key",
    password: true,
    ignoreFocusOut: true,
    validateInput(value) {
      return value.trim().length >= 8 ? undefined : "请输入有效的 Vercel AI Gateway Key";
    }
  });
  if (apiKey === undefined) return undefined;
  await context.secrets.store(SECRET_KEY, apiKey.trim());
  vscode.window.showInformationMessage("Vercel AI Gateway Key 已安全保存。");
  return apiKey.trim();
}

async function getApiKey(context, resource) {
  const envKey = process.env.AI_GATEWAY_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const fileKey = readApiKeyFromCandidateFiles(resource, context.extensionPath);
  if (fileKey) return fileKey;
  return await context.secrets.get(SECRET_KEY) || await promptAndStoreApiKey(context);
}

function pricePerMillion(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  const perMillion = number * 1_000_000;
  if (perMillion >= 100) return `$${perMillion.toFixed(0)}/M`;
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}/M`;
  return `$${perMillion.toFixed(3)}/M`;
}

function modelQuickPickItem(model, selectedId) {
  const input = pricePerMillion(model.pricing?.input);
  const output = pricePerMillion(model.pricing?.output);
  const prices = [input && `输入 ${input}`, output && `输出 ${output}`].filter(Boolean).join(" · ");
  return {
    label: model.name,
    description: `${model.id}${model.id === selectedId ? " · 当前" : ""}`,
    detail: [model.provider, prices, model.contextWindow && `上下文 ${model.contextWindow.toLocaleString()} tokens`, model.description]
      .filter(Boolean)
      .join(" · "),
    model
  };
}

async function selectAndStoreModel(context) {
  const selectedModel = context.globalState.get(MODEL_KEY);
  const models = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在读取 Vercel AI Gateway 模型列表",
    cancellable: false
  }, () => fetchAvailableModels());
  if (!models.length) throw new Error("Vercel AI Gateway 没有返回可用的语言模型");
  models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  const choice = await vscode.window.showQuickPick(
    models.map((model) => modelQuickPickItem(model, selectedModel?.id)),
    {
      title: "选择 Vercel AI Gateway 翻译模型",
      placeHolder: "输入模型名称或 provider/model 进行搜索",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    }
  );
  if (!choice) return undefined;
  const stored = { id: choice.model.id, name: choice.model.name, provider: choice.model.provider };
  await context.globalState.update(MODEL_KEY, stored);
  vscode.window.showInformationMessage(`已选择翻译模型：${stored.name}（${stored.id}）`);
  return stored;
}

async function getSelectedModel(context) {
  return context.globalState.get(MODEL_KEY) || await selectAndStoreModel(context);
}

function translationCacheKey(sourceText, modelId, style) {
  return crypto.createHash("sha256").update("v2\0").update(modelId).update("\0").update(style).update("\0").update(sourceText).digest("hex");
}

function getCachedTranslation(context, key) {
  const entries = context.globalState.get(CACHE_KEY, []);
  return entries.find((entry) => entry.key === key)?.translation;
}

async function storeCachedTranslations(context, translations, modelId, style) {
  const cache = new Map(context.globalState.get(CACHE_KEY, []).map((entry) => [entry.key, entry]));
  for (const translation of translations || []) {
    const key = translationCacheKey(translation.sourceText, modelId, style);
    cache.set(key, { key, translation, savedAt: Date.now() });
  }
  const entries = [...cache.values()].sort((a, b) => b.savedAt - a.savedAt);
  await context.globalState.update(CACHE_KEY, entries.slice(0, MAX_CACHE_ENTRIES));
}

function visibleBlocks(document, blocks) {
  const editor = vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === document.uri.toString());
  if (!editor || !editor.visibleRanges.length) return blocks.slice(0, 1);
  return blocks.filter((block) => Number.isInteger(block.startLine)
    && Number.isInteger(block.endLine)
    && editor.visibleRanges.some((range) => block.endLine > range.start.line && block.startLine <= range.end.line));
}

async function translatePreview(context, resource, output) {
  const document = await resolveMarkdownDocument(resource);
  if (!document) {
    vscode.window.showWarningMessage("请先打开 Markdown 文件，并点击‘打开侧边预览’。");
    return;
  }
  const allBlocks = collectBlocks(document.getText());
  if (!allBlocks.length) {
    vscode.window.showInformationMessage("当前预览中没有需要翻译的英文正文。");
    return;
  }
  const blocks = visibleBlocks(document, allBlocks);
  if (!blocks.length) {
    vscode.window.showInformationMessage("当前视口中没有需要翻译的英文段落。");
    return;
  }

  // The extension augments VS Code's official preview instead of creating a
  // second webview. Open that preview when the command comes from the editor.
  await vscode.commands.executeCommand("markdown.showPreviewToSide", document.uri);

  const apiKey = await getApiKey(context, document.uri);
  if (!apiKey) return;
  const model = await getSelectedModel(context);
  if (!model) return;

  const config = vscode.workspace.getConfiguration("naturalChinesePreview", document.uri);
  const style = config.get("translationStyle", "自然、流畅、符合现代简体中文表达习惯；避免逐字翻译和生硬欧化句式；准确保留原意，不扩写、不总结");
  const cachedTranslations = config.get("cacheEnabled", true)
    ? blocks.map((block) => {
      const cached = getCachedTranslation(context, translationCacheKey(block.sourceText, model.id, style));
      return cached ? { ...block, translatedText: cached.translatedText } : undefined;
    }).filter(Boolean)
    : [];
  const cachedById = new Map(cachedTranslations.map((item) => [item.id, item]));
  const missingBlocks = blocks.filter((block) => !cachedById.has(block.id));
  if (!missingBlocks.length) {
    setTranslations(document.uri, cachedTranslations);
    await vscode.commands.executeCommand("markdown.api.reloadPlugins");
    vscode.window.showInformationMessage(`已从段落缓存恢复中文预览（${model.name}，${blocks.length} 段）。`);
    return;
  }

  output.appendLine(`[translate] resource=${document.uri.toString()} visible=${blocks.length} missing=${missingBlocks.length} model=${model.id}`);
  let completedTranslations;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在用 ${model.name} 翻译 Markdown 预览`,
    cancellable: true
  }, async (progress, token) => {
    let lastCompleted = 0;
    completedTranslations = await translateBlocks(apiKey, model.id, missingBlocks, {
      token,
      maxBatchCharacters: config.get("maxBatchCharacters", 6000),
      timeoutMs: config.get("requestTimeoutMs", 120000),
      style,
      async onProgress(completed, total, partial) {
        setTranslations(document.uri, [...cachedTranslations, ...partial]);
        progress.report({
          increment: total ? ((completed - lastCompleted) / total) * 100 : 100,
          message: `${completed}/${total}`
        });
        lastCompleted = completed;
        await vscode.commands.executeCommand("markdown.api.reloadPlugins");
      }
    });
    setTranslations(document.uri, [...cachedTranslations, ...completedTranslations]);
    await vscode.commands.executeCommand("markdown.api.reloadPlugins");
  });

  if (config.get("cacheEnabled", true) && completedTranslations) {
    await storeCachedTranslations(context, completedTranslations, model.id, style);
  }
  vscode.window.showInformationMessage(`已翻译当前视口的 ${blocks.length} 个段落（${cachedTranslations.length} 个来自缓存）。`);
}

async function clearPreview(resource) {
  const document = await resolveMarkdownDocument(resource);
  if (!document) return;
  clearTranslations(document.uri);
  await vscode.commands.executeCommand("markdown.api.reloadPlugins");
  vscode.window.showInformationMessage("已恢复英文 Markdown 预览。");
}

async function togglePreview(context, resource, output) {
  const document = await resolveMarkdownDocument(resource);
  if (!document) return;
  if (hasTranslations(document.uri)) return clearPreview(document.uri);
  return translatePreview(context, document.uri, output);
}

async function translateVisibleCustomPreview(context, session, ids, output) {
  const alreadyTranslated = ids.map((id) => session.translations.get(id)).filter(Boolean);
  if (alreadyTranslated.length) {
    await session.panel.webview.postMessage({
      type: "translations",
      items: alreadyTranslated.map((item) => ({ id: item.id, html: renderTranslation(item.translatedText, item.protectedInlines) }))
    });
  }
  const blocks = session.blocks.filter((block) => ids.includes(block.id) && !session.translations.has(block.id));
  if (!blocks.length) return;
  session.ready ||= (async () => {
    const apiKey = await getApiKey(context, session.document.uri);
    const model = apiKey && await getSelectedModel(context);
    const config = vscode.workspace.getConfiguration("naturalChinesePreview", session.document.uri);
    const style = config.get("translationStyle", "自然、流畅、符合现代简体中文表达习惯；避免逐字翻译和生硬欧化句式；准确保留原意，不扩写、不总结");
    return { apiKey, model, config, style };
  })();
  const { apiKey, model, config, style } = await session.ready;
  if (!apiKey || !model) return;
  const cached = config.get("cacheEnabled", true)
    ? blocks.map((block) => {
      const item = getCachedTranslation(context, translationCacheKey(block.sourceText, model.id, style));
      return item ? { ...block, translatedText: item.translatedText } : undefined;
    }).filter(Boolean)
    : [];
  for (const item of cached) session.translations.set(item.id, item);
  const cachedIds = new Set(cached.map((item) => item.id));
  const missing = blocks.filter((block) => !cachedIds.has(block.id));
  let translated = [];
  if (missing.length) {
    output.appendLine(`[viewport] resource=${session.document.uri.toString()} blocks=${missing.length} model=${model.id}`);
    translated = await translateBlocks(apiKey, model.id, missing, {
      maxBatchCharacters: config.get("viewportBatchCharacters", 1800),
      concurrency: config.get("viewportConcurrency", 3),
      timeoutMs: config.get("requestTimeoutMs", 120000),
      style,
      async onProgress(completed, total, partial) {
        await session.panel.webview.postMessage({
          type: "translations",
          items: partial.map((item) => ({ id: item.id, html: renderTranslation(item.translatedText, item.protectedInlines) }))
        });
      }
    });
    if (config.get("cacheEnabled", true)) await storeCachedTranslations(context, translated, model.id, style);
    for (const item of translated) session.translations.set(item.id, item);
  }
  const items = [...cached, ...translated].map((item) => ({
    id: item.id,
    html: renderTranslation(item.translatedText, item.protectedInlines)
  }));
  session.panel.webview.postMessage({ type: "translations", items });
}

async function openCustomPreview(context, resource, output) {
  const document = await resolveMarkdownDocument(resource);
  if (!document) {
    vscode.window.showWarningMessage("请先打开 Markdown 文件。");
    return;
  }
  if (customPreview?.document.uri.toString() === document.uri.toString()) {
    customPreview.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  customPreview?.panel.dispose();
  const panel = vscode.window.createWebviewPanel(
    "naturalChinesePreview",
    `中文预览 ${path.basename(document.fileName)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const session = {
    document,
    panel,
    blocks: collectBlocks(document.getText()),
    showingChinese: true,
    inFlight: new Set(),
    // Strongest cache layer: scrolling back within this open preview must
    // never spend tokens for a paragraph that was already translated.
    translations: new Map()
  };
  customPreview = session;
  panel.webview.html = renderPreviewHtml(document.getText());
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type !== "visibleBlocks" || !Array.isArray(message.ids)) return;
    const ids = message.ids.filter((id) => !session.inFlight.has(id));
    if (!ids.length) return;
    ids.forEach((id) => session.inFlight.add(id));
    void translateVisibleCustomPreview(context, session, ids, output)
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${text}`);
        vscode.window.showErrorMessage(`自然中文预览失败：${text}`);
      })
      .finally(() => ids.forEach((id) => session.inFlight.delete(id)));
  });
  panel.onDidDispose(() => { if (customPreview === session) customPreview = undefined; });
}

async function toggleCustomPreview(context, resource, output) {
  if (!customPreview) return openCustomPreview(context, resource, output);
  customPreview.panel.reveal(vscode.ViewColumn.Beside);
  if (customPreview.showingChinese) {
    customPreview.showingChinese = false;
    await customPreview.panel.webview.postMessage({ type: "restoreEnglish" });
    vscode.window.showInformationMessage("已恢复英文原文预览。");
  } else {
    customPreview.showingChinese = true;
    await customPreview.panel.webview.postMessage({ type: "translateVisible" });
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel("Markdown 自然中文预览");
  rememberMarkdownEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(
    output,
    vscode.window.onDidChangeActiveTextEditor(rememberMarkdownEditor),
    vscode.commands.registerCommand("naturalChinesePreview.translate", async (resource) => {
      try {
        await toggleCustomPreview(context, resource, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        vscode.window.showErrorMessage(`自然中文预览失败：${message}`);
      }
    }),
    vscode.commands.registerCommand("naturalChinesePreview.toggle", async (resource) => {
      try {
        await toggleCustomPreview(context, resource, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        vscode.window.showErrorMessage(`自然中文预览失败：${message}`);
      }
    }),
    vscode.commands.registerCommand("naturalChinesePreview.clear", async (resource) => {
      if (customPreview) {
        customPreview.showingChinese = false;
        await customPreview.panel.webview.postMessage({ type: "restoreEnglish" });
      }
      else await clearPreview(resource);
    }),
    vscode.commands.registerCommand("naturalChinesePreview.setApiKey", async () => promptAndStoreApiKey(context)),
    vscode.commands.registerCommand("naturalChinesePreview.selectModel", async () => {
      try {
        await selectAndStoreModel(context);
        if (customPreview) customPreview.ready = undefined;
      } catch (error) {
        vscode.window.showErrorMessage(`读取模型列表失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("naturalChinesePreview.clearCache", async () => {
      await context.globalState.update(CACHE_KEY, []);
      vscode.window.showInformationMessage("Markdown 自然中文预览的本地翻译缓存已清除。");
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.document.languageId !== "markdown") return;
      clearTranslations(event.document.uri);
      if (customPreview?.document.uri.toString() === event.document.uri.toString()) {
        customPreview.document = event.document;
        customPreview.blocks = collectBlocks(event.document.getText());
        customPreview.translations.clear();
        customPreview.panel.webview.html = renderPreviewHtml(event.document.getText());
      }
      await vscode.commands.executeCommand("markdown.api.reloadPlugins");
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("naturalChinesePreview")) return;
      clearAllTranslations();
      await vscode.commands.executeCommand("markdown.api.reloadPlugins");
    })
  );
  return { extendMarkdownIt };
}

function deactivate() {}

module.exports = { activate, deactivate, extendMarkdownIt };
