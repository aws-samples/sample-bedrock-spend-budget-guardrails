import React from 'react';
import ReactDOM from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import { ThemeProvider } from './theme/ThemeProvider';
import { App } from './App';
import { loadConfig } from './config';
import { configureAmplify } from './auth/Amplify';

void (async () => {
  const cfg = await loadConfig();
  configureAmplify(cfg);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root element missing');

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ThemeProvider>
        <App config={cfg} />
      </ThemeProvider>
    </React.StrictMode>,
  );
})();
