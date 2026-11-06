import { useState } from 'react'
import {
  UIModal, UIButton, UIAlert, UITypographyText, UITypographyParagraph, UITitle, UIInputTextArea } from '@kb-labs/studio-ui-kit';
import type { StepRun } from '@kb-labs/workflow-contracts'

const Text = UITypographyText
const Paragraph = UITypographyParagraph
const Title = UITitle
const TextArea = UIInputTextArea

interface ApprovalModalProps {
  step: StepRun | null
  open: boolean
  onClose: () => void
  onResolve: (action: 'approve' | 'reject', comment?: string) => Promise<void>
  isLoading?: boolean
  error?: Error | null
}

export function ApprovalModal({
  step,
  open,
  onClose,
  onResolve,
  isLoading,
  error,
}: ApprovalModalProps) {
  const [comment, setComment] = useState('')
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null)

  const context = (step?.spec?.with ?? {}) as Record<string, unknown>
  const title = typeof context.title === 'string' ? context.title : step?.name ?? 'Approval Required'
  const instructions = typeof context.instructions === 'string' ? context.instructions : null
  const contextData = typeof context.context === 'object' && context.context !== null
    ? context.context as Record<string, unknown>
    : null

  const handleResolve = async (action: 'approve' | 'reject') => {
    setPendingAction(action)
    try {
      await onResolve(action, comment.trim() || undefined)
      setComment('')
      setPendingAction(null)
    } catch {
      setPendingAction(null)
    }
  }

  return (
    <UIModal
      open={open}
      title={title}
      width="large"
      maskClosable={false}
      onCancel={onClose}
      footer={null}
    >
      {instructions && (
        <Paragraph style={{ marginBottom: 16 }}>
          <Text type="secondary">{instructions}</Text>
        </Paragraph>
      )}

      {contextData && Object.keys(contextData).length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Title level={5} style={{ marginBottom: 8 }}>Context</Title>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(contextData).map(([key, value]) => (
              <div key={key} style={{ display: 'flex', gap: 8 }}>
                <Text strong style={{ minWidth: 100, textTransform: 'capitalize' }}>
                  {key.replace(/([A-Z])/g, ' $1').trim()}:
                </Text>
                <Text>{String(value ?? '—')}</Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <UIAlert
          variant="error"
          message={error.message}
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      <div style={{ marginBottom: 16 }}>
        <Title level={5} style={{ marginBottom: 8 }}>Comment (optional)</Title>
        <TextArea
          rows={3}
          placeholder="Add a comment for the record..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={isLoading}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <UIButton
          onClick={onClose}
          disabled={isLoading}
        >
          Cancel
        </UIButton>
        <UIButton
          danger
          onClick={() => void handleResolve('reject')}
          loading={isLoading && pendingAction === 'reject'}
          disabled={isLoading && pendingAction !== 'reject'}
        >
          Reject
        </UIButton>
        <UIButton
          variant="primary"
          onClick={() => void handleResolve('approve')}
          loading={isLoading && pendingAction === 'approve'}
          disabled={isLoading && pendingAction !== 'approve'}
        >
          Approve
        </UIButton>
      </div>
    </UIModal>
  )
}
