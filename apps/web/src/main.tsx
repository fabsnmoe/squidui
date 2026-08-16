import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastProvider } from '@scp/ui';
import { App } from './App.js';
import { PortalProvider } from './lib/portal.js';
import { SessionProvider } from './lib/session.js';
import { ThemeProvider } from './lib/theme.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <PortalProvider>
              <SessionProvider>
                <App />
              </SessionProvider>
            </PortalProvider>
          </BrowserRouter>
        </ErrorBoundary>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
