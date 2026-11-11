import styles from './artifacts.module.css'

export function LogViewer({ data }: { data: unknown }) {
  const text = typeof data === 'string' ? data : data == null ? '' : (JSON.stringify(data, null, 2) ?? '')
  if (!text) {return null}
  return <pre className={styles.logPre}>{text}</pre>
}
