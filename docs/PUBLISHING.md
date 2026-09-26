# 发布到 Microsoft Edge 加载项商店

本文档记录提交所需的材料与步骤。

---

## 1. 隐私政策托管（必做）

Edge 商店**强制要求**提供可公开访问的隐私政策 URL。

### 用 GitHub Pages 免费托管（推荐）

1. 在仓库里建一个 `docs/` 目录，把 `PRIVACY.md` 复制进去：

   ```
   pumpkin-star/
   └── docs/
       └── privacy.md
   ```

2. 如果希望有更好的排版，给 `docs/privacy.md` 加一段 Jekyll 头：

   ```markdown
   ---
   layout: default
   title: Pumpkin Star 隐私政策
   ---
   ```

   或者更简单：把它转成 `docs/privacy.html`，GitHub Pages 直接就能渲染。

3. 在 GitHub 仓库页面进入 **Settings → Pages**：
   - Source 选 `Deploy from a branch`
   - Branch 选 `main`，目录选 `/docs`
   - 保存

4. 等 1~2 分钟，URL 形如：

   ```
   https://<your-username>.github.io/pumpkin-star/privacy
   ```

5. **把 PRIVACY.md 里的 `<your-username>` 替换成真实用户名**，再提交。

> 验证：用无痕窗口打开该 URL，确认能正常访问（商店审核员会实际打开它）。

---

## 2. 打包

```bash
# 在项目根目录执行
# 需要 manifest.json 位于 zip 的根层，不能多套一层文件夹
```

**PowerShell（Windows）：**

```powershell
$src = "D:\Games\deepseek\20260926\pumpkin-star"
$dst = "$env:TEMP\pumpkin-star.zip"
if (Test-Path $dst) { Remove-Item $dst }

# 只打包运行所需文件，排除开发用的 tools/
$tmp = "$env:TEMP\ps-build"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null

Copy-Item "$src\manifest.json" $tmp
Copy-Item "$src\icons" $tmp -Recurse
Copy-Item "$src\src" $tmp -Recurse
Copy-Item "$src\README.md" $tmp
Copy-Item "$src\LICENSE" $tmp
Copy-Item "$src\PRIVACY.md" $tmp

Compress-Archive -Path "$tmp\*" -DestinationPath $dst
Write-Host "已生成: $dst"
```

**关于是否包含 `tools/`：**
- 不包含 → 包更小，审核更快（推荐）
- 包含 → 也无妨，它们不含敏感内容，但会略微增加体积

**打包后自检：**

```bash
# zip 解开后根目录应当直接看到 manifest.json
unzip -l pumpkin-star.zip | head -20
```

---

## 3. 商店表单填写对照

以下是本项目对应的填写内容，可直接复制。

### 单一用途描述

```
Pumpkin Star 是一个浏览器侧边栏 AI 智能体，用自然语言指令操作当前网页：
读取页面内容、点击/填写/滚动页面、翻译与总结页面、临时修改页面样式，
并把结果导出为文件。所有页面操作都由用户在当前对话中主动触发。
```

### 权限理由

**`sidePanel`**
```
提供扩展的主界面。用户点击工具栏图标或按 Alt+J 打开的侧边栏就是在此渲染的，
对话、设置、技能面板、用量统计等全部界面都在侧边栏内。
```

**`storage`**
```
在本地保存用户设置（API 地址、密钥、模型名、外观偏好）、对话记忆、
自进化积累的技能与规则、token 用量统计。这些数据仅存于浏览器本地
(chrome.storage.local)，不会上传到任何服务器。
```

**`activeTab`**
```
在用户主动下达指令时，读取并操作【当前活动标签页】。例如"总结这个页面"
需要读取当前页正文，"点登录按钮"需要在当前页触发点击。
扩展不会在后台主动访问任何标签页。
```

**`scripting`**
```
用于向当前页面注入内容脚本。当用户在扩展安装前就已打开的页面上下达指令时，
需要补注入脚本才能读取页面内容与执行操作。注入仅在用户触发任务时发生。
```

