/**
 * @module @kb-labs/studio-app/modules/workflows/components/run-workflow-modal
 * Modal dialog for running a workflow with optional input parameters.
 * Supports two modes:
 *   1. Single workflow (workflow prop) — used from definition page
 *   2. Workflow picker (workflows prop) — used from dashboard
 */

import * as React from 'react';
import { UIModal, UIButton, UISpace, UITypographyText, UIInput, UIInputTextArea, UIInputNumber, UISwitch, UISelect, UIIcon } from '@kb-labs/studio-ui-kit';
import type { WorkflowInfo } from '@kb-labs/workflow-contracts';

type InputField = NonNullable<WorkflowInfo['inputs']>[string];

export function requiredInputErrors(
  inputs: Record<string, InputField>,
  values: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs)
      .filter(([name, schema]) => {
        const value = Object.hasOwn(values, name) ? values[name] : schema.default;
        return schema.required && (
          value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
        );
      })
      .map(([name]) => [name, `${name} is required`]),
  );
}

export function runWithRequiredInputs(
  workflowId: string,
  inputs: Record<string, InputField>,
  values: Record<string, unknown>,
  onRun: (workflowId: string, values: Record<string, unknown>) => void,
): Record<string, string> {
  const errors = requiredInputErrors(inputs, values);
  if (Object.keys(errors).length === 0) {onRun(workflowId, values)}
  return errors;
}

interface RunWorkflowModalBaseProps {
  open: boolean;
  onClose: () => void;
  onRun: (workflowId: string, input: Record<string, unknown>) => void;
  loading?: boolean;
}

interface SingleWorkflowProps extends RunWorkflowModalBaseProps {
  workflow: WorkflowInfo | null;
  workflows?: never;
}

interface MultiWorkflowProps extends RunWorkflowModalBaseProps {
  workflow?: never;
  workflows: WorkflowInfo[];
}

export type RunWorkflowModalProps = SingleWorkflowProps | MultiWorkflowProps;

