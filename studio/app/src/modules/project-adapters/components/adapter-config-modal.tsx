/**
 * @module @kb-labs/studio-app/modules/project-adapters/components/adapter-config-modal
 *
 * Config form generated from an adapter's manifest `configSchema` (stage 6,
 * second slice). Saves through the host's `/api/v1/adapters/:name/configure`
 * API, which validates with the same `createAdapterOptionsValidator` as `kb
 * config set`.
 */

import * as React from 'react';
import {
  UICheckbox,
  UIForm,
  UIFormItem,
  UIInput,
  UIInputNumber,
  UIMessage,
  UIModal,
  UISelect,
  UIText,
  useUIForm,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useConfigureProjectAdapter } from '@kb-labs/studio-data-client';
import type { ProjectAdapterEntry } from '@kb-labs/studio-data-client';

export interface AdapterConfigModalProps {
  projectId: string | null;
  adapter: ProjectAdapterEntry | null;
  onClose: () => void;
}

/** One control per declared field, matching `ManifestFieldSchema` (`type` / `enum`). */
function renderField(name: string, field: { type?: string; enum?: unknown[] }) {
  if (field.enum && field.enum.length > 0) {
    return (
      <UISelect
        options={field.enum.map((option) => ({ label: String(option), value: String(option) }))}
      />
    );
  }
  switch (field.type) {
    case 'boolean':
      return <UICheckbox />;
    case 'number':
      return <UIInputNumber style={{ width: '100%' }} />;
    default:
      return <UIInput placeholder={name} />;
  }
}

export function AdapterConfigModal({ projectId, adapter, onClose }: AdapterConfigModalProps) {
  const { projectAdapters: source } = useDataSources();
  const configure = useConfigureProjectAdapter(source, projectId);
  const [form] = useUIForm<Record<string, unknown>>();

  const schema = adapter?.configSchema ?? {};
  const fieldNames = Object.keys(schema);

  const handleOk = React.useCallback(() => {
    form
      .validateFields()
      .then(async (values) => {
        if (!adapter) {
          return;
        }
        try {
          await configure.mutateAsync({ name: adapter.name, options: values });
          UIMessage.success(`Saved configuration for ${adapter.name}`);
          onClose();
        } catch (error) {
          UIMessage.error(error instanceof Error ? error.message : 'Failed to save the adapter configuration');
        }
      })
      .catch(() => undefined);
  }, [form, adapter, configure, onClose]);

  return (
    <UIModal
      open={adapter !== null}
      title={adapter ? `Configure ${adapter.name}` : 'Configure adapter'}
      okText="Save"
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={configure.isPending}
    >
      {adapter && (
        <>
          {adapter.spec && (
            <UIText color="secondary" style={{ display: 'block', marginBottom: 16 }}>
              {adapter.spec}
            </UIText>
          )}
          {fieldNames.length === 0 ? (
            <UIText color="secondary">This adapter declares no configurable options.</UIText>
          ) : (
            <UIForm key={adapter.name} form={form} layout="vertical" initialValues={adapter.options}>
              {fieldNames.map((name) => (
                <UIFormItem
                  key={name}
                  label={name}
                  name={name}
                  valuePropName={schema[name]!.type === 'boolean' ? 'checked' : 'value'}
                >
                  {renderField(name, schema[name]!)}
                </UIFormItem>
              ))}
            </UIForm>
          )}
        </>
      )}
    </UIModal>
  );
}
