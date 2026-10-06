import type { BackendRequest } from "../../../shared/ipc";

export class BackendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Call VisionBackend through the main process. */
export async function backendCall<T>(req: BackendRequest): Promise<T> {
  const res = await window.station.backend.request<T>(req);
  if (!res.ok) throw new BackendError(res.error || `Request failed (${res.status})`, res.status);
  return res.data as T;
}

export interface LibraryModel {
  modelId: string;
  modelVersion: string | number | null;
  modelType: string;
  name: string;
  metrics: { mAP50?: number; precision?: number; recall?: number };
  createdAt: string;
  classNames: string[];
}

export function listLibraryModels(headers: Record<string, string>, company: string, project: string): Promise<LibraryModel[]> {
  return backendCall<{ models: LibraryModel[] }>({
    method: "GET",
    path: "/inference/models",
    query: { company, project },
    headers,
  }).then((r) =>
    (r.models ?? []).map((m) => ({
      ...m,
      // Older backends return class_names
      classNames: m.classNames ?? (m as unknown as { class_names?: string[] }).class_names ?? [],
    })),
  );
}
