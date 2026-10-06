/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
