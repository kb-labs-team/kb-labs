# Studio Widgets

This folder contains React components (widgets) for KB Labs Studio UI.

## Structure

```
studio/
├── widgets/           # Widget implementations
│   ├── hello-widget.tsx
│   └── index.ts
└── index.ts          # Studio surface export
```

## Adding a New Widget

### 1. Create Widget Component

Create `widgets/your-widget.tsx`:

```typescript
import React from 'react';

export interface YourWidgetProps {
  data?: {
    title: string;
    count: number;
  };
  loading?: boolean;
  error?: Error;
}

export function YourWidget({ data, loading, error }: YourWidgetProps) {
  if (loading) {
    return <div className="widget-loading">Loading...</div>;
  }

  if (error) {
    return <div className="widget-error">Error: {error.message}</div>;
  }

  if (!data) {
    return <div className="widget-empty">No data available</div>;
  }

  return (
    <div className="widget-container">
      <h2>{data.title}</h2>
      <p>Count: {data.count}</p>
    </div>
  );
}
```

### 2. Export Widget

Add to `widgets/index.ts`:

```typescript
export * from './your-widget.js';
```

### 3. Register in Manifest

Update `src/manifest.v2.ts`:

```typescript
studio: {
  widgets: [
    {
      id: 'template.your-widget',
      kind: 'card',
      title: 'Your Widget',
      description: 'Displays your data',
      data: {
        source: {
          type: 'rest',
          routeId: '/your-endpoint',  // Fetch from REST API
          method: 'GET'
        },
        schema: {
          zod: './rest/schemas/your-schema.js#YourResponseSchema'
        }
      },
      layoutHint: {
        w: 3,  // Width (grid columns)
        h: 2,  // Height (grid rows)
        minW: 2,
        minH: 2
      }
    }
  ]
}
```

## Widget Patterns

### Simple Static Widget

```typescript
export function WelcomeWidget() {
  return (
    <div className="welcome">
      <h1>Welcome to Plugin Template</h1>
      <p>Get started by adding your data.</p>
    </div>
  );
}
```

### Widget with REST Data

```typescript
export interface MetricsWidgetProps {
  data?: {
    total: number;
    active: number;
    pending: number;
  };
  loading?: boolean;
  error?: Error;
}

export function MetricsWidget({ data, loading, error }: MetricsWidgetProps) {
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  if (!data) return <EmptyState message="No metrics available" />;

  return (
    <div className="metrics-grid">
      <MetricCard label="Total" value={data.total} />
      <MetricCard label="Active" value={data.active} />
      <MetricCard label="Pending" value={data.pending} />
    </div>
  );
}
```

### Interactive Widget

