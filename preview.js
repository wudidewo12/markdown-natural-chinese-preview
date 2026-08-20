"use strict";

const { isTranslatableInline, visibleInlineText } = require("./blocks");

const translationsByResource = new Map();
const enhancedKey = Symbol.for("dream-local.natural-chinese-preview.enhanced");

function resourceKey(resource) {
  return typeof resource === "string" ? resource : resource?.toString?.();
}

function setTranslations(resource, translations) {
  const key = resourceKey(resource);
  if (!key) return;
  translationsByResource.set(key, translations);
}

function clearTranslations(resource) {
  const key = resourceKey(resource);
  if (key) translationsByResource.delete(key);
}

function clearAllTranslations() {
  translationsByResource.clear();
}

function getEnvResource(env) {
  return resourceKey(env?.currentDocument);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTranslation(translation, protectedInlines) {
  let html = escapeHtml(translation).replace(/\n/g, "<br>");
  for (const item of protectedInlines || []) {
    html = html.replaceAll(escapeHtml(item.placeholder), item.html);
  }
  return html;
}

function extendMarkdownIt(markdown) {
  if (markdown[enhancedKey]) return markdown;
  markdown[enhancedKey] = true;

  const originalRender = markdown.renderer.render.bind(markdown.renderer);
  const originalRenderInline = markdown.renderer.renderInline.bind(markdown.renderer);
  let blockIndex = 0;

  markdown.renderer.render = (tokens, options, env) => {
    blockIndex = 0;
    return originalRender(tokens, options, env);
  };

  markdown.renderer.renderInline = (tokens, options, env) => {
    const token = { type: "inline", children: tokens, content: "" };
    if (!isTranslatableInline(token)) return originalRenderInline(tokens, options, env);
    const currentIndex = blockIndex;
    blockIndex += 1;
    const translations = translationsByResource.get(getEnvResource(env));
    const expected = translations?.[currentIndex];
    const visible = visibleInlineText(token);
    if (!expected || expected.id !== `block-${currentIndex}` || expected.sourceText !== visible.text.trim()) {
      return originalRenderInline(tokens, options, env);
    }
    return renderTranslation(expected.translatedText, expected.protectedInlines);
  };

  return markdown;
}

module.exports = {
  setTranslations,
  clearTranslations,
  clearAllTranslations,
  extendMarkdownIt,
  renderTranslation
};
