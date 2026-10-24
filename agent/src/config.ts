import { readJsonFile, writeJsonFile } from './store.ts';

export interface OpenFiles {
  /** Root-relative paths of the editor tabs, in tab order. */
  paths: string[];
  active: string | null;
}

export interface Config {
  projectsRoot?: string;
  lastProject?: string | null;
  /** Editor tabs per project name. */
  openFiles?: Record<string, OpenFiles>;
}

export type ConfigStore = ReturnType<typeof createConfig>;

/** Agent settings in a small JSON file next to auth.json. */
export function createConfig(file: string) {
  return {
    read: (): Config => readJsonFile(file, {}),
    write: (config: Config) => writeJsonFile(file, config),
  };
}
