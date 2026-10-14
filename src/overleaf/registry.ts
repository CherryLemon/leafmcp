/**
 * Project resolution and per-project workspace lifecycle.
 *
 * A remote MCP server is called by many clients with no shared session, so "which project
 * am I working on" cannot live in per-connection memory. It is instead an explicit,
 * inspectable value: a persisted default that a tool can set, overridable per call by any
 * tool that accepts a `project` argument.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Project } from '@aloth/olcli';

import type { AppConfig } from '../config.js';
import { ToolError, errorMessage } from '../util/errors.js';
import { log } from '../util/logger.js';
import type { OverleafSession } from './session.js';
import { ProjectWorkspace } from './workspace.js';

const PROJECT_LIST_TTL_MS = 60_000;

export interface ActiveProject {
  id: string;
  name: string;
}

/** Tiny JSON file holding deployment-level settings that outlive a process restart. */
class StateStore {
  private cache: Record<string, unknown> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, unknown>> {
    if (this.cache) return this.cache;
    try {
      this.cache = existsSync(this.path)
        ? (JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>)
        : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.load())[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const state = await this.load();
    if (value === undefined) delete state[key];
    else state[key] = value;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

export class ProjectRegistry {
  private cache: { at: number; projects: Project[] } | null = null;

  private readonly state: StateStore;

  constructor(
    private readonly session: OverleafSession,
    private readonly config: AppConfig,
  ) {
    this.state = new StateStore(join(config.dataDir, 'state.json'));
  }

  async list(force = false): Promise<Project[]> {
    if (!force && this.cache && Date.now() - this.cache.at < PROJECT_LIST_TTL_MS) {
      return this.cache.projects;
    }
    const projects = await this.session.run((client) => client.listProjects());
    this.cache = { at: Date.now(), projects };
    return projects;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** The project tools default to when the model does not name one. */
  async active(): Promise<ActiveProject | undefined> {
    const stored = await this.state.get<ActiveProject>('activeProject');
    if (stored?.id) return stored;
    if (this.config.defaultProject) {
      try {
        return await this.resolve(this.config.defaultProject);
      } catch (error) {
        log.warn(`OVERLEAF_DEFAULT_PROJECT could not be resolved: ${errorMessage(error)}`);
      }
    }
    return undefined;
  }

  async setActive(project: ActiveProject): Promise<void> {
    await this.state.set('activeProject', project);
  }

  /**
   * Resolve a model-supplied project reference to a concrete project.
   *
   * Accepts an id, an exact name, or a unique substring, because a model will happily
   * write "my thesis" when the project is called "PhD Thesis (2026)". Ambiguity is an
   * error rather than a guess: silently editing the wrong paper is the worst outcome here.
   */
  async resolve(ref: string | undefined): Promise<ActiveProject> {
    const projects = await this.list();

    if (!ref || ref.trim() === '') {
      const active = await this.active();
      if (active) return active;
      throw new ToolError(
        'no project selected',
        projects.length > 0
          ? `Call use_project with one of: ${projects.slice(0, 10).map((p) => `"${p.name}"`).join(', ')}`
          : 'The Overleaf account has no projects, or OVERLEAF_SESSION is not valid.',
      );
    }

    const wanted = ref.trim();
    const byId = projects.find((p) => p.id === wanted);
    if (byId) return { id: byId.id, name: byId.name };

    const lower = wanted.toLowerCase();
    const exact = projects.filter((p) => p.name.toLowerCase() === lower);
    if (exact.length === 1 && exact[0]) return { id: exact[0].id, name: exact[0].name };

    const partial = projects.filter((p) => p.name.toLowerCase().includes(lower));
    if (partial.length === 1 && partial[0]) return { id: partial[0].id, name: partial[0].name };
    if (partial.length > 1) {
      throw new ToolError(
        `"${wanted}" matches ${partial.length} projects`,
        `Be more specific, or pass the exact id: ${partial.slice(0, 8).map((p) => `${p.name} (${p.id})`).join('; ')}`,
      );
    }

    throw new ToolError(
      `no Overleaf project matches "${wanted}"`,
      `Available projects: ${projects.slice(0, 15).map((p) => `"${p.name}"`).join(', ')}`,
    );
  }
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, ProjectWorkspace>();

  constructor(private readonly config: AppConfig) {}

  for(project: ActiveProject): ProjectWorkspace {
    const existing = this.workspaces.get(project.id);
    if (existing) return existing;
    const workspace = new ProjectWorkspace(
      join(this.config.dataDir, 'projects'),
      project.id,
      project.name,
      { maxFileBytes: this.config.maxFileBytes },
    );
    this.workspaces.set(project.id, workspace);
    return workspace;
  }
}