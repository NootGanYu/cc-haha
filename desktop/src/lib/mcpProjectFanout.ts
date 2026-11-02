import { dedupeMcpProjectPaths, mcpProjectPathKey } from './mcpIdentity'
import { getProjectServiceCopies } from './mcpServiceGroups'
import type {
  McpServerRecord,
  McpUpsertPayload,
  McpWritableScope,
} from '../types/mcp'

export type ProjectFanoutCallbacks = {
  create: (name: string, payload: McpUpsertPayload, cwd?: string) => Promise<McpServerRecord>
  update: (server: McpServerRecord, payload: McpUpsertPayload, cwd?: string) => Promise<McpServerRecord>
  remove: (server: McpServerRecord, cwd?: string) => Promise<void>
}

export type ProjectFanoutResult = {
  created: number
  updated: number
  removed: number
}

export type McpProjectFanoutErrorCode =
  | 'empty-selection'
  | 'operation-failed'

type McpProjectFanoutErrorOptions = {
  code?: McpProjectFanoutErrorCode
  rollbackErrors?: string[]
  rollbackAttempted?: boolean
}

export class McpProjectFanoutError extends Error {
  readonly code: McpProjectFanoutErrorCode
  readonly rollbackErrors: string[]
  readonly rollbackAttempted: boolean

