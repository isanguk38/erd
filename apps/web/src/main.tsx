import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { UpdateBanner } from './components/UpdateBanner';
import { applyTheme } from './lib/theme';
import { DesktopUpdateDialog } from './components/DesktopUpdate';

applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <UpdateBanner />
    <DesktopUpdateDialog />
  </StrictMode>,
);
