# MemeHelper

Windows 表情包模板编辑与生成工具。

## 使用

下载 `MemeHelper-2.1.1-windows-x64.7z`，完整解压后运行其中的 `MemeHelper.exe`。应用已迁移到 Tauri，发布目录只有 EXE 和两个 JSON 文件，不再附带 Electron/Chromium 文件。

- 新建模板：添加固定图层、矩形/圆形/圆角矩形照片区域和文字图层，拖动或缩放后保存。
- 编辑模板：调整图层位置、尺寸、旋转与顺序；支持图层锁定、多选、组合、对齐、等距分布、复制粘贴、`Delete` 快速删除和完整右键菜单。
- 文字图层：支持字体、字号、自动适配、颜色、描边、阴影、背景、加粗、斜体、下划线、删除线和对齐方式。
- 模板库：支持 JSON 模板包导入与发布、收藏、标签搜索、最近使用及名称排序。
- 使用模板：进入后直接预览模板；左栏会列出全部可替换图层，点击图层或画布中的高亮区域即可选择图片，也可以把图片拖进对应区域。
- 结果调整：在结果画布中拖动、自由拉伸可替换照片；双击照片进入裁切模式，可独立缩放和平移照片；滚轮以光标所在位置为中心缩放画布，按住空白处拖动可平移视图；按 `Ctrl+Z`/`Ctrl+Shift+Z` 可撤销或重做。
- 结果操作：生成完成后会自动复制；可粘贴到聊天窗口、图片软件或资源管理器文件夹，也可右键结果复制，或按 1x/2x/3x 导出 PNG、JPEG、WebP，并可使用透明背景。
- 快速返回：在模板编辑页或使用页按 `Esc` 返回模板库。

目录版中的 `templates.json` 和 `config.json` 与 `MemeHelper.exe` 位于同一目录：

- `templates.json`：内置模板和用户创建、编辑后的模板。
- `config.json`：全局主题、窗口尺寸、模板文件名和自动复制设置。

旧版本保存在 AppData 中的模板会在首次启动时自动合并到同目录的 `templates.json`。

配置示例：

```json
{
  "theme": "system",
  "autoCopy": true,
  "templatesFile": "templates.json",
  "window": {
    "width": 1320,
    "height": 860,
    "minWidth": 1024,
    "minHeight": 680
  }
}
```

`theme` 可填写 `system`、`light` 或 `dark`。`system` 会跟随 Windows 的深浅色设置，并在系统主题变化时即时切换。

应用代码、字体、图标和界面资源全部随 EXE 打包，断网也能运行。Tauri 使用 Windows 自带或已安装的 WebView2 系统组件，不会在运行时访问 CDN 或下载页面资源。

## 发布内置模板

1. 使用开发模式启动程序并创建或编辑模板。
2. 回到模板库，点击“发布模板包”。
3. 开发模式会直接更新 `src/bundled-templates.json`。
4. 运行 `npm run build`，模板会复制为 EXE 同目录的 `templates.json`。
5. 将生成的 `.7z` 发布包上传到 GitHub Release。

目录版运行时，模板的新增和修改会直接写入 EXE 同目录的 `templates.json`。

## 开发

```powershell
npm install
npm run dev
```

构建 Tauri 目录版并生成高压缩发布包：

```powershell
npm run build
```

输出位于 `release-tauri/MemeHelper-2.1.1/`。构建机需要 Rust；Windows SDK 可由 Visual Studio Build Tools 提供，项目构建脚本也会自动使用本机已有的 `cargo-xwin` SDK 缓存。
