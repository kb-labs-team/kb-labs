# Аудит: Приоритеты platformRoot vs projectRoot

> Статус: ОТКРЫТ  
> Дата: 2026-04-29  
> Принцип: `platform.dir` = дефолты, projectRoot = оверрайд (проект всегда побеждает)

---

## Что работает правильно ✅

| Файл | Что делает правильно |
|------|----------------------|
| `core/runtime/src/config-loader.ts:274-317` | Читает projectConfig первым, honoring `platform.dir`, потом мержит с platformConfig — project wins |
| `core/runtime/src/service-bootstrap.ts:206-212` | Передаёт `projectRoot` как cwd для адаптеров, `platformRoot` отдельно |
| `cli/bin/src/runtime/platform-init.ts:135-139` | Аналогично service-bootstrap — оба root переданы правильно |
| `services/workflow/daemon/src/bootstrap.ts:31-36` | Явно читает `KB_PROJECT_ROOT` из env, используется для рабочих директорий |
| `services/state/daemon/src/bootstrap.ts` | Минимальный bootstrap, не читает конкретные директории — корректно |
| `core/runtime/src/discover-adapters.ts:128-133` | Логика merge: projectRoot загружается первым с `overwrite=true`, платформа заполняет пробелы |

---

## Проблемы 🔴

### CRITICAL

#### 1. `core/runtime/src/loader.ts` — `resolveAdapter` теряет platformRoot
**Строка**: ~149  
```typescript
export async function resolveAdapter(adapterPath: string, cwd: string) {
  const discovered = await discoverAdapters(cwd);  // ← только один аргумент
```
`resolveAdapter` вызывает `discoverAdapters` с одним аргументом. В установленном режиме (`platformRoot !== projectRoot`) адаптеры платформы не будут найдены — только из `cwd`.  
Вызов в `loader.ts:~108`: `loadAdapter(path, cwd)` не передаёт platformRoot.

#### 2. `core/discovery/src/discovery-manager.ts` — одиночный root
**Строка**: ~44-52, ~67  
```typescript
constructor(opts: DiscoveryOptions = {}) {
  this.root = opts.root ?? process.cwd();  // ← только один root
}
// ...
const lock = await readMarketplaceLock(this.root, diag);
```
`DiscoveryManager` принимает один `root`. Не умеет мержить два `marketplace.lock` (project + platform). Все caller'ы вынуждены выбирать один из двух. Нет поддержки "читай из обоих, project wins".

---

### MAJOR

#### 3. `plugins/rest-api/app/src/bootstrap.ts` — registry только из platformRoot
**Строка**: ~165  
```typescript
const registryRoot = getPlatformRoot() ?? repoRoot;
const registry = await createRegistry({ root: registryRoot, ... });
```
Registry плагинов (studio registry, widgetBundleDir) читается из платформы. `marketplace.lock` проекта игнорируется. Плагины из воркспейса (`./services/workflow/entry`) не обнаруживаются — используются установленные из `kb-platform/node_modules/`.

**Эффект**: Studio загружает виджеты из старой установленной версии, а не из актуального кода воркспейса.

#### 4. `plugins/gateway/app/src/bootstrap.ts` — repoRoot вместо projectRoot
**Строка**: ~26  
```typescript
const config = await loadGatewayConfig(repoRoot, getPlatformRoot());
```
Gateway передаёт `repoRoot` как первый аргумент, но семантически это должен быть `projectRoot`. В dev режиме они совпадают, но архитектурно некорректно.

#### 5. `plugins/gateway/app/src/config.ts` — семантика параметров
**Строка**: ~33-45  
```typescript
export async function loadGatewayConfig(repoRoot: string, platformRoot?: string)
```
Параметр называется `repoRoot` но используется как `projectRoot`. Вводит в заблуждение, может привести к ошибкам при рефакторинге.

---

### MINOR

