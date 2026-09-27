/**
 * @module @kb-labs/studio-app/modules/health/components/update-modal
 *
 * "Update" dialog: queues a channel or exact-version update with the launcher
 * through the host's `/api/v1/update` API (ADR-0045). The launcher performs
 * the update and restarts the host asynchronously; Studio only reports that
 * the request was queued (this closes the gap noted in #501: queued update
 * requests were not consumed before this stage-6 slice added the launcher
 * side of the queue).
 */

import * as React from 'react';
import {
  UIModal,
  UIForm,
  UIFormItem,
  UIInput,
  UIMessage,
  UIRadioGroup,
  UIText,
  useUIForm,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useTriggerUpdate, type UpdateChannel } from '@kb-labs/studio-data-client';

export interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  onQueued: () => void;
}

interface FormValues {
  mode: 'channel' | 'version';
  channel: UpdateChannel;
  version?: string;
}

const CHANNEL_OPTIONS: Array<{ label: string; value: UpdateChannel }> = [
  { label: 'Stable', value: 'stable' },
  { label: 'Canary', value: 'canary' },
  { label: 'Experimental', value: 'experimental' },
];

export function UpdateModal({ open, onClose, onQueued }: UpdateModalProps) {
  const { health: healthSource } = useDataSources();
  const triggerUpdate = useTriggerUpdate(healthSource);
  const [form] = useUIForm<FormValues>();

  const handleClose = React.useCallback(() => {
    form.resetFields();
    onClose();
  }, [form, onClose]);

  const handleOk = React.useCallback(() => {
    form
      .validateFields()
      .then(async (values) => {
        try {
          const record = await triggerUpdate.mutateAsync(
            values.mode === 'version'
              ? { version: values.version as string }
              : { channel: values.channel },
          );
          UIMessage.success(
            `Update queued (${record.id}); the launcher will apply it and restart the host.`,
          );
          form.resetFields();
          onQueued();
        } catch (error) {
          UIMessage.error(error instanceof Error ? error.message : 'Failed to queue the update');
        }
      })
      .catch(() => undefined);
  }, [form, triggerUpdate, onQueued]);

  return (
    <UIModal
      open={open}
      title="Queue a platform update"
      okText="Queue update"
      onOk={handleOk}
      onCancel={handleClose}
      confirmLoading={triggerUpdate.isPending}
    >
      <UIText style={{ display: 'block', marginBottom: 12, opacity: 0.75 }}>
        This queues the request with the launcher (`kb-create`); it performs the
        update and restarts the host, not Studio.
      </UIText>
      <UIForm form={form} layout="vertical" initialValues={{ mode: 'channel', channel: 'stable' }}>
        <UIFormItem name="mode" label="Update to">
          <UIRadioGroup
            options={[
              { label: 'Latest on a channel', value: 'channel' },
              { label: 'Exact version', value: 'version' },
            ]}
            optionType="button"
          />
        </UIFormItem>
        <UIFormItem noStyle shouldUpdate={(prev, next) => prev.mode !== next.mode}>
          {() =>
            form.getFieldValue('mode') === 'version' ? (
              <UIFormItem
                label="Version"
                name="version"
                rules={[
                  { required: true, message: 'Enter an exact semantic version, e.g. 2.121.0' },
                  { pattern: /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, message: 'Must be an exact semantic version' },
                ]}
              >
                <UIInput placeholder="2.121.0" autoFocus />
              </UIFormItem>
            ) : (
              <UIFormItem label="Channel" name="channel" rules={[{ required: true }]}>
                <UIRadioGroup options={CHANNEL_OPTIONS} />
              </UIFormItem>
            )
          }
        </UIFormItem>
      </UIForm>
    </UIModal>
  );
}
