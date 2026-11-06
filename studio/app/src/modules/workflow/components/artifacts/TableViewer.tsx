import { UITable } from '@kb-labs/studio-ui-kit';
import styles from './artifacts.module.css'

export function TableViewer({ data }: { data: unknown }) {
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : []

  if (!rows.length) {
    return <div className={styles.empty}>No data.</div>
  }

  const columns = Object.keys(rows[0] ?? {}).map(key => ({
    key,
    dataIndex: key,
    title: key,
  }))

  return <UITable columns={columns} dataSource={rows} size="small" pagination={false} />
}
