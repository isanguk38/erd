import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Toolbar, type DialogName } from './components/Toolbar';
import { SqlDialog } from './components/SqlDialog';
import { VersionsDialog } from './components/VersionsDialog';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function App() {
  const [dialog, setDialog] = useState<DialogName | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar onOpen={setDialog} />
        <main className="workspace">
          <div className="canvas">
            <Canvas />
          </div>
          <Inspector />
        </main>
        {dialog === 'sql' && <SqlDialog onClose={() => setDialog(null)} />}
        {dialog === 'versions' && <VersionsDialog onClose={() => setDialog(null)} />}
      </div>
    </ReactFlowProvider>
  );
}
