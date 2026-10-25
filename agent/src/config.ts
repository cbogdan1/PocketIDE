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
  /** Lines of history each terminal keeps for scrolling back and restoring (default 5000). */
  terminalScrollback?: number;
  /** Tailnet ports the agent published previews on; any left after a crash are removed at the next start. */
  previewServe?: number[];
}

export type ConfigStore = ReturnType<typeof createConfig>;

/** Agent settings in a small JSON file next to auth.json. */
export function createConfig(file: string) {
  return {
    read: (): Config => readJsonFile(file, {}),
    write: (config: Config) => writeJsonFile(file, config),
  };
}
