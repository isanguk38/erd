import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    // DB 연결은 로컬 서버(apps/server)가 맡는다
    proxy: {
      '/api': `http://127.0.0.1:${process.env.ERD_SERVER_PORT || 4000}`,
      '/ws': { target: `ws://127.0.0.1:${process.env.ERD_SERVER_PORT || 4000}`, ws: true },
    },
  },
});
