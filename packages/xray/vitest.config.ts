import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Plugin/server-side units run in node. The capture client + structural
    // renderer will switch to a DOM env (jsdom/happy-dom) once they land.
    environment: 'node',
  },
})
