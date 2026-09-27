/**
 * Image preview components with Ant Design's fullscreen viewer controls.
 * Use `UIImagePreviewGroup` when multiple thumbnails should be browsable in
 * one lightbox with previous/next navigation.
 */

import * as React from 'react';
import { Image as AntImage } from 'antd';
import type { ImageProps } from 'antd/es/image';

export interface UIImagePreviewProps extends Omit<ImageProps, 'preview'> {
  /** Enable and configure the fullscreen image viewer. Enabled by default. */
  preview?: ImageProps['preview'];
}

export function UIImagePreview({ preview = true, ...props }: UIImagePreviewProps) {
  return <AntImage {...props} preview={preview} />;
}

export type UIImagePreviewGroupProps = React.ComponentProps<typeof AntImage.PreviewGroup>;

export function UIImagePreviewGroup(props: UIImagePreviewGroupProps) {
  return <AntImage.PreviewGroup {...props} />;
}