```typescript
import { useState } from 'react';

export function FilterWidget({ data }: FilterWidgetProps) {
  const [filter, setFilter] = useState('all');

  const filteredData = data?.items.filter(item => {
    if (filter === 'all') return true;
    return item.status === filter;
  });

  return (
    <div>
      <select value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">All</option>
        <option value="active">Active</option>
        <option value="done">Done</option>
      </select>

      <ul>
        {filteredData?.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Widget with Actions

```typescript
export function ActionsWidget({ data }: ActionsWidgetProps) {
  const handleAction = async (actionId: string) => {
    try {
      // Call REST API
      const response = await fetch(`/api/actions/${actionId}`, {
        method: 'POST'
      });
      const result = await response.json();
      console.log('Action completed:', result);
    } catch (error) {
      console.error('Action failed:', error);
    }
  };

  return (
    <div className="actions">
      <button onClick={() => handleAction('sync')}>
        Sync Data
      </button>
      <button onClick={() => handleAction('refresh')}>
        Refresh
      </button>
    </div>
  );
}
```

## Data Sources

Widgets can get data from multiple sources:

### REST API Source

```typescript
// In manifest.v2.ts
{
  id: 'template.rest-widget',
  data: {
    source: {
      type: 'rest',
      routeId: '/metrics',
      method: 'GET',
      params: {
        period: '7d'
      }
    },
    schema: {
      zod: './rest/schemas/metrics-schema.js#MetricsResponseSchema'
    }
  }
}
```

### Static Data Source

```typescript
{
  id: 'template.static-widget',
  data: {
    source: {
      type: 'static',
      value: {
        message: 'Hello from static data',
        timestamp: new Date().toISOString()
      }
    }
  }
}
```

### CLI Command Source

```typescript
{
  id: 'template.cli-widget',
  data: {
    source: {
      type: 'cli',
      commandId: 'template:hello',
      args: ['--json']
    }
  }
}
```

## Best Practices

### ✅ DO

- **Keep widgets presentational** - no business logic
- **Handle loading states** - show spinners during fetch
- **Handle error states** - show user-friendly errors
- **Handle empty states** - show helpful messages
- **Use TypeScript** - type your props
- **Follow React best practices** - hooks, composition

### ❌ DON'T

- Don't put business logic in widgets
- Don't make direct API calls (use data sources)
- Don't access filesystem or process
- Don't use global state without proper context
- Don't ignore loading/error states

## Layout Hints

Control widget size and position:

```typescript
{
  layoutHint: {
    w: 4,       // Width: 4 columns (out of 6 on large screens)
    h: 3,       // Height: 3 rows
    minW: 2,    // Minimum width
    minH: 2,    // Minimum height
    maxW: 6,    // Maximum width
    maxH: 4     // Maximum height
  }
}
```

Grid configuration (in manifest):

```typescript
studio: {
  layouts: [
    {
      id: 'template.dashboard',
      kind: 'grid',
      title: 'Dashboard',
      config: {
        cols: {
          sm: 2,   // 2 columns on small screens
          md: 4,   // 4 columns on medium screens
          lg: 6    // 6 columns on large screens
        },
        rowHeight: 60  // Pixels per row unit
      }
    }
  ]
}
```

## Styling

Widgets should use consistent KB Labs styling:

```typescript
// Use semantic classnames
<div className="widget-container">
  <div className="widget-header">
    <h2 className="widget-title">Title</h2>
  </div>
  <div className="widget-content">
    {content}
  </div>
  <div className="widget-footer">
    <button className="btn-primary">Action</button>
  </div>
</div>
```

## Testing Widgets

Test React components with React Testing Library:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { YourWidget } from './your-widget.js';

describe('YourWidget', () => {
  it('should render data', () => {
    render(<YourWidget data={{ title: 'Test', count: 42 }} />);

    expect(screen.getByText('Test')).toBeInTheDocument();
    expect(screen.getByText(/Count: 42/)).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<YourWidget loading />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should show error state', () => {
    const error = new Error('Failed to load');
    render(<YourWidget error={error} />);

    expect(screen.getByText(/Error:/)).toBeInTheDocument();
  });

  it('should show empty state', () => {
    render(<YourWidget />);

    expect(screen.getByText('No data available')).toBeInTheDocument();
  });
});
```

## Common Widget Types

### Metric Cards

```typescript
export function MetricCard({ label, value, trend }: MetricCardProps) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {trend && <div className="metric-trend">{trend}%</div>}
    </div>
  );
}
```

### Data Tables

```typescript
export function DataTable({ columns, data }: DataTableProps) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map(col => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i}>
            {columns.map(col => (
              <td key={col.key}>{row[col.key]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Charts

```typescript
export function SimpleChart({ data }: ChartProps) {
  return (
    <div className="chart">
      {data.map((point, i) => (
        <div
          key={i}
          className="chart-bar"
          style={{ height: `${point.value}%` }}
        >
          {point.label}
        </div>
      ))}
    </div>
  );
}
```

## Examples

See [hello-widget.tsx](./widgets/hello-widget.tsx) for a complete example with:
- Typed props
- Loading/error/empty states
- Data from REST API
- Clean component structure

## Related Documentation

- [studio-guide.md](../../../docs/studio-guide.md) - Studio integration guide
- [Architecture Guide](../../../docs/architecture.md)
- [React Documentation](https://react.dev)
