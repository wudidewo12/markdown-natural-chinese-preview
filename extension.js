"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { collectBlocks } = require("./blocks");
const { fetchAvailableModels, translateBlocks } = require("./gatewayClient");
const { setTranslations, clearTranslations, clearAllTranslations, extendMarkdownIt } = require("./preview");

const SECRET_KEY = "naturalChinesePreview.aiGatewayApiKey";
const MODEL_KEY = "naturalChinesePreview.selectedModel";
const CACHE_KEY = "naturalChinesePreview.translationCache.v1";
const MAX_CACHE_ENTRIES = 20;
let lastMarkdownUri;

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

function translationCacheKey(source, modelId, style) {
  return crypto.createHash("sha256").update("v1\0").update(modelId).update("\0").update(style).update("\0").update(source).digest("hex");
}

function getCachedTranslations(context, key) {
  const entries = context.globalState.get(CACHE_KEY, []);
  return entries.find((entry) => entry.key === key)?.translations;
}

async function storeCachedTranslations(context, key, translations) {
  const entries = context.globalState.get(CACHE_KEY, []).filter((entry) => entry.key !== key);
  entries.unshift({ key, translations, savedAt: Date.now() });
  await context.globalState.update(CACHE_KEY, entries.slice(0, MAX_CACHE_ENTRIES));
}

async function translatePreview(context, resource, output) {
  const document = await resolveMarkdownDocument(resource);
  if (!document) {
    vscode.window.showWarningMessage("请先打开 Markdown 文件，并点击‘打开侧边预览’。");
    return;
  }
  const blocks = collectBlocks(document.getText());
  if (!blocks.length) {
    vscode.window.showInformationMessage("当前预览中没有需要翻译的英文正文。");
    return;
  }

  const apiKey = await getApiKey(context, document.uri);
  if (!apiKey) return;
  const model = await getSelectedModel(context);
  if (!model) return;

  const config = vscode.workspace.getConfiguration("naturalChinesePreview", document.uri);
  const style = config.get("translationStyle", "自然、流畅、符合现代简体中文表达习惯；避免逐字翻译和生硬欧化句式；准确保留原意，不扩写、不总结");
  const cacheKey = translationCacheKey(document.getText(), model.id, style);
  if (config.get("cacheEnabled", true)) {
    const cached = getCachedTranslations(context, cacheKey);
    if (cached?.length === blocks.length) {
      setTranslations(document.uri, cached);
      await vscode.commands.executeCommand("markdown.api.reloadPlugins");
      vscode.window.showInformationMessage(`已从本地缓存恢复中文预览（${model.name}）。`);
      return;
    }
  }

  output.appendLine(`[translate] resource=${document.uri.toString()} blocks=${blocks.length} model=${model.id}`);
  let completedTranslations;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在用 ${model.name} 翻译 Markdown 预览`,
    cancellable: true
  }, async (progress, token) => {
    let lastCompleted = 0;
    completedTranslations = await translateBlocks(apiKey, model.id, blocks, {
      token,
      maxBatchCharacters: config.get("maxBatchCharacters", 6000),
      timeoutMs: config.get("requestTimeoutMs", 120000),
      style,
      async onProgress(completed, total, partial) {
        setTranslations(document.uri, partial);
        progress.report({
          increment: total ? ((completed - lastCompleted) / total) * 100 : 100,
          message: `${completed}/${total}`
        });
        lastCompleted = completed;
        await vscode.commands.executeCommand("markdown.api.reloadPlugins");
      }
    });
    setTranslations(document.uri, completedTranslations);
    await vscode.commands.executeCommand("markdown.api.reloadPlugins");
  });

  if (config.get("cacheEnabled", true) && completedTranslations) {
    await storeCachedTranslations(context, cacheKey, completedTranslations);
  }
  vscode.window.showInformationMessage(`Markdown 预览已使用 ${model.name} 翻译成自然中文。`);
}

async function clearPreview(resource) {
  const document = await resolveMarkdownDocument(resource);
  if (!document) return;
  clearTranslations(document.uri);
  await vscode.commands.executeCommand("markdown.api.reloadPlugins");
  vscode.window.showInformationMessage("已恢复英文 Markdown 预览。");
}

function activate(context) {
  const output = vscode.window.createOutputChannel("Markdown 自然中文预览");
  rememberMarkdownEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(
    output,
    vscode.window.onDidChangeActiveTextEditor(rememberMarkdownEditor),
    vscode.commands.registerCommand("naturalChinesePreview.translate", async (resource) => {
      try {
        await translatePreview(context, resource, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        vscode.window.showErrorMessage(`自然中文预览失败：${message}`);
      }
    }),
    vscode.commands.registerCommand("naturalChinesePreview.clear", async (resource) => clearPreview(resource)),
    vscode.commands.registerCommand("naturalChinesePreview.setApiKey", async () => promptAndStoreApiKey(context)),
    vscode.commands.registerCommand("naturalChinesePreview.selectModel", async () => {
      try {
        await selectAndStoreModel(context);
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
