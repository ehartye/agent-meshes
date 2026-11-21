import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/web',
  build: {
    outDir: '../../dist-web', emptyOutDir: true,
    // The workbench and the animation library page. `rolldownOptions` is Vite 8's name for `rollupOptions`.
    rolldownOptions: { input: {
      index: fileURLToPath(new URL('./src/web/index.html', import.meta.url)),
      animations: fileURLToPath(new URL('./src/web/animations.html', import.meta.url)),
    } },
  },
  server: { proxy: { '/api': {
    target: 'http://127.0.0.1:3388',
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, incoming) => {
        const { host, origin } = incoming.headers;
        if (!host || !origin || origin !== `http://${host}`) return;
        const hostname = new URL(origin).hostname;
        if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
          outgoing.setHeader('origin', 'http://127.0.0.1:3388');
        }
      });
    },
  } } },
});