#### 6. `core/runtime/src/loader.ts` — аргументы discoverAdapters
**Строка**: ~478-480  
```typescript
const discovered = await discoverAdapters(
  platformRoot ?? cwd,
  platformRoot && platformRoot !== cwd ? cwd : undefined,
);
```
Выглядит как инвертированный порядок (platform первый, project второй), но внутри `discoverAdapters` это **работает правильно** — project загружается с `overwrite=true`. Код запутанный, но функционально корректный.

#### 7. `services/marketplace/app/src/bootstrap.ts` — platformRoot для service
**Строка**: ~41  
```typescript
const platformRoot = getPlatformRoot() ?? repoRoot;
const service = new MarketplaceService({ platformRoot, ... });
```
Для daemon'а это архитектурно правильно (он обслуживает платформу). Но нужна проверка что per-request projectRoot корректно передаётся в каждом запросе от клиентов из воркспейса.

---

## Сводная таблица

| # | Файл | Строка | Проблема | Серьёзность |
|---|------|--------|---------|-------------|
| 1 | `core/runtime/src/loader.ts` | ~149 | `resolveAdapter` не получает platformRoot | **CRITICAL** |
| 2 | `core/discovery/src/discovery-manager.ts` | ~44, ~67 | Одиночный root, нет merge двух lock-файлов | **CRITICAL** |
| 3 | `plugins/rest-api/app/src/bootstrap.ts` | ~165 | Registry только из platformRoot | **MAJOR** |
| 4 | `plugins/gateway/app/src/bootstrap.ts` | ~26 | `repoRoot` вместо `projectRoot` | **MAJOR** |
| 5 | `plugins/gateway/app/src/config.ts` | ~33 | Неправильная семантика параметра | **MAJOR** |
| 6 | `core/runtime/src/loader.ts` | ~478 | Запутанный порядок аргументов (работает) | MINOR |
| 7 | `services/marketplace/app/src/bootstrap.ts` | ~41 | platformRoot для service (возможно корректно) | MINOR |

---

## Рекомендуемые исправления

### Fix 1: Расширить `DiscoveryManager` (CRITICAL)
```typescript
// core/discovery/src/discovery-manager.ts
export interface DiscoveryOptions {
  root?: string;
  platformRoot?: string;  // ← ADD: второй root для merge
}

// В discover(): читать оба lock-файла, project wins
const projectLock = await readMarketplaceLock(this.root);
const platformLock = this.platformRoot 
  ? await readMarketplaceLock(this.platformRoot) 
  : undefined;
// merge: platformLock как база, projectLock как override
```

### Fix 2: Передавать platformRoot в `resolveAdapter` (CRITICAL)
```typescript
// core/runtime/src/loader.ts
export async function resolveAdapter(
  adapterPath: string,
  cwd: string,
  platformRoot?: string,  // ← ADD
): Promise<...> {
  const discovered = await discoverAdapters(
    platformRoot ?? cwd,
    platformRoot && platformRoot !== cwd ? cwd : undefined,
  );
```

### Fix 3: Registry из projectRoot в rest-api bootstrap (MAJOR)
```typescript
// plugins/rest-api/app/src/bootstrap.ts
const platformRoot = getPlatformRoot();
const registry = await createRegistry({
  root: repoRoot,              // ← projectRoot первый
  platformRoot: platformRoot,  // ← платформа как fallback
  cache: { ttlMs: snapshotTTL, adapter: platform.cache },
});
```

### Fix 4: Переименовать параметры gateway (MAJOR)
```typescript
// plugins/gateway/app/src/config.ts
export async function loadGatewayConfig(
  projectRoot: string,    // ← переименовать из repoRoot
  platformRoot?: string,
)

// plugins/gateway/app/src/bootstrap.ts
export async function bootstrap(projectRoot: string = process.cwd()): Promise<void> {
  // ...
  const config = await loadGatewayConfig(projectRoot, getPlatformRoot());
```

---

## Не проверено

- `services/host-agent/` — bootstrap
- `plugins/infra-worker/` — bootstrap  
- `adapters/storage-*/`, `adapters/llm-*/` — внутренняя логика путей
- `core/registry/src/` — полная логика createRegistry
