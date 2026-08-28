declare module "vitest" {
  interface ProvidedContext {
    readonly runtimeDynamicWorkerDatabaseUrl: string;
  }
}

export const runtimeDynamicWorkerDatabaseUrl = "runtimeDynamicWorkerDatabaseUrl";
