"use strict";

const MarkdownIt = require("markdown-it");
const { isTranslatableInline, stripFrontMatter } = require("./blocks");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(source) {
  const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const originalRenderInline = markdown.renderer.renderInline.bind(markdown.renderer);
  let blockIndex = 0;
  markdown.renderer.renderInline = (tokens, options, env) => {
    const token = { type: "inline", children: tokens, content: "" };
    if (!isTranslatableInline(token)) return originalRenderInline(tokens, options, env);
    const id = `block-${blockIndex++}`;
    return `<span class="ncp-block" data-ncp-id="${id}">${originalRenderInline(tokens, options, env)}</span>`;
  };
  return markdown.render(stripFrontMatter(source));
}

function renderPreviewHtml(source) {
  const body = renderMarkdown(source);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; color: var(--vscode-editor-foreground); padding: 0 26px 64px; max-width: 1000px; margin: auto; }
pre { background: var(--vscode-textCodeBlock-background); padding: 16px; overflow: auto; border-radius: 6px; } code { font-family: var(--vscode-editor-font-family); } :not(pre) > code { background: var(--vscode-textCodeBlock-background); padding: 2px 5px; border-radius: 4px; }
table { border-collapse: collapse; display: block; overflow: auto; } th, td { border: 1px solid var(--vscode-textBlockQuote-border); padding: 6px 13px; } blockquote { border-left: 4px solid var(--vscode-textBlockQuote-border); margin-left: 0; padding-left: 16px; color: var(--vscode-descriptionForeground); }
.ncp-pending { opacity: .68; } .ncp-error { outline: 1px solid var(--vscode-editorWarning-foreground); }
</style></head><body>${body}
<script>
const vscode = acquireVsCodeApi();
const observed = new Set();
const originals = new Map([...document.querySelectorAll('.ncp-block')].map((node) => [node.dataset.ncpId, node.innerHTML]));
let timer;
function reportVisible() {
  const ids = [...document.querySelectorAll('.ncp-block')]
    .filter((node) => { const box = node.getBoundingClientRect(); return box.bottom >= 0 && box.top <= window.innerHeight; })
    .map((node) => node.dataset.ncpId)
    .filter((id) => !observed.has(id));
  if (!ids.length) return;
  ids.forEach((id) => observed.add(id));
  document.querySelectorAll(ids.map((id) => '[data-ncp-id="' + id + '"]').join(','))
    .forEach((node) => node.classList.add('ncp-pending'));
  vscode.postMessage({ type: 'visibleBlocks', ids });
}
addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(reportVisible, 120); }, { passive: true });
addEventListener('resize', reportVisible);
addEventListener('message', (event) => {
  if (event.data?.type === 'restoreEnglish') {
    for (const [id, html] of originals) {
      const node = document.querySelector('[data-ncp-id="' + id + '"]');
      if (node) node.innerHTML = html;
    }
    return;
  }
  if (event.data?.type === 'translateVisible') {
    observed.clear();
    reportVisible();
    return;
  }
  if (event.data?.type === 'translations') {
    for (const item of event.data.items || []) {
      const node = document.querySelector('[data-ncp-id="' + item.id + '"]');
      if (!node) continue;
      node.innerHTML = item.html;
      node.classList.remove('ncp-pending');
    }
  }
});
setTimeout(reportVisible, 0);
</script></body></html>`;
}

module.exports = { renderPreviewHtml, escapeHtml };
