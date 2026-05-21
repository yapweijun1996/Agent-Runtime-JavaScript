# Long Task Lab — UI/UX & PWA Audit

> Date: 2026-05-20  
> Auditor: Claude Sonnet 4.6  
> Method: Static code review (layout.css, buttons.css, forms.css, tokens.css, App.tsx, index.html, manifest.webmanifest, sw.js)  
> Chrome DevTools MCP: unavailable (browser conflict) — pending live re-audit

---

## 总结评级

| 区域 | 评级 | 严重问题数 |
|------|------|----------|
| Topbar | B+ | 2 |
| Sidebar / Collapse | B | 3 |
| PWA | C+ | 4 |
| 无障碍 / 触摸目标 | C+ | 3 |
| 性能 | B | 1 |

---

## 1. Topbar 问题

### T1 — 汉堡按钮不反映 sidebar 状态 【P1】

**现状：** 展开和折叠状态下都显示 `<Menu>` 图标，用户无法从图标判断当前状态和点击效果。

**建议：** 折叠时改用 `<PanelLeftOpen>`，展开时用 `<PanelLeftClose>`（lucide-react 均有）。或给按钮加 `aria-expanded` + `aria-label` 变化。

```tsx
// App.tsx — 当前
<Menu size={18} />

// 建议
{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
```

同时加 `aria-expanded={!sidebarCollapsed}` 到按钮。

---

### T2 — 执行中状态无动态指示器 【P2】

**现状：** `status-pill.executing` 只有蓝色文字，无脉冲动画。用户需要看文字才知道在跑。

**建议：** 给 `.status-pill.executing` 加轻微呼吸动画，或在 pill 左侧加一个跑动的圆点（类似 `nav-run-dot` 的 `nav-run-pulse`）。

```css
/* buttons.css */
.status-pill.executing {
  animation: pill-pulse 2s ease-in-out infinite;
}
@keyframes pill-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
}
```

---

### T3 — 移动端 topbar-title 截断过短 【P3】

**现状：** `max-width: 110px`，"Long Task Lab" 14字符约 105px，在小屏幕会被 ellipsis 截断。

**建议：** 调整到 `max-width: 140px` 或用 `font-size: var(--font-sm)` 缩字体代替截断。

---

## 2. Sidebar / Collapse 问题

### S1 — 折叠状态触摸目标 38px < 44px 【P1 - 无障碍】

**现状：** `.sidebar-collapsed .nav-item { width: 38px; min-height: 38px; }` — 低于 Apple HIG 和 WCAG 2.5.5 的 44px 最小触摸目标要求。

**建议：** 折叠状态改为 `width: 44px; min-height: 44px;` 并相应调整 `--sidebar-w` collapsed 值（从 56px 调到 60px）。

```css
/* layout.css */
.app-shell.sidebar-collapsed { --sidebar-w: 60px; }

.sidebar-collapsed .nav-item {
  justify-content: center;
  padding: 0;
  width: 44px;
  min-height: 44px;
}
```

---

### S2 — 折叠状态缺少 tooltip 【P2】

**现状：** 折叠后 label 消失，`title` 属性虽然存在但原生 tooltip 延迟太长（约 500ms），体验差。

**建议：** 已在 App.tsx 中有 `title={sidebarCollapsed ? page.label : undefined}` — 这是 OK 的基线，但可以加 CSS tooltip 替代原生 title 获得更好体验（可作为 P3 改善）。

---

### S3 — Active vs Hover 颜色相同 【P2】

**现状：**
```css
.nav-item:hover:not(.active) { background: var(--color-surface); }
.nav-item.active { background: var(--color-surface); }
```
两者背景完全相同，只靠 `color` (`--color-text` vs `--color-ink`) 区分 — 对比度不足。

**建议：** Active 状态用更高亮的背景或加左侧 accent 条：
```css
.nav-item.active {
  background: rgba(90, 200, 245, 0.12); /* accent teal 低饱和 */
  color: var(--color-ink);
}
```
或在 `.nav-item.active::before` 加 2px 左边框 accent 条（macOS Finder / VS Code 风格）。

---

### S4 — nav-item 默认 min-height 38px 【P2 - 无障碍】

**现状：** `.nav-item { min-height: 38px }` — 低于 44px 最小值。

**建议：** 改为 `min-height: 44px`（展开状态），保持视觉紧凑可通过 padding 调整。

---

## 3. PWA 问题

### P1 — Service Worker 不缓存 app bundle 【P0 - 关键】

