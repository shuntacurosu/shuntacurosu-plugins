import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: 'firebase/app', replacement: path.resolve(__dirname, 'firebase_impl/app.js') },
      { find: 'firebase/auth', replacement: path.resolve(__dirname, 'firebase_impl/auth.js') },
      { find: 'firebase/firestore', replacement: path.resolve(__dirname, 'firebase_impl/firestore.js') },
      { find: 'pocketbase', replacement: path.resolve(__dirname, 'node_modules/pocketbase') }
    ]
  },
  define: {
    __firebase_config: JSON.stringify(JSON.stringify({ pocketbaseUrl: "http://127.0.0.1:8090" })),
  }
})
