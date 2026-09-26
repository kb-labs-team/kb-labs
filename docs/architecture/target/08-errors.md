# 08 — Ошибки: путь пользователя, каталог и гайд (DRAFT v0)

> Цель: везде, где пользователь может упасть, он видит понятную причину и следующее действие.
> Опирается на ADR-0033 (стабильные коды, сообщения, структурированные метаданные, recovery-действия; один payload для терминала, Studio и агентов).
> `?` = гипотеза, сверить с кодом/автором.

## 1. Что есть сейчас (по коду)

- **Go / лаунчер:** `LauncherError{code, stage, retryable, message, cause, hint, correlationId, details}`
  (`tools/kb-create/v2/contracts/error.go`), 7 кодов `KB_CREATE_*`, стадии `resolve/apply/verify/recover`. Это хорошая основа.
- **TS / платформа:** несколько несовместимых видов ошибок: `PluginError.errorCode` (`shared/command-kit/src/errors/factory.ts`),
  `ValidationError`, `ServiceNotConfiguredError`, `AdapterUnavailableError` (`core/platform/src/errors.ts`), `FlagValidationError`.
  Общего конверта и общего каталога кодов нет; `hint`/`remediation` есть в отдельных местах (discovery, registry diagnostics).
- Между Go и TS нет общего контракта ошибки, а Studio должен уметь рисовать обе стороны одинаково.

## 2. Единый конверт ошибки

Один JSON-контракт (схема лежит в `contracts`, общая для Go и TS; кодогенерация или общие фикстуры):

```jsonc
{
  "code": "KB_HOST_PORT_IN_USE",       // стабильный, никогда не переиспользуется
  "area": "host",                       // install | host | auth | project | config | plugin | update | runtime | product
  "stage": "start",                     // момент пути пользователя (см. §3)
  "severity": "error",                  // error | warning
  "retryable": false,
  "message": "Порт 4000 занят другим приложением.",     // что случилось, человеческим языком
  "cause": "Процесс node (pid 4321) слушает 127.0.0.1:4000.", // почему (без секретов)
  "hint": "Освободите порт или выберите другой: kb-create start --port 4100",   // что делать сейчас
  "actions": [{ "id": "choose-port", "label": "Выбрать другой порт", "command": "kb-create start --port 4100" }],
  "docs": "https://…/errors/KB_HOST_PORT_IN_USE",       // опционально
  "correlationId": "01J…",              // по нему находится запись в логах
  "details": { "port": "4000" }         // структурировано, без секретов
}
```

Словарь `stage` (моменты из `02-ux-journey`, закреплён enum-ом в схеме и проверяется в Go и TS):
`preflight`, `resolve`, `apply`, `verify`, `recover` (2, установка); `start`, `login` (3, запуск и сессия);
`add-project` (4); `run` (5-6, работа); `extend` (7, плагины/адаптеры); `update`, `rollback` (8).
Момент 9 «сбой» отдельной стадией не является: ошибка может случиться на любой.

Правила конверта:
- Терминал, Studio и агент получают **один и тот же** объект; форма отображения — забота рендерера.
- `actions[].command` — готовая к копированию команда (кнопка «скопировать» из ADR-0033); у Studio та же запись превращается в кнопку.
- Код — стабильный API: менять смысл нельзя, удалять только с пометкой deprecated.
- Секреты, токены, пути домашних каталогов в `cause`/`details` не попадают (как у `LauncherError`).

## 3. Схема кода

`KB_<AREA>_<CONDITION>`, заглавными, без номеров: `KB_AUTH_TOKEN_EXPIRED`, `KB_PLUGIN_SDK_INCOMPATIBLE`.
Существующие `KB_CREATE_*` переименовываем в `KB_INSTALL_*` (совместимость не нужна, решение автора).
Плагины-продукты используют свой префикс `<PLUGIN>_<CONDITION>` (как сейчас в фабрике ошибок): `COMMIT_NOTHING_STAGED`.

## 4. Гайд: как писать ошибку

**Три вопроса, на которые сообщение отвечает по порядку:** что случилось → почему → что делать. Если ответа на третий нет, ошибка не готова.