export function DynamicField({
  name,
  schema,
  value,
  error,
  onChange,
}: {
  name: string;
  schema: InputField;
  value: unknown;
  error?: string;
  onChange: (val: unknown) => void;
}) {
  const inputId = `workflow-input-${name}`;
  const errorId = `${inputId}-error`;
  const label = (
    <UISpace className="gap-tight" style={{ marginBottom: 4 }}>
      <label className="typo-label" htmlFor={inputId}>
        {name}
        {schema.required && (
          <span aria-hidden="true" style={{ color: 'var(--color-error)', marginLeft: 2 }}>*</span>
        )}
      </label>
      {schema.description && (
        <UITypographyText className="typo-caption text-tertiary">
          — {schema.description}
        </UITypographyText>
      )}
    </UISpace>
  );

  if (schema.type === 'boolean') {
    return (
      <div style={{ marginBottom: 16 }}>
        {label}
        <div>
          <UISwitch
            id={inputId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            checked={value !== undefined ? Boolean(value) : (schema.default as boolean ?? false)}
            onChange={onChange}
          />
        </div>
        {error && <div id={errorId} role="alert" style={{ color: 'var(--color-error)' }}>{error}</div>}
      </div>
    );
  }

  if (schema.type === 'number') {
    return (
      <div style={{ marginBottom: 16 }}>
        {label}
        <UIInputNumber
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          style={{ width: '100%' }}
          value={value as number | undefined}
          placeholder={schema.default !== undefined ? String(schema.default) : undefined}
          onChange={onChange}
        />
        {error && <div id={errorId} role="alert" style={{ color: 'var(--color-error)' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {label}
      <UIInput
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value as string | undefined}
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
        onChange={(val) => onChange(val)}
      />
      {error && <div id={errorId} role="alert" style={{ color: 'var(--color-error)' }}>{error}</div>}
    </div>
  );
}

export function RunWorkflowModal(props: RunWorkflowModalProps) {
  const { open, onClose, onRun, loading } = props;

  const isMulti = 'workflows' in props && Array.isArray(props.workflows);
  const workflowList: WorkflowInfo[] = isMulti ? (props as MultiWorkflowProps).workflows : [];

  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  const [jsonValue, setJsonValue] = React.useState('{}');
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [fieldValues, setFieldValues] = React.useState<Record<string, unknown>>({});
  const [requiredErrors, setRequiredErrors] = React.useState<Record<string, string>>({});

  // Resolve the active workflow
  const activeWorkflow: WorkflowInfo | null = isMulti
    ? workflowList.find((w) => w.id === selectedId) ?? null
    : (props as SingleWorkflowProps).workflow ?? null;

  const inputs = activeWorkflow?.inputs;
  const hasSchema = !!inputs && Object.keys(inputs).length > 0;

  // Reset form when modal opens or workflow changes
  React.useEffect(() => {
    if (open) {
      setJsonValue('{}');
      setJsonError(null);
      setRequiredErrors({});
      if (!isMulti) {
        setSelectedId(undefined);
      }
      if (inputs) {
        const defaults: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(inputs)) {
          if (schema.default !== undefined) {
            defaults[key] = schema.default;
          }
        }
        setFieldValues(defaults);
      } else {
        setFieldValues({});
      }
    }
  }, [open, activeWorkflow?.id, inputs, isMulti]);

  // Reset fields when selected workflow changes in multi mode
  React.useEffect(() => {
    if (!isMulti || !selectedId) {return;}
    setJsonValue('{}');
    setJsonError(null);
    setRequiredErrors({});
    if (inputs) {
      const defaults: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(inputs)) {
        if (schema.default !== undefined) {
          defaults[key] = schema.default;
        }
      }
      setFieldValues(defaults);
    } else {
      setFieldValues({});
    }
  }, [selectedId, inputs, isMulti]);

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setJsonValue(val);
    if (!val.trim() || val.trim() === '{}') {
      setJsonError(null);
      return;
    }
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch {
      setJsonError('Invalid JSON');
    }
  };

  const handleRun = () => {
    if (!activeWorkflow) {return;}
    if (hasSchema) {
      const errors = runWithRequiredInputs(activeWorkflow.id, inputs!, fieldValues, onRun);
      setRequiredErrors(errors);
      return;
    } else {
      const trimmed = jsonValue.trim();
      if (!trimmed || trimmed === '{}') {
        onRun(activeWorkflow.id, {});
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        onRun(activeWorkflow.id, parsed);
      } catch {
        setJsonError('Invalid JSON');
      }
    }
  };

  const footer = (
    <UISpace style={{ justifyContent: 'flex-end' }}>
      <UIButton onClick={onClose} disabled={loading}>
        Cancel
      </UIButton>
      <UIButton
        variant="primary"
        icon={<UIIcon name="PlayCircleOutlined" />}
        loading={loading}
        disabled={!activeWorkflow || (!hasSchema && !!jsonError)}
        onClick={handleRun}
      >
        Run
      </UIButton>
    </UISpace>
  );

  const title = activeWorkflow
    ? `Run Workflow: ${activeWorkflow.name}`
    : 'Run Workflow';

  return (
    <UIModal
      open={open}
      title={
        <UISpace className="gap-item">
          <UIIcon name="ThunderboltOutlined" />
          <span>{title}</span>
        </UISpace>
      }
      onCancel={onClose}
      footer={footer}
      maskClosable={!loading}
    >
      {/* Workflow picker (multi mode only) */}
      {isMulti && (
        <div style={{ marginTop: 16 }}>
          <UITypographyText className="typo-label" style={{ display: 'block', marginBottom: 8 }}>
            Select Workflow
          </UITypographyText>
          <UISelect
            style={{ width: '100%' }}
            placeholder="Choose a workflow..."
            value={selectedId}
            onChange={(val) => setSelectedId(val as string)}
            showSearch
            options={workflowList.map((w) => ({
              label: w.name,
              value: w.id,
              description: w.description,
            }))}
          />
        </div>
      )}

      {/* Input form (shown when workflow is selected) */}
      {activeWorkflow && hasSchema && (
        <div style={{ marginTop: 16 }}>
          {Object.entries(inputs!).map(([key, schema]) => (
            <DynamicField
              key={key}
              name={key}
              schema={schema}
              value={fieldValues[key]}
              error={requiredErrors[key]}
              onChange={(val) => {
                setFieldValues((prev) => ({ ...prev, [key]: val }));
                setRequiredErrors((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                });
              }}
            />
          ))}
        </div>
      )}

      {activeWorkflow && !hasSchema && (
        <div style={{ marginTop: 16 }}>
          <UITypographyText className="typo-label" style={{ display: 'block', marginBottom: 8 }}>
            Input payload (JSON)
          </UITypographyText>
          <UIInputTextArea
            value={jsonValue}
            onChange={handleJsonChange}
            rows={6}
            placeholder="{}"
            style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}
            status={jsonError ? 'error' : undefined}
          />
          {jsonError && (
            <UITypographyText className="typo-caption text-error" style={{ display: 'block', marginTop: 4 }}>
              {jsonError}
            </UITypographyText>
          )}
          <UITypographyText className="typo-caption text-tertiary" style={{ display: 'block', marginTop: 8 }}>
            Leave empty or <code>{'{}'}</code> to run without parameters
          </UITypographyText>
        </div>
      )}
    </UIModal>
  );
}
