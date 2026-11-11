# План миграции UI компонентов Agent Plugin → Studio UIKit
## Table of Contents
- [Task](#task)
- [Findings](#findings)
  - [Проблемы в agent-cli (что рендерится криво)](#проблемы-в-agent-cli-что-рендерится-криво)
  - [Паттерн commit-plugin (хороший референс)](#паттерн-commit-plugin-хороший-референс)
  - [Studio UIKit — доступные компоненты (через `@kb-labs/sdk/studio`)](#studio-uikit-—-доступные-компоненты-через-@kb-labssdkstudio)
  - [`UIDiffViewer` — готовый компонент для диффов](#uidiffviewer-—-готовый-компонент-для-диффов)
- [Steps / Phases](#steps-phases)
  - [Фаза 1 — Убрать CSS из `AgentsPage.tsx` (~30 мин)](#фаза-1-—-убрать-css-из-agentspagetsx-30-мин)
  - [Фаза 2 — Переписать `ConversationView.tsx` на UIKit (~2-3 ч)](#фаза-2-—-переписать-conversationviewtsx-на-uikit-2-3-ч)
  - [Фаза 3 — Доработка `SessionSelector.tsx` (~15 мин)](#фаза-3-—-доработка-sessionselectortsx-15-мин)
- [Risks](#risks)
- [Verification](#verification)
## Task
**A (сейчас):** `ConversationView.tsx`, `SessionSelector.tsx`, `AgentsPage.tsx` используют кастомные CSS-классы (`cv-*`, `.agent-input-box`) и хардкоженные цвета. Компоненты рендерятся криво.

**B (цель):** Все Studio-компоненты agent-cli используют `@kb-labs/sdk/studio` UIKit по паттерну commit-plugin — `UICard`, `UIFlex`, `UISpace`, `UIButton`, `UITag`, `UIIcon`, `UITypographyText`, `theme.useToken()`. Никаких кастомных CSS файлов.

---

## Findings

### Проблемы в agent-cli (что рендерится криво)

**`plugins/kb-labs-agents/packages/agent-cli/src/studio/components/ConversationView.tsx`** (638 строк, главная проблема):
- `:9` — `import './conversation-view.css'` (12 KB CSS — весь layout через классы `cv-*`)
- `:21` — `style={{ marginLeft: 8, color: '#999', fontSize: 13 }}` — хардкоженные цвета
- `:183-209` — кастомные `<button className="cv-changes-btn">` вместо `UIButton`
- `:198-208` — кастомные `<ul>/<li>` вместо UIKit-списков
- `:270-305` — `FileChangeRow` с `<li className="cv-change-row">`
- `:396-413` — кастомные `<pre className="cv-tool-output">` (код/диф/терминал)
- `:441-456` — `TodoView` — `<ul>/<li className="cv-todo-item">`
- `:458-474` — `DiffView` — `<pre className="cv-diff">` с ручной раскраской цветов
- `:486-490` — `CopyPath` — `<button className="cv-copy-path">`
- `:552-638` — `ToolRow` — полностью на кастомных `<div>`/`<button>`

**`plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/AgentsPage.tsx`** (400 строк, частично уже использует UIKit):
- `:13` — `import './agents-page.css'` — `.agent-input-box`, `.agent-input-toolbar`
- `:256` — `style={{ padding: 16, height: '100%' }}` — хардкоженные значения
- `:297-395` — input box на голом `<div className="agent-input-box">` + `.agent-input-toolbar`
- `:8` — уже импортирует `UIInputTextArea, UIButton, UICard` — хорошая база, нужны только правки

**`plugins/kb-labs-agents/packages/agent-cli/src/studio/components/SessionSelector.tsx`** (95 строк):
- Уже почти полностью на UIKit. Мелкая правка: `style={{ opacity: 0.5 }}` → токены.

### Паттерн commit-plugin (хороший референс)
- `plugins/kb-labs-commit-plugin/packages/commit-cli/src/studio/components/CommitPlanTab.tsx:7-14` — импорт только из `@kb-labs/sdk/studio` + `const { token } = theme.useToken()`
- `CommitPlanTab.tsx:193` — `style={{ gap: token.marginSM }}` — токены вместо хардкода
- `plugins/kb-labs-commit-plugin/packages/commit-cli/src/studio/pages/CommitOverview.tsx:7` — использует `UIPage`, `UIPageHeader`, `UITabs`
- **Нет ни одного `.css` файла** в `commit-cli/src/studio/` — это цель для agent-cli

### Studio UIKit — доступные компоненты (через `@kb-labs/sdk/studio`)
- Layout: `UIFlex`, `UISpace`, `UICard`, `UIPage`, `UIPageHeader`, `UITabs`
- Core: `UIButton`, `UIIcon`, `UITypographyText`, `UISpin`, `UISelect`, `UIInput`, `UIInputTextArea`, `UITag`, `UIBadge`
- Feedback: `UIAlert`, `UIEmptyState`, `UIMessage`, `UIModalConfirm`, `UIModalError`
- Form: `UICheckbox`, `UISwitch`, `UIPopconfirm`
- **Content: `UIDiffViewer`, `UIMarkdownViewer`, `UIJsonViewer`** ← ключевая находка!

### `UIDiffViewer` — готовый компонент для диффов
- `platform/kb-labs-studio/packages/studio-ui-kit/src/content/UIDiffViewer.tsx`
- Props: `diff: string`, `showLineNumbers?`, `maxHeight?`, `className?`, `style?`
- Полностью заменяет кастомный `DiffView` из `ConversationView.tsx:458-474`

---

## Steps / Phases

### Фаза 1 — Убрать CSS из `AgentsPage.tsx` (~30 мин)

`agents-page.css` задаёт только `.agent-input-box` (border, border-radius 12px, focus-shadow) и `.agent-input-toolbar` (flex, padding). Всё это легко выражается через токены Ant Design.

1. Удалить `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/agents-page.css`
2. `AgentsPage.tsx:13` — убрать `import './agents-page.css'`
3. `AgentsPage.tsx:256` — `style={{ padding: 16 }}` → `style={{ padding: token.paddingMD }}`
4. `AgentsPage.tsx:297` — `<div className="agent-input-box">` заменить на `<UICard size="small">` с focus-state:
   ```tsx
   const [focused, setFocused] = React.useState(false);
   // ...
   <UICard size="small" style={{ borderRadius: token.borderRadiusLG, border: `1px solid ${focused ? token.colorPrimary : token.colorBorderSecondary}` }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
   ```
5. `AgentsPage.tsx:369-393` — `<div className="agent-input-toolbar">` → `<UIFlex justify="space-between" align="center" style={{ padding: `${token.paddingXS}px ${token.paddingSM}px` }}>`

### Фаза 2 — Переписать `ConversationView.tsx` на UIKit (~2-3 ч)

Сначала добавить `const { token } = theme.useToken()` в функциональные компоненты по паттерну `CommitPlanTab.tsx:14`. Затем переписать снизу вверх — от атомарных к составным:

**2.1 — `CopyPath` (строки 476-490)**:
`<button className="cv-copy-path">` → `<UIButton type="text" size="small" icon={<UIIcon name="CopyOutlined" />}>`

**2.2 — `DiffView` (строки 458-474) → удалить полностью**:
```tsx
// Было: <DiffView diff={step.metadata!.diff!} />
// Станет: <UIDiffViewer diff={step.metadata!.diff!} maxHeight={400} />
```
Импортировать `UIDiffViewer` из `@kb-labs/sdk/studio` вместо кастомной функции.

**2.3 — `TodoView` (строки 437-456)**:
`<ul>/<li className="cv-todo-item--completed">` → `<UIFlex vertical gap={token.marginXS}>` + строки через `<UIFlex align="center" gap={token.marginXS}>` + `<UITag>` для статуса/приоритета

**2.4 — `ToolDetails` (строки 373-416) — `<pre className="cv-tool-output">`**:
`<pre>` → `<UITypographyText code style={{ display: 'block', maxHeight: 300, overflow: 'auto', fontSize: token.fontSizeSM, padding: token.paddingSM, background: token.colorFillSecondary }}>`

**2.5 — `ToolRow` (строки 527-638)**:
- `<div className="cv-step cv-step--tool">` → `<UIFlex align="flex-start" gap={token.marginXS}>`
- `.cv-step-dot--pulse` (pending/streaming) → `<UISpin size="small" />`
- `.cv-step-dot--result-ok` → `<UIIcon name="CheckCircleOutlined" style={{ color: token.colorSuccess }}>`
- `.cv-step-dot--result-err` → `<UIIcon name="CloseCircleOutlined" style={{ color: token.colorError }}>`
- `<button className="cv-tool-header--clickable">` → `<UIButton type="text" size="small" onClick={...}>`
- Бейджи (resultCount, badge) → `<UITag>`
- Раскрытая секция → `<UICard size="small">`

**2.6 — `StepRow` (строки 312-371)**:
- `<div className="cv-step cv-step--insight">` → `<UIFlex align="flex-start" gap={token.marginXS}>`
- `thinking` step → `<UICard size="small" style={{ background: token.colorFillQuaternary }}>`
- `tool_result` → `<UITag color="success">` / `<UITag color="error">` + duration через `UITypographyText type="secondary"`
- `error` step → `<UIAlert type="error" message={step.message} banner />`
- `subagent` step → `<UITag icon={<UIIcon name="RobotOutlined"/>}>`

**2.7 — `FileChangeRow` (строки 219-306)**:
- `<li className="cv-change-row">` → `<UICard size="small">`
- `<button className="cv-change-main">` → `<UIButton type="text" style={{ width: '100%', textAlign: 'left' }}>`
- Бейдж операции: `new` → `<UITag color="green">`, `del` → `<UITag color="red">`, `mod` → `<UITag>`
- `+N/-N` статистика → `<UITypographyText style={{ color: token.colorSuccess }}>` / `token.colorError`

**2.8 — `FileChangesBlock` (строки 129-211)**:
- `<div className="cv-changes-body">` → `<UICard size="small">`
- `<button className="cv-changes-btn--approve">` → `<UIButton size="small" icon={<UIIcon name="CheckOutlined"/>}>`
- `<button className="cv-changes-btn--rollback">` → `<UIButton size="small" danger icon={<UIIcon name="RollbackOutlined"/>}>`
- `<ul className="cv-changes-list">` → `<UIFlex vertical gap={token.marginXS}>`

**2.9 — `TurnView` (строки 43-119) — пузыри**:
- `<div className="cv-user-bubble">` → `<UICard size="small" style={{ background: token.colorBgLayout, maxWidth: '80%', alignSelf: 'flex-end' }}>`
- `<div className="cv-timeline">` → `<UIFlex vertical gap={token.marginXS}>`
- `<div className="cv-assistant">` → `<UIFlex vertical gap={token.marginSM}>`

**2.10 — `ConversationView` (строки 17-41) — верхний уровень**:
- `<div className="cv-empty"><UISpin/><span style={{ color: '#999' }}>` → `<UIFlex align="center" gap={token.marginSM}><UISpin size="small"/><UITypographyText type="secondary">Loading history...</UITypographyText></UIFlex>`
- `<div className="cv-empty"><span className="cv-empty-text">` → `<UIEmptyState description="Ask anything to get started" />`
- `<div className="cv">` → `<UIFlex vertical gap={token.marginMD} style={{ padding: token.paddingMD }}>`

**2.11 — Финал**: удалить `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/conversation-view.css`

### Фаза 3 — Доработка `SessionSelector.tsx` (~15 мин)

1. `SessionSelector.tsx:49` — `<UISpace size="small" style={{ width: '100%' }}>` → `<UIFlex align="center" gap="small">`
2. `SessionSelector.tsx:50` — `<UIIcon name="HistoryOutlined" style={{ opacity: 0.5 }}>` → убрать inline style, обернуть в `<UITypographyText type="secondary">`

---

## Risks

1. **Анимации (`.cv-step-dot--pulse`)**: CSS `@keyframes` нельзя заменить inline-стилями. Решение: `<UISpin size="small" />` для streaming-состояния — визуально эквивалентно и уже используется в UIKit.

2. **`:focus-within` для input box**: CSS псевдокласс не работает inline. Решение (описано в Фазе 1, шаг 4): `onFocus`/`onBlur` state → переключать `borderColor` между `token.colorPrimary` и `token.colorBorderSecondary`.

3. **Регрессия scroll**: `scrollContainerRef` в `AgentsPage.tsx:46` привязан к `<div style={{ flex: 1, overflow: 'auto' }}>` — при переписывании `ConversationView` убедиться что родительский flex-контейнер не меняется (он в `AgentsPage`, не в `ConversationView`).

4. **`UIDiffViewer` CSS vars**: компонент (`UIDiffViewer.tsx:31-34`) использует `var(--success)`, `var(--error)` — проверить визуально после интеграции что переменные определены в теме Studio.

---

## Verification

```bash
# Сборка agent-cli после изменений
pnpm --filter @kb-labs/agents/cli build

# TypeScript проверка (нет неиспользуемых импортов, нет any)
pnpm --filter @kb-labs/agents/cli typecheck

# Убедиться что commit-plugin не сломан (shared UIKit зависимость)
pnpm --filter @kb-labs/commit/cli build

# Если есть тесты
pnpm --filter @kb-labs/agents/cli test

# Проверка всей цепочки зависимостей
pnpm run build --filter @kb-labs/agents/cli...
```

**Финальный чек-лист:**
- [ ] Нет `import '*.css'` в `agent-cli/src/studio/components/` и `agent-cli/src/studio/pages/`
- [ ] Файлы `conversation-view.css` и `agents-page.css` удалены
- [ ] Нет хардкоженных цветов (`'#999'`, `'rgba(...)'`) — только `token.*`
- [ ] Нет голых `<button>`, `<ul>/<li>` там, где есть UIKit-аналог
- [ ] TypeScript build без ошибок

---

*План готов к ревью и утверждению.*