1. **Заголовок — одно предложение, про пользователя, а не про код.** «Не удалось подключиться к KB Labs» лучше, чем «ECONNREFUSED 127.0.0.1:4000».
2. **Причина — конкретика:** порт, путь, версия, имя плагина. Без внутренних терминов (`launchPlatform`, `PlatformContainer`).
3. **`hint` исполнимый:** команда или кнопка, а не «проверьте конфигурацию». Если действие выполняет другой человек (админ), так и пишем: «Попросите администратора …».
4. **Различайте виновника:** «вы» (ввод, окружение), «администратор» (права, доступы), «мы» (баг платформы; тогда показываем `correlationId` и «отправить отчёт»).
5. **Не пугаем и не оправдываемся:** без «Ошибка!!!», без «что-то пошло не так». Если причина неизвестна, честно: «Причина неизвестна; отчёт: `kb-create doctor --report`».
6. **Стек и внутренности только по `--debug`** / в диагностическом досье, не в основном выводе.
7. **Одна ошибка — один корень.** Каскад («не удалось запустить X, потому что не удалось Y») сворачивается до корневой причины, остальное в `details`.
8. **Сообщение не зависит от места показа:** одинаково читается в терминале, в Studio и в логе CI.
9. **Язык (решено автором):** все пользовательские ошибки и вывод — на английском; локализация, если понадобится, подставляется по `code`, не по тексту. Документы проекта могут быть на русском, тексты в каталоге и выводе — английские.
10. **Предупреждение ≠ ошибка:** если работа продолжается, `severity: warning`, и оно не блокирует.

Пример «было / стало»:

| Было | Стало |
|---|---|
| `Error: connect ECONNREFUSED 127.0.0.1:4000` | **Хост KB Labs не запущен.** CLI не смог подключиться к `localhost:4000`. Запустите: `kb-create start` (или откройте приложение). Если хост должен работать — `kb-create doctor`. `[KB_HOST_UNREACHABLE]` |
| `Command not found: commit run` | **Команда «commit run» скрыта.** Плагин `commit` затенён системной командой. Подробности: `kb plugin doctor`. `[KB_PLUGIN_COMMAND_SHADOWED]` |

## 5. Каталог ошибок по пути пользователя

Стадии совпадают с `02-ux-journey`. «Кто показывает»: L — лаунчер, K — `kb`, S — Studio (везде через один конверт).

### A. Установка (`kb-create`, мастер)

| Код | Когда | Что делать (hint) | Кто |
|---|---|---|---|
| `KB_INSTALL_UNSUPPORTED_PLATFORM` | ОС/архитектура вне поддерживаемых | список поддерживаемых, ссылка | L |
| `KB_INSTALL_NO_WRITE_ACCESS` | нет прав на каталог платформы | выбрать другой каталог / права | L |
| `KB_INSTALL_NO_DISK_SPACE` | не хватает места | сколько нужно и сколько есть | L |
| `KB_INSTALL_NETWORK_UNREACHABLE` | нет доступа к релиз-индексу/реестру | проверить сеть/прокси, `retry` | L |
| `KB_INSTALL_RELEASE_INDEX_INVALID` | индекс повреждён/подпись не сходится | повторить; сообщить (виновник — мы) | L |
| `KB_INSTALL_NODE_MISSING` | нет нужной версии Node/менеджера пакетов | ссылка на установку или установить встроенный | L |
| `KB_INSTALL_INCOMPATIBLE_COMPONENTS` | (есть) компоненты несовместимы | какие и с какими версиями | L |
| `KB_INSTALL_PROVIDER_UNRESOLVED` / `_AMBIGUOUS` | (есть) не найден/неоднозначен провайдер возможности | выбрать провайдера | L |
| `KB_INSTALL_INPUT_REQUIRED` / `KB_INSTALL_CONFIG_REQUIRED` | (есть) не хватает ввода/конфига | какое поле | L |
| `KB_INSTALL_ARTIFACT_MANIFEST_MISMATCH` | (есть) манифест артефакта ≠ фактический | повторить; отчёт | L |
| `KB_INSTALL_SERVICE_GRAPH_MISMATCH` | (есть) граф ≠ devservices ≠ статус | `doctor` | L |
| `KB_INSTALL_INTERRUPTED` | установка прервана | `kb-create apply` продолжит с места | L |
| `KB_INSTALL_TOOLCHAIN_UNSUPPORTED` | (есть) версия Node/pnpm не подходит | нужные версии | L |
| `KB_INSTALL_APPLY_FAILED` | (есть) установка не дошла до проверенного состояния | лог и досье, `doctor --fix` | L |
| `KB_INSTALL_OPERATION_INVALID` / `_OPERATION_FAILED` | (есть) неизвестная операция / операция не дошла до проверенной установки | список операций; лог и досье | L |
| `KB_INSTALL_SCENARIO_INVALID` / `_WIZARD_INPUT_INVALID` / `_SECRET_INPUT_INVALID` / `_DOCTOR_INPUT_INVALID` | (есть) ответы сценария/мастера, секрет или вход doctor не приняты | что поправить | L |
| `KB_INSTALL_RECOVERY_FAILED` / `_RECEIPT_UNAVAILABLE` / `_STATUS_UNHEALTHY` | (есть) восстановление не дошло до проверенного состояния / нет активного receipt / граф сервисов не готов | `doctor --fix`, снимок | L |
| `KB_INSTALL_LOG_UNAVAILABLE` / `_DIAGNOSTIC_UNAVAILABLE` | (есть) нельзя записать лог/досье | права на каталог | L |
| `KB_INSTALL_ROLLBACK_FAILED` | откат не удался | восстановление вручную, путь к снимку | L |

