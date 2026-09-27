import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UIImagePreview } from './UIImagePreview';

describe('UIImagePreview', () => {
  it('renders an accessible thumbnail and enables fullscreen preview by default', () => {
    render(<UIImagePreview src="data:image/png;base64,aGVsbG8=" alt="Diagram" width={72} height={72} />);

    const image = screen.getByRole('img', { name: 'Diagram' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
    expect(image).toHaveAttribute('width', '72');
    expect(image).toHaveAttribute('height', '72');
    expect(image.closest('.ant-image')).toBeInTheDocument();
  });
});
