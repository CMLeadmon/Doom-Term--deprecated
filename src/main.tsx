import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ptyClient } from './core/ptyClient';
import './index.css';

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__doom', {
    configurable: true,
    value: () => ptyClient.diagnosticsSnapshot(),
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
