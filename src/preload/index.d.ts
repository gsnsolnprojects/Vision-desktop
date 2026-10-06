import type { StationApi } from "../shared/ipc";

declare global {
  interface Window {
    station: StationApi;
  }
}

export {};
