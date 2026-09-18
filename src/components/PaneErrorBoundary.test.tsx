import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneErrorBoundary } from './PaneErrorBoundary';

const FaultyChild: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) throw new Error('Simulated render explosion');
  return <div data-testid="pane-content">Terminal Active</div>;
};

describe('PaneErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <PaneErrorBoundary sessionId="test-pane">
        <FaultyChild shouldThrow={false} />
      </PaneErrorBoundary>
    );
    expect(screen.getByTestId('pane-content')).toBeDefined();
  });

  it('catches render error and displays pane-isolated failure banner', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PaneErrorBoundary sessionId="test-pane">
        <FaultyChild shouldThrow={true} />
      </PaneErrorBoundary>
    );
    expect(screen.queryByTestId('pane-content')).toBeNull();
    expect(screen.getByText(/Simulated render explosion/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /RETRY RENDER/i })).toBeDefined();
    spy.mockRestore();
  });

  it('resets state when retry is clicked', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Wrapper = () => {
      const [fail, setFail] = useState(true);
      return (
        <PaneErrorBoundary sessionId="test-pane" onReset={() => setFail(false)}>
          <FaultyChild shouldThrow={fail} />
        </PaneErrorBoundary>
      );
    };
    render(<Wrapper />);
    expect(screen.getByRole('button', { name: /RETRY RENDER/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /RETRY RENDER/i }));
    expect(screen.getByTestId('pane-content')).toBeDefined();
    spy.mockRestore();
  });
});