**现状：** `sw.js` 的 `SHELL_ASSETS` 只缓存：
```js
'/', '/offline.html', '/robots.txt', '/llms.txt', '/manifest.webmanifest', '/icons/*.png'
```
Vite build 生成的哈希 JS/CSS 文件（`/assets/index-DxsTP4mH.js`）**不在缓存列表**。

**影响：** PWA 安装后如果没有网络，点击图标会打开 `offline.html`，无法运行 app。这使 "离线 PWA" 声称失效。

**建议：** 使用 Vite PWA Plugin (`vite-plugin-pwa`) 自动注入 precache manifest，或在 build 完成后生成 `precache-manifest.json` 供 SW 读取。

---

### P2 — manifest 缺少 screenshots 【P1 - Lighthouse】

**现状：** Lighthouse PWA 审计中 "Provides installability requirements" 中，缺少 `screenshots` 字段会降低 "Richer Install UI" 评分。

**建议：** 添加至少一张截图：
```json
"screenshots": [
  {
    "src": "/screenshots/desktop.png",
    "sizes": "1280x800",
    "type": "image/png",
    "form_factor": "wide",
    "label": "Long Task Lab mission control"
  }
]
```

---

### P3 — 缺少 iOS PWA status bar meta 【P2】

**现状：** `index.html` 缺少：
```html
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

**影响：** iOS Safari PWA 安装后状态栏颜色不匹配 `#111318` 深色主题。

---

### P4 — `display_override: ["window-controls-overlay"]` 风险 【P2】

**现状：** `manifest.webmanifest` 中设置了 `window-controls-overlay`，这是实验性 API，只有 Chromium 127+ 支持，在 Firefox/Safari 上会 fallback 但可能导致标题栏布局意外。

**建议：** 如果没有自定义标题栏逻辑，可以移除 `window-controls-overlay`，保留 `["standalone", "browser"]`。

---

### P5 — SW cache name 手动管理 【P2】

**现状：** `CACHE_NAME = 'agrun-long-task-lab-shell-v3'` — 手动版本号，忘记更新会导致用户拿到过期 SW。

**建议：** 使用 Vite build time 注入变量：
```js
const CACHE_NAME = 'agrun-shell-__BUILD_HASH__';
// vite.config.ts: define: { '__BUILD_HASH__': JSON.stringify(Date.now()) }
```

---

## 4. 无障碍问题

### A1 — icon-button 缺少 focus-visible 样式 【P1】

**现状：** `buttons.css` 中 `.icon-button` 没有 `:focus-visible` 规则。键盘用户按 Tab 无法看到焦点。（`input/select` 有 focus-visible，但 button 没有）

**建议：**
```css
.primary-button:focus-visible,
.secondary-button:focus-visible,
.icon-button:focus-visible {
  outline: 2px solid var(--color-accent-2);
  outline-offset: 2px;
}
```

---

### A2 — nav-item 无 focus-visible 【P1】

同上，`.nav-item:focus-visible` 也未定义。

---

### A3 — 移动底部导航 6 个 tab 【P3】

Apple HIG 建议 TabBar 最多 5 个 tab。6 个会导致每个 tab 宽度约 58px（375px / 6），图标+文字拥挤，小屏幕下文字可能不可读。

**建议：** 考虑将 "Debug" tab 合并进 "Run" 页面的子 tab，或隐藏到 "…" 更多菜单。

---

## 5. 性能问题

### Perf1 — 主 bundle 1.45MB (gzip 390KB) 【P2】

**现状：** Vite build 输出 `index-DxsTP4mH.js 1,452KB (gzip 390KB)` — 属于大型单一 chunk。

已有 vendor splits（react-vendor, runtime-vendor, ui-vendor），但核心 app chunk 仍然 ~1.45MB。

**建议：** 检查是否有大型依赖被意外打进 app chunk（如 marked.js / prism）。可使用 `vite-bundle-analyzer` 分析。

---

## 优先级排序

| 优先级 | 问题 | 影响 |
|--------|------|------|
| **P0** | SW 不缓存 bundle → PWA 离线失效 | 功能 |
| **P1** | 汉堡图标无状态反馈 | UX |
| **P1** | focus-visible 缺失 | 无障碍 |
| **P1** | 触摸目标 38px < 44px | 无障碍 |
| **P2** | Active vs Hover 颜色相同 | 视觉区分 |
| **P2** | 执行状态无动态指示 | UX |
| **P2** | manifest 缺 screenshots | PWA 评分 |
| **P2** | 缺少 iOS status-bar meta | PWA/iOS |
| **P2** | SW cache 手动版本 | 维护风险 |
| **P3** | 底部导航 6 tabs | 移动 UX |
| **P3** | topbar 移动截断 | 小屏 UX |
