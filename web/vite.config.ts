import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // vite@8 / rollup dropped the object form of manualChunks; it must be a
        // function. Map each vendor group's node_modules path to a chunk name.
        manualChunks: (id: string) => {
          if (id.includes('/node_modules/@cloudscape-design/')) return 'cloudscape';
          if (id.includes('/node_modules/aws-amplify/') || id.includes('/node_modules/@aws-amplify/'))
            return 'auth';
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router/')
          )
            return 'react';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