  constructor(message: string, options: McpProjectFanoutErrorOptions = {}) {
    super(message)
    this.name = 'McpProjectFanoutError'
    this.code = options.code ?? 'operation-failed'
    this.rollbackErrors = options.rollbackErrors ?? []
    this.rollbackAttempted = options.rollbackAttempted ?? false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function rollback(
  actions: Array<() => Promise<unknown>>,
): Promise<string[]> {
  const errors: string[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      errors.push(errorMessage(error))
    }
  }
  return errors
}

function projectServerPayload(server: McpServerRecord): McpUpsertPayload {
  return { scope: 'project', config: server.config }
}

function recreateProjectCopy(
  callbacks: ProjectFanoutCallbacks,
  name: string,
  server: McpServerRecord,
) {
  return callbacks.create(name, projectServerPayload(server), server.projectPath)
}

export async function createProjectCopies(
  callbacks: ProjectFanoutCallbacks,
  name: string,
  payload: McpUpsertPayload,
  projectPaths: string[],
): Promise<ProjectFanoutResult> {
  const paths = dedupeMcpProjectPaths(projectPaths)
  if (paths.length === 0) {
    throw new McpProjectFanoutError('Select at least one project', { code: 'empty-selection' })
  }

  const created: Array<{ record: McpServerRecord; path: string }> = []
  try {
    for (const path of paths) {
      created.push({ record: await callbacks.create(name, payload, path), path })
    }
  } catch (error) {
    const rollbackErrors = await rollback(
      [...created].reverse().map(({ record, path }) => () => callbacks.remove(record, path)),
    )
    throw new McpProjectFanoutError(errorMessage(error), {
      code: 'operation-failed',
      rollbackErrors,
      rollbackAttempted: created.length > 0,
    })
  }

  return { created: created.length, updated: 0, removed: 0 }
}

export async function syncProjectCopies(
  callbacks: ProjectFanoutCallbacks,
  name: string,
  payload: McpUpsertPayload,
  servers: McpServerRecord[],
  projectPaths: string[],
): Promise<ProjectFanoutResult> {
  const desiredPaths = dedupeMcpProjectPaths(projectPaths)
  if (desiredPaths.length === 0) {
    throw new McpProjectFanoutError('Select at least one project', { code: 'empty-selection' })
  }

  const existing = getProjectServiceCopies(name, servers)

  const desiredKeys = new Set(desiredPaths.map(mcpProjectPathKey))
  const existingKeys = new Set(existing.map((server) => mcpProjectPathKey(server.projectPath)))
  const updates = existing.filter((server) => desiredKeys.has(mcpProjectPathKey(server.projectPath)))
  const removals = existing.filter((server) => !desiredKeys.has(mcpProjectPathKey(server.projectPath)))
  const additions = desiredPaths.filter((path) => !existingKeys.has(mcpProjectPathKey(path)))

  const updated: McpServerRecord[] = []
  const created: Array<{ record: McpServerRecord; path: string }> = []
  const removed: Array<{ record: McpServerRecord; path: string }> = []

  try {
    for (const server of updates) {
      await callbacks.update(server, payload, server.projectPath)
      updated.push(server)
    }
    for (const path of additions) {
      created.push({ record: await callbacks.create(name, payload, path), path })
    }
    for (const server of removals) {
      await callbacks.remove(server, server.projectPath)
      removed.push({ record: server, path: server.projectPath! })
    }
  } catch (error) {
    const rollbackErrors = await rollback([
      ...[...removed].reverse().map(({ record }) => () => (
        recreateProjectCopy(callbacks, name, record)
      )),
      ...[...created].reverse().map(({ record, path }) => () => callbacks.remove(record, path)),
      ...[...updated].reverse().map((record) => () => (
        callbacks.update(record, projectServerPayload(record), record.projectPath)
      )),
    ])
    throw new McpProjectFanoutError(errorMessage(error), {
      code: 'operation-failed',
      rollbackErrors,
      rollbackAttempted: removed.length > 0 || created.length > 0 || updated.length > 0,
    })
  }

  return {
    created: created.length,
    updated: updated.length,
    removed: removed.length,
  }
}

export async function moveProjectCopiesToSingle(
  callbacks: ProjectFanoutCallbacks,
  name: string,
  servers: McpServerRecord[],
  payload: McpUpsertPayload,
  targetCwd?: string,
): Promise<ProjectFanoutResult> {
  const copies = getProjectServiceCopies(name, servers)

  const target = servers.find((server) => (
    server.name === name &&
    server.scope === payload.scope &&
    (payload.scope === 'user' ||
      mcpProjectPathKey(server.projectPath) === mcpProjectPathKey(targetCwd))
  ))

  const removed: McpServerRecord[] = []
  let created: McpServerRecord | undefined
  let updatedTarget: McpServerRecord | undefined
  try {
    for (const server of copies) {
      await callbacks.remove(server, server.projectPath)
      removed.push(server)
    }
    if (target) {
      updatedTarget = target
      await callbacks.update(target, payload, targetCwd)
    } else {
      created = await callbacks.create(name, payload, targetCwd)
    }
  } catch (error) {
    const rollbackErrors = await rollback([
      ...(created ? [() => callbacks.remove(created!, targetCwd)] : []),
      ...(updatedTarget
        ? [() => callbacks.update(
            updatedTarget!,
            { scope: updatedTarget!.scope as McpWritableScope, config: updatedTarget!.config },
            targetCwd,
          )]
        : []),
      ...[...removed].reverse().map((server) => () => (
        recreateProjectCopy(callbacks, name, server)
      )),
    ])
    throw new McpProjectFanoutError(errorMessage(error), {
      code: 'operation-failed',
      rollbackErrors,
      rollbackAttempted: Boolean(created || updatedTarget) || removed.length > 0,
    })
  }

  return {
    created: created ? 1 : 0,
    updated: updatedTarget ? 1 : 0,
    removed: removed.length,
  }
}

export async function moveSingleToProjectCopies(
  callbacks: ProjectFanoutCallbacks,
  server: McpServerRecord,
  payload: McpUpsertPayload,
  projectPaths: string[],
): Promise<ProjectFanoutResult> {
  const previousCwd = server.scope === 'local' ? server.projectPath : undefined
  try {
    await callbacks.remove(server, previousCwd)
  } catch (error) {
    throw new McpProjectFanoutError(errorMessage(error), { code: 'operation-failed' })
  }

  try {
    return await createProjectCopies(callbacks, server.name, payload, projectPaths)
  } catch (error) {
    const rollbackErrors = await rollback([
      () => callbacks.create(
        server.name,
        { scope: server.scope as McpWritableScope, config: server.config },
        previousCwd,
      ),
    ])
    const nestedErrors = error instanceof McpProjectFanoutError ? error.rollbackErrors : []
    throw new McpProjectFanoutError(errorMessage(error), {
      code: 'operation-failed',
      rollbackErrors: [...rollbackErrors, ...nestedErrors],
      rollbackAttempted: true,
    })
  }
}
