import type { FC } from 'react';

export interface HelloWidgetProps {
  message: string;
  target?: string;
}

export const HelloWidget: FC<HelloWidgetProps> = ({ message, target }) => (
  <section
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
      padding: '1rem'
    }}
  >
    <h2 style={{ margin: 0 }}>Hello from Plugin Template</h2>
    <p style={{ margin: 0 }}>{message}</p>
    {target ? <small style={{ color: '#666' }}>Target: {target}</small> : null}
  </section>
);

export default HelloWidget;


