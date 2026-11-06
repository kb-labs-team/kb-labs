# Plan: Миграция UI компонентов Agent Plugin на Studio UIKit
## Table of Contents
- [Что найдено](#что-найдено)
  - [Agent CLI — текущие компоненты (проблемные)](#agent-cli-—-текущие-компоненты-проблемные)
  - [Commit Plugin — референс (хороший UI, без CSS-файлов)](#commit-plugin-—-референс-хороший-ui-без-css-файлов)
  - [Studio UIKit — доступные компоненты (подтверждено)](#studio-uikit-—-доступные-компоненты-подтверждено)
- [Task](#task)
- [Phases](#phases)
  - [Phase 1 — Переработка `ConversationView.tsx` + удаление `conversation-view.css`](#phase-1-—-переработка-conversationviewtsx-удаление-conversation-viewcss)
  - [Phase 2 — Переработка `AgentsPage.tsx` + удаление `agents-page.css`](#phase-2-—-переработка-agentspagetsx-удаление-agents-pagecss)
  - [Phase 3 — Мелкие правки `SessionSelector.tsx`](#phase-3-—-мелкие-правки-sessionselectortsx)
- [Порядок выполнения](#порядок-выполнения)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Что найдено

### Agent CLI — текущие компоненты (проблемные)

**Файлы:**
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/ConversationView.tsx` (638 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/SessionSelector.tsx` (95 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/conversation-view.css` (579 строк — кастомный CSS)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/AgentsPage.tsx` (400 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/agents-page.css` (48 строк)

**Диагностированные проблемы:**
1. **`conversation-view.css` — 579 строк кастомного CSS** с хардкодными fallback-цветами (`var(--text-primary, #111827)`, `var(--bg-tertiary, #F3F4F6)`) — CSS-переменные `--text-primary`, `--bg-tertiary`, `--link`, `--success`, `--error` не определены в Studio-окружении, браузер падает на fallback-значения `#111827` и т.д.
2. **`color-mix(in srgb, ...)` везде** — строки 77, 87, 88, 162, 166, 401, 445, 449, 454, 458, 506, 507, 508, 564, 568 CSS — может не работать в старых WebKit движках Studio.
3. **Хардкод тёмной темы** — `.cv-tool-output--terminal { background: #1a1a1a; color: #d4d4d4; border-color: #333; }` — полностью ломает светлую тему Studio.
4. **ConversationView.tsx** использует только 3 UIKit-компонента (`UISpin`, `UIMarkdownViewer`, `UIModalConfirm`) — весь layout через `<div className="cv-...">`.
5. **agents-page.css** — `.agent-input-box` с `border-radius: 12px` захардкожен, `var(--ant-color-border)` частично работает, но лучше перевести на `token.*`.
6. **AgentsPage.tsx** уже активно использует UIKit (`UICard`, `UIButton`, `UISelect`, `UISpace`, `UIIcon`, `useUITheme`), но смешивает с кастомным CSS.
7. **`TodoView`** в ConversationView.tsx — полностью кастомный через `<ul className="cv-todo">`, статусы через emoji-символы.

### Commit Plugin — референс (хороший UI, без CSS-файлов)

**Паттерны из `CommitPlanTab.tsx` (374 строки, 0 CSS-файлов):**
- Весь импорт из `@kb-labs/sdk/studio`: `UICard, UIButton, UIEmptyState, UISpin, UIAlert, UIBadge, UITag, UITooltip, UIIcon, UISpace, UICheckbox, UIInput, UIDropdown, UIPopconfirm, UITypographyText, UIModalConfirm, UIModalError, UIFlex`
- `const { token } = theme.useToken()` (Ant Design) для spacing: `token.marginSM`, `token.colorBorder`
- **Нет ни одного CSS-файла**

### Studio UIKit — доступные компоненты (подтверждено)

- `platform/kb-labs-studio/packages/studio-ui-kit/src/primitives/UIFlex.tsx` — flex layout с design tokens (justify, align, gap)
- `platform/kb-labs-studio/packages/studio-ui-kit/src/data/UITimeline.tsx` — обёртка Ant Design Timeline — идеально для `cv-timeline`
- `platform/kb-labs-studio/packages/studio-ui-kit/src/feedback/UIEmptyState.tsx` — для пустых состояний
- `platform/kb-labs-studio/packages/studio-ui-kit/src/feedback/UIAlert.tsx` — для ошибок инструментов
- `platform/kb-labs-studio/packages/studio-ui-kit/src/layout/UIStack.tsx` — вертикальный stack
- `platform/kb-labs-studio/packages/studio-ui-kit/src/layout/UISpace.tsx` — горизонтальные/вертикальные отступы

---

## Task

**Было:** Agent plugin рендерит UI через 579 строк кастомного CSS с `color-mix()`, хардкодными цветами `#1a1a1a`, `#111827`, несуществующими CSS-переменными `--text-primary` → компоненты рендерятся с неправильными цветами / ломаются в Studio.

**Станет:** Все компоненты используют Studio UIKit по паттерну commit-plugin — через `@kb-labs/sdk/studio`, `theme.useToken()`, без кастомных CSS файлов.

---

## Phases

### Phase 1 — Переработка `ConversationView.tsx` + удаление `conversation-view.css`

Главная работа — несёт весь груз кастомного CSS. Добавить `import { theme } from 'antd'` и `const { token } = theme.useToken()` в ConversationView.

**1.1 — Обёртка и пустые состояния:**
- `<div className="cv">` → `<UIStack gap={6} style={{ padding: '16px 16px 40px' }}>`
- `<div className="cv-empty">` → `<UIFlex justify="center" align="center" style={{ minHeight: 240 }}>`
- `<span className="cv-empty-text">` → `<UITypographyText type="secondary">`

**1.2 — User bubble:**
- `<div className="cv-user">` → `<UIFlex justify="end">`
- `<span className="cv-user-bubble">` → `<div style={{ maxWidth: '68%', background: token.colorFillTertiary, borderRadius: token.borderRadiusLG, padding: '10px 16px', fontSize: token.fontSize }}>`

**1.3 — Timeline / Step dots (главная боль):**
- `<div className="cv-timeline">` → `<UITimeline>` с `items={visibleSteps.map(...)}` — Ant Design Timeline уже содержит точки и линию, поддерживает `color` из tokens
- Fallback если недостаточно гибкий: `<div style={{ borderLeft: \`2px solid ${token.colorBorderSecondary}\`, marginLeft: 7 }}>` + инлайн стили на dot
- Pulse-анимацию (`cv-step-dot--pulse`) оставить как один `<style>` тег (2 строки `@keyframes cv-pulse`) — единственный оставшийся CSS

**1.4 — Tool badges и вывод:**
- `.cv-tool-badge` → `<UITag style={{ fontFamily: 'monospace', fontSize: 11 }}>`
- `.cv-tool-output--terminal` (хардкод `#1a1a1a`) → `<pre style={{ background: token.colorBgSpotlight, color: token.colorTextLightSolid, borderRadius: token.borderRadius, padding: token.paddingSM, fontFamily: 'monospace', fontSize: 12 }}>`
- `.cv-tool-output--error` → `background: token.colorErrorBg, color: token.colorError, borderColor: token.colorErrorBorder`
- `.cv-tool-output--code` → `background: token.colorFillAlter, border: \`1px solid ${token.colorBorderSecondary}\``
- `DiffView` (строки 458–473): `token.colorSuccessText` для `+`, `token.colorErrorText` для `-`, `token.colorInfoText` для `@@`
- `<button className="cv-tool-header">` → `<button style={{ all: 'unset', cursor: canExpand ? 'pointer' : 'default', display: 'flex', gap: token.marginXS }}>`

**1.5 — FileChangesBlock:**
- `<div className="cv-changes-block">` → `<UICard size="small" style={{ marginTop: 4 }}>`
- `.cv-changes-btn--approve` → `<UIButton size="small" type="text" icon={<UIIcon name="CheckOutlined"/>}>`
- `.cv-changes-btn--rollback` → `<UIButton size="small" type="text" danger icon={<UIIcon name="CloseOutlined"/>}>`
- `.cv-changes-op--new/mod/del` → `<UITag color="success">new</UITag>` / `<UITag color="blue">mod</UITag>` / `<UITag color="error">del</UITag>`
- `<ul className="cv-changes-list">` → `<UISpace direction="vertical" size={2} style={{ width: '100%' }}>`
- Rollback per-file: заменить `UIModalConfirm` → `UIPopconfirm` (менее агрессивный UX)

**1.6 — TodoView:**
- `<div className="cv-todo">` → `<UICard size="small" style={{ marginTop: 6 }}>`
- Todo items → `<UISpace direction="vertical" size={2}>` + `<UIFlex gap={2} align="center">` + `<UITypographyText type="secondary"|"danger">`

**Обновить импорты в `ConversationView.tsx`:**
```ts
import { theme } from 'antd';
import {
  UISpin, UIMarkdownViewer, UIModalConfirm, UIFlex, UIStack, UITag,
  UICard, UIButton, UISpace, UIAlert, UIPopconfirm, UIIcon,
  UITypographyText, UITimeline
} from '@kb-labs/sdk/studio';
// Удалить: import './conversation-view.css';
```

**Удалить файл:** `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/conversation-view.css`

### Phase 2 — Переработка `AgentsPage.tsx` + удаление `agents-page.css`

`AgentsPage.tsx` уже хорошо использует UIKit, нужно убрать зависимость от кастомного CSS для input-box:

- Добавить `import { theme } from 'antd'` + `const { token } = theme.useToken()`
- `.agent-input-box` (строки 5–25 в agents-page.css) → `<div style={{ border: \`1px solid ${focused ? token.colorPrimary : token.colorBorder}\`, borderRadius: token.borderRadiusLG, background: token.colorBgContainer, overflow: 'hidden' }}>` + `const [focused, setFocused] = useState(false)` с `onFocus`/`onBlur`
- Убрать `import './agents-page.css'` из `AgentsPage.tsx:13`
- **Удалить файл:** `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/agents-page.css`

### Phase 3 — Мелкие правки `SessionSelector.tsx`

- Добавить `const { token } = theme.useToken()`
- Строка 49: `style={{ flex: 1, minWidth: 200 }}` → `style={{ flex: 1, minWidth: token.controlWidth }}`

---

## Порядок выполнения

1. `ConversationView.tsx` — Phase 1 (приоритет, несёт всю боль от CSS)
2. Удалить `conversation-view.css`
3. `AgentsPage.tsx` — Phase 2 (быстрая правка)
4. Удалить `agents-page.css`
5. `SessionSelector.tsx` — Phase 3 (минимальные правки)

---

## Risks

1. **`UITimeline`** — Ant Design Timeline props `items` с `dot`, `color`, `children` — гибкий, но нужно проверить рендеринг внутри scroll-контейнера AgentsPage (может быть overflow issue)
2. **Pulse-анимация** — единственное место, где остаётся `@keyframes` — можно вставить через `<style>` тег прямо в компонент, чтобы не создавать CSS-файл
3. **`token.colorBgSpotlight`** — доступен в Ant Design 5.x; если версия старше — заменить на `token.colorBgMask`
4. **`UIFlex` gap** — принимает `UIBoxSpacingValue` (spacing tokens), не числа напрямую — использовать `token.marginXS` в `style` где нужна точность

---

## Verification

```bash
# TypeScript проверка agent-cli — убеждаемся что все новые импорты корректны
pnpm --filter @kb-labs/agents/cli typecheck

# Сборка agent-cli — убеждаемся что нет ошибок компиляции
pnpm --filter @kb-labs/agents/cli build

# Сборка всего agents плагина — проверяем интеграцию
pnpm --filter @kb-labs/kb-labs-agents build

# Проверка что commit-plugin (референс) не сломался
pnpm --filter @kb-labs/commit/cli build

# Визуальная проверка в Studio dev-режиме:
# - открыть Agent page, убедиться что conversation view рендерится корректно
# - проверить светлую и тёмную темы
# - проверить terminal output (бывший #1a1a1a)
# - проверить FileChangesBlock (approve/rollback кнопки)
pnpm --filter @kb-labs/kb-labs-studio dev
```

---

## Approval

План готов. Жду подтверждения перед началом реализации.
