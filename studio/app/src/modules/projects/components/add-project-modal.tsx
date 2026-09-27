/**
 * @module @kb-labs/studio-app/modules/projects/components/add-project-modal
 *
 * "+ Add project" dialog: takes a folder path, and — when the folder has no
 * `.kb/` yet — asks to confirm creating the minimal `.kb/` before retrying
 * with `init: true`. Studio only calls the host API; it never touches files
 * or spawns processes itself (stage 6, first slice).
 */

import * as React from 'react';
import { UIModal, UIForm, UIFormItem, UIInput, UIMessage, UIText, useUIForm } from '@kb-labs/studio-ui-kit';
import { KBError } from '@kb-labs/studio-data-client';
import { useDataSources } from '@/providers/data-sources-provider';
import { useAddProject } from '@kb-labs/studio-data-client';

/** Reads the catalog code the gateway put in the error body, if any. */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof KBError)) {
    return undefined;
  }
  const data = (error.cause as { data?: unknown } | undefined)?.data;
  if (data && typeof data === 'object' && 'error' in data) {
    const inner = (data as { error?: unknown }).error;
    if (inner && typeof inner === 'object' && 'code' in inner) {
      return String((inner as { code: unknown }).code);
    }
  }
  return undefined;
}

export interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

interface FormValues {
  path: string;
  name?: string;
}

export function AddProjectModal({ open, onClose, onAdded }: AddProjectModalProps) {
  const { projects: projectsSource } = useDataSources();
  const addProject = useAddProject(projectsSource);
  const [form] = useUIForm<FormValues>();
  const [needsInit, setNeedsInit] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    form.resetFields();
    setNeedsInit(null);
  }, [form]);

  const handleClose = React.useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const submit = React.useCallback(
    async (values: FormValues, init: boolean) => {
      try {
        await addProject.mutateAsync({ path: values.path, name: values.name || undefined, init });
        UIMessage.success(`Registered ${values.path}`);
        reset();
        onAdded();
      } catch (error) {
        if (!init && errorCode(error) === 'KB_PROJECT_INIT_REQUIRED') {
          setNeedsInit(values.path);
          return;
        }
        UIMessage.error(error instanceof Error ? error.message : 'Failed to register the project');
      }
    },
    [addProject, reset, onAdded],
  );

  const handleOk = React.useCallback(() => {
    form.validateFields().then((values) => submit(values, false)).catch(() => undefined);
  }, [form, submit]);

  const handleConfirmInit = React.useCallback(() => {
    const path = needsInit;
    setNeedsInit(null);
    if (path) {
      void submit({ path }, true);
    }
  }, [needsInit, submit]);

  return (
    <UIModal
      open={open}
      title={needsInit ? 'Initialize project?' : 'Add project'}
      okText={needsInit ? 'Create .kb/ and register' : 'Register'}
      onOk={needsInit ? handleConfirmInit : handleOk}
      cancelText={needsInit ? 'Back' : undefined}
      onCancel={needsInit ? () => setNeedsInit(null) : handleClose}
      confirmLoading={addProject.isPending}
    >
      {needsInit ? (
        <UIText>
          {needsInit} has no .kb/ configuration yet. Create the minimal .kb/ and register it?
        </UIText>
      ) : (
        <UIForm form={form} layout="vertical">
          <UIFormItem
            label="Folder path"
            name="path"
            rules={[{ required: true, message: 'Enter the absolute path of the project folder' }]}
          >
            <UIInput placeholder="/absolute/path/to/project" autoFocus />
          </UIFormItem>
          <UIFormItem label="Name (optional)" name="name">
            <UIInput placeholder="Defaults to the folder name" />
          </UIFormItem>
        </UIForm>
      )}
    </UIModal>
  );
}