**`tabs`**
```
用于获取当前活动标签页的标题与网址，以便：判断该页面是否可操作
（如 edge:// 等浏览器内置页会拒绝）、为自进化功能按域名匹配对应的站点技能。
```

**主浏览器（`<all_urls>`）**
```
扩展的核心功能是"在任意网页上替用户执行操作"，因此需要在用户当前浏览的
任意网站上读取 DOM 并派发事件。这包括翻译整页、提取信息、填写表单等场景。

扩展不会在后台自动浏览网页，也不会收集浏览历史——所有页面访问都由用户
在当前对话中明确触发。请求的 <all_urls> 权限仅用于内容脚本注入，
不会向任何第三方发送页面地址或内容。
```

**`debugger`（可选权限，若审核问询）**
```
该权限声明为 optional_permissions，默认不申请。仅在用户于设置中主动开启
「真实输入模式」时，浏览器才弹出授权提示。

用途：通过浏览器调试协议派发 Input.dispatchMouseEvent，产生 isTrusted=true
的输入事件，以兼容少数有反自动化检测的网站。关闭该模式后不再使用该权限。
```

### 远程代码

选择：**否，我未使用远程代码**

这是准确的 —— 项目无外部依赖、无动态 `import()` 远程模块、无动态
`<script src>`。对模型 API 的调用是 `fetch` 数据请求，不涉及加载代码。

### 数据用途（勾选）

| 项 | 勾选 |
| --- | --- |
| 个人身份信息 | ✅ |
| 个人通信 | ✅ |
| 网站内容 | ✅ |
| 健康信息 | ❌ |
| 财务与付款信息 | ❌ |
| 身份验证信息 | ❌ |
| 位置 | ❌ |
| Web 历史记录 | ❌ |
| 用户活动 | ❌ |
| 网站列表 | ❌ |

**勾选理由：**

- **个人身份信息**：用户填写的自定义 API Key。仅存本地、仅发往用户自己填的服务商。
- **个人通信**：剪贴板读写功能会接触用户复制的内容。由用户主动点击触发，不后台读取。
- **网站内容**：核心功能是读取当前页面正文/结构用于翻译总结改造，需发往用户配置的模型服务。

**未勾选「位置」的原因**：扩展不请求任何地理位置 API。页面里可能出现地址文本，
但那属于「网站内容」范畴，不是位置数据。

### 我确认以下内容属实

三条**都可以勾选**，已逐条核对：

- ✅ 不向第三方出售或传输用户数据
- ✅ 不将数据用于与单一用途无关的用途
- ✅ 不将数据用于判定信用度或放贷

---

## 4. 提交前清单

- [ ] 隐私政策已托管，URL 可公开访问（无痕窗口验证过）
- [ ] PRIVACY.md 里的 `<your-username>` 已替换为真实用户名
- [ ] zip 包解压后 `manifest.json` 在根层
- [ ] 版本号已更新（`manifest.json` 的 `version`）
- [ ] 商店描述中说明了**需要自备 API Key**（否则用户装上会用不了）
- [ ] 准备至少 1 张截图（1280×800 或 640×400）
- [ ] 本地跑一遍 `node tools/test.mjs` 确认全部通过

---

## 5. 可能的审核问题与应对

**Q: 为什么需要 `<all_urls>`？**

> 核心功能是在任意网页上替用户操作。扩展不会后台浏览，所有访问由用户
> 在当前对话中明确触发。如果限制域名范围，将无法实现"翻译任意页面"
> 这类基础能力。

**Q: `debugger` 权限是否必要？**

> 它是可选权限，默认不申请，仅用于兼容少数有反自动化检测的网站。
> 主流程完全不需要它。如果审核方认为不可接受，可以移除该功能后重新提交。

**Q: 用户数据发往何处？**

> 只发往用户自己在设置中填写的 API 地址（默认是 DeepSeek 官方接口，
> 也可改为本地 Ollama 等）。扩展没有自建服务器，开发者无法访问任何用户数据。
> 详见隐私政策。

**Q: 是否会记录用户的浏览内容？**

> 不会。扩展不保存浏览历史，页面内容仅在用户下达任务时读取并转发给
> 用户配置的模型服务商，不存储在扩展中、不回传开发者。