### B. Запуск и здоровье хоста

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_HOST_UNREACHABLE` | CLI/Studio не достучались до хоста | `kb-create start` / `doctor` | K, S |
| `KB_HOST_ALREADY_RUNNING` | повторный старт | `status`, `restart` | L |
| `KB_HOST_PORT_IN_USE` | порт занят | освободить или другой порт | L |
| `KB_HOST_START_FAILED` | процесс упал при старте | причина из лога, `correlationId` | L |
| `KB_HOST_UNHEALTHY` | хост отвечает, модуль/сервис нет | какой модуль, `restart`/`doctor` | K, S |
| `KB_HOST_EXPOSURE_REFUSED` | режим без авторизации + не loopback bind | включить авторизацию или вернуть loopback | L |
| `KB_HOST_VERSION_SKEW` | версия лаунчера/CLI ≠ версия хоста | `kb-create update` | K, L |
| `KB_HOST_CONTROL_UNAVAILABLE` | control-канал лаунчера недоступен | запустить лаунчер/оболочку | S |
| `KB_HOST_STATE_DIR_UNWRITABLE` | нельзя писать в `~/.kb/state` | права/место | L |
| `KB_HOST_ADAPTER_UNAVAILABLE` | адаптер (БД, кэш, LLM) недоступен | какой, как запустить/настроить | K, S |

### C. Авторизация

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_AUTH_REQUIRED` | нужна авторизация | `kb auth login` | K, S |
| `KB_AUTH_INVALID_CREDENTIALS` | неверные данные | повторить; сброс | K, S |
| `KB_AUTH_TOKEN_EXPIRED` | токен истёк (обновление не удалось) | `kb auth login` | K, S |
| `KB_AUTH_FORBIDDEN` | нет прав на операцию | какая роль нужна; «попросите администратора» | K, S |
| `KB_AUTH_LOCKED_OUT` | доступа нет, админ потерян | `kb-create doctor --recover` | L |
| `KB_AUTH_GATEWAY_UNREACHABLE` | gateway недоступен | см. хост | K |
| `KB_AUTH_CLOCK_SKEW` ? | токен «из будущего»/прошлого | проверить время системы | K |
| `KB_AUTH_MODE_MISMATCH` | клиент ждёт авторизацию, хост в режиме без неё (и наоборот) | режим установки | K, S |

### D. Проекты

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_PROJECT_PATH_NOT_FOUND` | путь не существует | проверить путь | K, S |
| `KB_PROJECT_NOT_A_DIRECTORY` | не папка | указать папку проекта | K, S |
| `KB_PROJECT_NO_ACCESS` | нет прав на чтение | права или другая папка | K, S |
| `KB_PROJECT_ALREADY_REGISTERED` | уже добавлен | `kb project show` | K, S |
| `KB_PROJECT_UNKNOWN` | проект не в реестре (переехавшая папка, как у Claude) | `kb project add <путь>` | K, S |
| `KB_PROJECT_DECLARATION_INVALID` | `.kb/` есть, но конфиг невалиден | путь поля + что ожидается | K, S |
| `KB_PROJECT_RUNTIME_START_FAILED` | рантайм проекта не поднялся | причина, `correlationId` | S, K |
| `KB_PROJECT_RUNTIME_LIMIT` | достигнут лимит активных рантаймов | закрыть неактивный | S |

### E. Конфиг и секреты

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_CONFIG_INVALID` | значение не проходит схему | путь `llm.model`, допустимые значения | K, S |
| `KB_CONFIG_UNKNOWN_KEY` | неизвестное поле | ближайшее известное («вы имели в виду …») | K, S |
| `KB_CONFIG_SECRET_MISSING` | ссылка на `${ENV}` без значения | задать переменную/секрет | K, S |
| `KB_CONFIG_SECRET_PLAINTEXT` | `kb config set` получил сырой секрет вместо `${ENV}`-ссылки | сохранить ссылку; `--allow-plain-secret` только для локальных значений | K, S |
| `KB_CONFIG_CONFLICT` | файл изменён другим писателем | перечитать/повторить | K, S |
| `KB_CONFIG_LLM_KEY_INVALID` | ключ провайдера отклонён | заменить ключ | S, K |
| `KB_CONFIG_LLM_QUOTA` | квота/бюджет исчерпаны | пополнить/поменять модель | S, K |

