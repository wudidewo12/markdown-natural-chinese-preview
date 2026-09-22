"use strict";

const MarkdownIt = require("markdown-it");

const parser = new MarkdownIt({ html: true, linkify: false, typographer: false });

function getAttr(token, name) {
  if (typeof token.attrGet === "function") return token.attrGet(name) || "";
  const attr = (token.attrs || []).find(([key]) => key === name);
  return attr?.[1] || "";
}

function visibleInlineText(token) {
  const protectedInlines = [];
  const children = token.children || [];
  if (children.length === 0) return { text: token.content || "", protectedInlines };

  let protectedIndex = 0;
  const linkStack = [];
  const protect = (html) => {
    const placeholder = `__NCP_PROTECTED_${protectedIndex}__`;
    protectedIndex += 1;
    protectedInlines.push({ placeholder, html });
    return placeholder;
  };

  const text = children.map((child) => {
    if (child.type === "code_inline") {
      return protect(`<code>${escapeHtml(child.content)}</code>`);
    }
    if (child.type === "image") {
      const src = escapeHtml(getAttr(child, "src"));
      const title = getAttr(child, "title");
      const alt = escapeHtml(child.content || getAttr(child, "alt"));
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return protect(`<img src="${src}" alt="${alt}"${titleAttr}>`);
    }
    if (child.type === "link_open") {
      const href = escapeHtml(getAttr(child, "href"));
      const title = getAttr(child, "title");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      linkStack.push(true);
      return protect(`<a href="${href}"${titleAttr}>`);
    }
    if (child.type === "link_close") {
      if (linkStack.length) linkStack.pop();
      return protect("</a>");
    }
    if (child.type === "strong_open") return protect("<strong>");
    if (child.type === "strong_close") return protect("</strong>");
    if (child.type === "em_open") return protect("<em>");
    if (child.type === "em_close") return protect("</em>");
    if (child.type === "s_open") return protect("<s>");
    if (child.type === "s_close") return protect("</s>");
    if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
    if (child.type === "text") return child.content;
    if (child.type === "html_inline") return "";
    return child.content || "";
  }).join("");

  return { text, protectedInlines };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isTranslatableInline(token) {
  if (!token || token.type !== "inline") return false;
  const { text } = visibleInlineText(token);
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return false;
  if (trimmed.startsWith("$$") || trimmed.endsWith("$$")) return false;
  if (/^__NCP_PROTECTED_\d+__$/.test(trimmed)) return false;
  return true;
}

function stripFrontMatter(source) {
  return String(source || "").replace(/^(?:---|\+\+\+)\r?\n[\s\S]*?\r?\n(?:---|\+\+\+)\r?\n?/, "");
}

function collectBlocks(source) {
  const rawSource = String(source || "");
  const markdownSource = stripFrontMatter(rawSource);
  const removedPrefix = rawSource.slice(0, rawSource.length - markdownSource.length);
  const lineOffset = removedPrefix ? removedPrefix.split(/\r?\n/).length - 1 : 0;
  const tokens = parser.parse(markdownSource, {});
  const blocks = [];
  for (const token of tokens) {
    if (!isTranslatableInline(token)) continue;
    const visible = visibleInlineText(token);
    blocks.push({
      id: `block-${blocks.length}`,
      sourceText: visible.text.trim(),
      protectedInlines: visible.protectedInlines,
      startLine: Array.isArray(token.map) ? token.map[0] + lineOffset : undefined,
      endLine: Array.isArray(token.map) ? token.map[1] + lineOffset : undefined
    });
  }
  return blocks;
}

module.exports = { collectBlocks, isTranslatableInline, visibleInlineText, stripFrontMatter };
