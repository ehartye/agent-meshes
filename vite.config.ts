import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist-web', emptyOutDir: true },
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
