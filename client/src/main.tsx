// Self-hosted fonts, bundled at build time (dashboard-spec.md, "Type" and
// story 21: "Zero external requests is a hard requirement"). Imported here
// rather than in App.tsx so the component test never pulls font assets in —
// see App.test.tsx
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/shippori-mincho/700.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './tokens.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('#root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