### F. Плагины и адаптеры

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_PLUGIN_NOT_FOUND` | нет в реестре | точное имя, поиск | K, S |
| `KB_PLUGIN_SDK_INCOMPATIBLE` | версия SDK-контракта не подходит | какая нужна, какая стоит | K, S |
| `KB_PLUGIN_NAMESPACE_RESERVED` | namespace зарезервирован | предложить `acme-…` (`06` §8) | K, S |
| `KB_PLUGIN_NAMESPACE_TAKEN` | namespace занят другим пакетом | кем занят | K, S |
| `KB_PLUGIN_COMMAND_SHADOWED` | команда скрыта (`06` §7) | `kb plugin doctor` | K |
| `KB_PLUGIN_INSTALL_FAILED` | установка пакета не удалась | причина сети/реестра | K, S |
| `KB_PLUGIN_LOAD_FAILED` | плагин не загрузился (манифест, зависимость) | что именно | K, S |
| `KB_PLUGIN_CRASHED` | плагин упал при выполнении | повторить; `correlationId`, отчёт | K, S |
| `KB_PLUGIN_TIMEOUT` | плагин завис | повторить, увеличить таймаут | K, S |
| `KB_PLUGIN_PERMISSION_DENIED` | песочница запретила действие | какое разрешение запросить | K, S |
| `KB_ADAPTER_NOT_CONFIGURED` (area `plugin`) | адаптер выбран, но нет опций | какие поля | K, S |

### G. Обновление и откат

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_UPDATE_DOWNLOAD_FAILED` | не скачалось | сеть, `retry` | L |
| `KB_UPDATE_INCOMPATIBLE` | обновление несовместимо с установленным | что мешает | L |
| `KB_UPDATE_VERIFY_FAILED` | после обновления проверка не прошла (автооткат) | что сломалось, куда откатились | L |
| `KB_UPDATE_HOST_NOT_HEALTHY` | хост не поднялся после обновления | автооткат/`rollback` | L |
| `KB_UPDATE_NO_SNAPSHOT` | откатываться некуда | | L |

### H. Повседневная работа

| Код | Когда | Hint | Кто |
|---|---|---|---|
| `KB_RUNTIME_TIMEOUT` | операция не уложилась во время | повторить, увеличить таймаут | K, S |
| `KB_RUNTIME_DISK_FULL` | нет места (логи, кэш) | очистить, где лежит | K, S |
| `KB_RUNTIME_LOGS_UNAVAILABLE` | хранилище логов недоступно | порядок поиска логов | K |
| `KB_RUNTIME_INPUT_INVALID` | ввод/флаги не прошли проверку (адаптер `ValidationError`) | какие поля | K, S |
| `KB_RUNTIME_UNEXPECTED` | непредвиденная ошибка (виновник — мы) | `--debug`, `correlationId` | K, S |
| `KB_RUNTIME_RATE_LIMITED` | лимит запросов (LLM/API) | когда повторить | K, S |

### I. Продукты (плагины, своя зона)

Каждый плагин описывает свои коды по этому же конверту и гайду (пример коммитов): `COMMIT_NOT_A_GIT_REPO`, `COMMIT_NOTHING_STAGED`,
`COMMIT_PUSH_REJECTED`, `COMMIT_LLM_UNAVAILABLE`. Обязательное требование к плагину: каждый код имеет `hint`.

## 6. Как проверять и что менять в коде

Сделано (0.4): схема `error-envelope.schema.json`, каталог, общие фикстуры `fixtures/valid|invalid` (тестируются из Go и TS),
TS-адаптер (`toErrorEnvelope` в `core-platform` и `shared-command-kit`), Go `LauncherError` в форме конверта. Коды `KB_RELEASE_*` ведёт релизный трек.

- **Контракт:** схема конверта в `contracts`; Go и TS порождают/принимают один и тот же JSON; общие фикстуры тестируются с обеих сторон.
- **Каталог как данные:** `errors.catalog.json` (код → area, stage, retryable, шаблон message/hint). Из него генерируются раздел выше и страницы `docs`.
- **Линт/тест:** каждый код из каталога имеет hint; нет кода вне каталога; нет дублей; у мутирующих команд перечислены их коды.
- **Снапшот-тест рендера:** для каждой ошибки — вывод в терминале и payload Studio.
- **Миграция TS:** `PluginError`, `ValidationError`, `ServiceNotConfiguredError`, `AdapterUnavailableError` приводятся к конверту через один адаптер; новый код обязан использовать конверт.
- **Первое место, где нужно увидеть:** «хост мёртв»: сегодня CLI, скорее всего, показывает сетевую ошибку (проверить).

## 7. Открытое

- Единая точка правды для каталога: решено, JSON-файл-источник `core/platform/src/error-envelope/errors.catalog.json`; Go-таблица генерируется (`go generate`), тест ловит устаревший файл.
- Локализация: нужна ли на старте? Рекомендую нет (английский + русский по запросу), но коды стабильные с первого дня.
- Отправка отчёта (`doctor --report`): что входит в досье и куда уходит; согласие пользователя обязательно. ?
