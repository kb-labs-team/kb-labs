#!/bin/bash
# build-in-order.sh
# Build all packages in correct dependency order

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$ROOT_DIR"

echo "=== Building KB Labs Packages in Dependency Order ==="
echo ""

# Build order: core packages first, then dependent packages
BUILD_ORDER=(
  # Phase 1: Core infrastructure (no workspace dependencies)
  "kb-labs-core/packages/types"
  "kb-labs-core/packages/config"
  "kb-labs-shared/packages/review-types"
  "kb-labs-shared/packages/diff"
  "kb-labs-shared/packages/textops"
  "kb-labs-shared/packages/boundaries"
  "kb-labs-shared/packages/repo"

  # Phase 2: Core packages (depend on types/config)
  "kb-labs-core/packages/core"
  "kb-labs-core/packages/sys"
  "kb-labs-shared/packages/cli-ui"

  # Phase 3: Core extensions
  "kb-labs-core/packages/profile-toolkit"
  "kb-labs-core/packages/policy"
  "kb-labs-core/packages/profiles"
  "kb-labs-core/packages/bundle"
  "kb-labs-core/packages/cli-adapters"
  "kb-labs-core/packages/cli-core"
  "kb-labs-core/packages/sandbox"
  "kb-labs-core/packages/cli"

  # Phase 4: Shared packages
  "kb-labs-shared/packages/cli-ui"

  # Phase 5: CLI infrastructure
  "kb-labs-cli/packages/cli-core"
  "kb-labs-cli/packages/core"
  "kb-labs-cli/packages/cli-runtime"
  "kb-labs-cli/packages/commands"
  "kb-labs-cli/packages/cli-api"
  "kb-labs-cli/packages/cli"

  # Phase 6: Workflow
  "kb-labs-workflow/packages/workflow-constants"
  "kb-labs-workflow/packages/workflow-contracts"
  "kb-labs-workflow/packages/workflow-artifacts"
  "kb-labs-workflow/packages/workflow-engine"
  "kb-labs-workflow/packages/workflow-runtime"

  # Phase 7: Analytics
  "kb-labs-analytics/packages/analytics-core"
  "kb-labs-analytics/packages/analytics-adapters"
  "kb-labs-analytics/packages/analytics-sdk-node"
  "kb-labs-analytics/packages/analytics-cli"

  # Phase 8: AI products
  "kb-labs-ai-docs/packages/ai-docs-contracts"
  "kb-labs-ai-docs/packages/ai-docs-plugin"
  "kb-labs-ai-review/packages/ai-review-contracts"
  "kb-labs-ai-review/packages/ai-review-core"
  "kb-labs-ai-review/packages/ai-review-providers"
  "kb-labs-ai-review/packages/ai-review-plugin"
  "kb-labs-ai-tests/packages/contracts"
  "kb-labs-ai-tests/packages/plugin-cli"

  # Phase 9: Audit
  "kb-labs-audit/packages/audit-contracts"
  "kb-labs-audit/packages/audit-core"
  "kb-labs-audit/packages/audit-checks"
  "kb-labs-audit/packages/audit-cli"

  # Phase 10: Knowledge
  "kb-labs-knowledge/packages/knowledge-contracts"
  "kb-labs-knowledge/packages/knowledge-core"
  "kb-labs-knowledge/packages/knowledge-fs"

  # Phase 11: Mind
  "kb-labs-mind/packages/mind-types"
  "kb-labs-mind/packages/mind-core"
  "kb-labs-mind/packages/mind-embeddings"
  "kb-labs-mind/packages/mind-vector-store"
  "kb-labs-mind/packages/mind-query"
  "kb-labs-mind/packages/mind-engine"
  "kb-labs-mind/packages/mind-adapters"
  "kb-labs-mind/packages/mind-indexer"
  "kb-labs-mind/packages/mind-llm"
  "kb-labs-mind/packages/mind-gateway"
  "kb-labs-mind/packages/mind-tests"
  "kb-labs-mind/packages/mind-pack"
  "kb-labs-mind/packages/mind-cli"
  "kb-labs-mind/packages/contracts"

  # Phase 12: Plugin
  "kb-labs-plugin/packages/plugin-contracts"
  "kb-labs-plugin/packages/manifest"
  "kb-labs-plugin/packages/runtime"
  "kb-labs-plugin/packages/adapters/cli"
  "kb-labs-plugin/packages/adapters/rest"
  "kb-labs-plugin/packages/adapters/studio"
  "kb-labs-plugin/packages/devtools"

  # Phase 13: REST API
  "kb-labs-rest-api/packages/api-contracts"
  "kb-labs-rest-api/packages/rest-api-core"
  "kb-labs-rest-api/apps/rest-api"

  # Phase 14: Studio
  "kb-labs-studio/packages/data-client"
  "kb-labs-studio/packages/ui-core"
  "kb-labs-studio/packages/ui-react"

  # Phase 15: Tooling
  "kb-labs-devlink/packages/contracts"
  "kb-labs-devlink/packages/core"
  "plugins/release"
  "kb-labs-setup-engine/packages/setup-engine"
  "kb-labs-setup-engine/packages/setup-operations"

  # Phase 16: Templates
  "kb-labs-plugin-template/packages/contracts"
  "kb-labs-plugin-template/packages/plugin-cli"
  "kb-labs-product-template/packages/package-name"
)

SUCCESS=0
FAILED=0
SKIPPED=0

for PACKAGE_PATH in "${BUILD_ORDER[@]}"; do
  if [ ! -d "$PACKAGE_PATH" ]; then
    echo "⚠️  Skipping $PACKAGE_PATH (not found)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  PACKAGE_NAME=$(basename "$PACKAGE_PATH")
  PROJECT=$(echo "$PACKAGE_PATH" | cut -d'/' -f1)

  echo "[$((SUCCESS + FAILED + 1))/${#BUILD_ORDER[@]}] 📦 $PACKAGE_PATH"

  cd "$PACKAGE_PATH"

  if [ ! -f "package.json" ]; then
    echo "    ⚪ No package.json, skipping"
    SKIPPED=$((SKIPPED + 1))
    cd "$ROOT_DIR"
    continue
  fi

  if ! grep -q '"build"' package.json 2>/dev/null; then
    echo "    ⚪ No build script, skipping"
    SKIPPED=$((SKIPPED + 1))
    cd "$ROOT_DIR"
    continue
  fi

  BUILD_LOG="/tmp/build-ordered-${PROJECT//\//_}-${PACKAGE_NAME}.log"

  if pnpm build > "$BUILD_LOG" 2>&1; then
    echo "    ✅ Build successful"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "    ❌ Build failed"
    FAILED=$((FAILED + 1))

    # Show error summary
    error_line=$(grep -i "error\|failed" "$BUILD_LOG" | grep -v "DTS Build error" | head -1)
    if [ -n "$error_line" ]; then
      echo "       $(echo "$error_line" | sed 's/^[[:space:]]*//' | cut -c1-80)"
    fi
  fi

  cd "$ROOT_DIR"
done

echo ""
echo "=== Summary ==="
echo "✅ Successful: $SUCCESS"
echo "❌ Failed: $FAILED"
echo "⚪ Skipped: $SKIPPED"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo "⚠️  Some builds failed. Check logs in /tmp/build-ordered-*.log"
  exit 1
else
  echo "🎉 All builds successful!"
  exit 0
fi


