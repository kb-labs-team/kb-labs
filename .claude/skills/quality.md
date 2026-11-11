---
name: quality
description: Quality plugin — architecture analysis, coupling metrics, layering violations, dead code, trend tracking
globs:
  - "plugins/quality/**"
---

# Quality Plugin

Два угла использования:
- **Агент** — быстрый stateless контекст перед задачей и gate-проверка после.
- **Владелец** — тренды по coupling, violations, dead code со временем.

---

## Агентские команды (быстрые, stateless)

### Перед задачей — получить контекст пакета

```bash
kb quality context show --package @kb-labs/sdk --json
```

Возвращает без AST-анализа (только package.json):
```json
{
  "name": "@kb-labs/sdk",
  "layer": 1,
  "layerName": "sdk / shared",
  "dir": "sdk/sdk",
  "coupling": { "afferent": 38, "efferent": 18, "instability": 0.32 },
  "dependents": ["@kb-labs/agents/core", "..."],
  "dependencies": [],
  "devDependencies": ["@kb-labs/core-platform", "..."]
}
```

Без `--package` — сводка по слоям всего workspace.

### После задачи — проверить архитектуру

```bash
kb quality gate run --json
```

Сравнивает с последним снапшотом — fail только на **новые** нарушения:
```json
{ "passed": true, "current": 13, "baseline": 13, "newViolations": 0 }
```

`--strict` — fail на любые нарушения (включая pre-existing).

### Проверить конкретный пакет на нарушения

```bash
kb quality check-layers --package @kb-labs/sdk --json
```

---

## Слоевая архитектура (CLAUDE.md)

| Layer | Путь | Может импортировать |
|-------|------|---------------------|
| 0 | `core/` | — |
| 1 | `sdk/`, `shared/` | 0 |
| 2 | `cli/`, `adapters/` | 0, 1 |
| 3 | `plugins/` | 0, 1, 2 |
| 4 | `studio/` | 0, 1, 2, 3 |

Нарушение = пакет на слое N импортирует из слоя M где M > N.

**Правило:** Если добавляешь зависимость — проверь слои обоих пакетов через `quality context show`.

---

## Команды владельца

```bash
kb quality health show          # score/100 по 5 измерениям
kb quality check-layers    # все нарушения, grouped by package
kb quality coupling show        # Ca/Ce/instability top-N (по умолчанию top 10)
kb quality dead-code       # knip: unused files/exports/deps
kb quality stats show           # packages, LOC, size
kb quality snapshot create        # сохранить снапшот
kb quality history list         # история снапшотов + delta
```

Все поддерживают `--json`.

---

## Health score

5 измерений с весами:

| Измерение | Вес | Что считает |
|-----------|-----|-------------|
| architecture | 30% | layering violations + avg instability |
| typescript | 25% | any count, ts-ignore |
| deadCode | 20% | unused files/exports (knip) |
| depHygiene | 15% | unused/unlisted deps (knip) |
| testCoverage | 10% | avg coverage (null = 100%) |

Грейды: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.

---

## Конфиг (kb.config.json)

```jsonc
{
  "quality": {
    "maxSnapshots": 30,
    "knip": { "enabled": true },
    "layers": {
      "core/": 0, "sdk/": 1, "shared/": 1,
      "cli/": 2, "adapters/": 2,
      "plugins/": 3, "studio/": 4
    },
    "thresholds": {
      "health": 70,       // exit 1 ниже этого
      "instability": 0.85 // порог предупреждения
    }
  }
}
```

---

## Типичный агентский workflow

```bash
# 1. Понять куда писать код
kb quality context show --package @kb-labs/target-pkg --json

# 2. Убедиться в слое новой зависимости
kb quality context show --package @kb-labs/new-dep --json
# → Смотришь layer: N. Если N > layer целевого пакета — нельзя импортировать.

# 3. После изменений — проверить что не сломал архитектуру
kb quality gate run --json
# passed: true → всё чисто
# passed: false, newViolations: 2 → откатить/исправить импорты
```

---

## Структура плагина

```
plugins/quality/
├── contracts/   @kb-labs/quality/contracts  — типы, константы, роуты
├── core/        @kb-labs/quality/core       — анализаторы (AST, knip, coupling)
└── entry/       @kb-labs/quality      — CLI, REST handlers, Studio UI
```

Данные хранятся в `.kb/quality/snapshots/quality.json`.
