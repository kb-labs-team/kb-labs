/**
 * Shared utilities for rendering QA check icons and labels.
 */

import * as React from 'react';
import { UIIcon } from '@kb-labs/sdk/studio';

const KNOWN_ICONS: Record<string, string> = {
  build: 'BuildOutlined',
  lint: 'FileSearchOutlined',
  typeCheck: 'FileTextOutlined',
  test: 'ExperimentOutlined',
};

export function getCheckIcon(checkType: string): React.ReactNode {
  return <UIIcon name={KNOWN_ICONS[checkType] ?? 'CheckCircleOutlined'} />;
}

export function formatCheckLabel(checkType: string): string {
  return checkType.charAt(0).toUpperCase() + checkType.slice(1).replace(/([A-Z])/g, ' $1');
}
