# Markdown 自然中文预览

使用 Vercel AI Gateway，把 VS Code 官方 Markdown Preview 直接切换为自然、流畅的简体中文。

## 使用方法

1. 打开英文 `.md` 文件。
2. 点击 VS Code 的“打开侧边预览”按钮。
3. 在预览页点击闪光按钮“将预览翻译成自然中文”。
4. 首次使用时，在 VS Code 内输入 Vercel AI Gateway Key，并从实时模型列表中选择模型。

### 同事本地化部署（推荐）

1. 把本插件源码放到同事电脑。
2. 在插件目录新建 `.env` 文件，内容如下（仅支持这个变量）：

```ini
AI_GATEWAY_API_KEY=你的Vercel AI Gateway Key
```

3. 如果 `.env` 无法使用，按插件按钮时会让同事手动补充 Key。

> `.env` 是本地文件，不会打包到发布版；同事只需自己在自己机器配置即可。

后续只需点击一次闪光按钮。插件不会修改源 Markdown；标题、列表、表格、链接、强调、图片和代码块继续使用官方 Markdown Preview 排版。点击“恢复英文预览”即可还原。

## 安全和费用

- API Key 保存于 VS Code SecretStorage，不会写入 `settings.json`、项目文件或日志。
- 模型列表从 `https://ai-gateway.vercel.sh/v1/models` 动态读取，不硬编码模型 ID。
- 翻译调用 `https://ai-gateway.vercel.sh/v1/chat/completions`。
- 完整译文默认缓存在本机，缓存键包含文件内容、模型和翻译风格，避免重复请求和费用。
- Markdown 内容会发送给所选模型，请勿翻译组织禁止发送到第三方服务的敏感文档。

实现参考了 VS Code 官方 Markdown 扩展接口以及 MIT 许可的 Markdown Immersive Translate 的预览集成思路。
