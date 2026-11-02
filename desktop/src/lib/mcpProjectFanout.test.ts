import { describe, expect, it, vi } from 'vitest'
import {
  createProjectCopies,
  McpProjectFanoutError,
  moveProjectCopiesToSingle,
  moveSingleToProjectCopies,
  syncProjectCopies,
  type ProjectFanoutCallbacks,
} from './mcpProjectFanout'
import type { McpServerRecord, McpUpsertPayload } from '../types/mcp'

const projectPayload: McpUpsertPayload = {
  scope: 'project',
  config: { type: 'stdio', command: 'npx', args: ['shared-tools'], env: {} },
}

function server(projectPath: string, overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    name: 'shared-tools',
    scope: 'project',
    transport: 'stdio',
    enabled: true,
    status: 'connected',
    statusLabel: 'Connected',
    configLocation: `${projectPath}/.mcp.json`,
    summary: 'npx shared-tools',
    canEdit: true,
    canRemove: true,
    canReconnect: true,
    canToggle: true,
    projectPath,
    config: { type: 'stdio', command: 'npx', args: ['shared-tools'], env: {} },
    ...overrides,
  }
}

function makeCallbacks() {
  const create = vi.fn(async (name: string, payload: McpUpsertPayload, cwd?: string) => ({
    ...server(cwd ?? ''),
    name,
    config: payload.config,
  }))
  const update = vi.fn(async (record: McpServerRecord, payload: McpUpsertPayload, cwd?: string) => ({
    ...record,
    projectPath: cwd ?? record.projectPath,
    config: payload.config,
  }))
  const remove = vi.fn(async (_record: McpServerRecord, _cwd?: string) => undefined)
  const callbacks: ProjectFanoutCallbacks = { create, update, remove }
  return { callbacks, create, update, remove }
}

describe('mcpProjectFanout', () => {
  it('creates one copy per deduped project path', async () => {
    const { callbacks, create } = makeCallbacks()

    const result = await createProjectCopies(callbacks, 'shared-tools', projectPayload, [
      '/workspace/a',
      '/workspace/a/',
      '/workspace/b',
    ])

    expect(result).toEqual({ created: 2, updated: 0, removed: 0 })
    expect(create.mock.calls.map((call) => call[2])).toEqual(['/workspace/a', '/workspace/b'])
  })

  it('removes created copies when a later create fails', async () => {
    const { callbacks, create, remove } = makeCallbacks()
    create
      .mockResolvedValueOnce(server('/workspace/a'))
      .mockRejectedValueOnce(new Error('create failed'))

    await expect(
      createProjectCopies(callbacks, 'shared-tools', projectPayload, ['/workspace/a', '/workspace/b']),
    ).rejects.toBeInstanceOf(McpProjectFanoutError)

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/workspace/a' }), '/workspace/a')
  })

  it('updates shared copies, adds new projects, and removes deselected projects', async () => {
    const { callbacks, create, update, remove } = makeCallbacks()
    const existing = [server('/workspace/a'), server('/workspace/b')]

    const result = await syncProjectCopies(
      callbacks,
      'shared-tools',
      projectPayload,
      existing,
      ['/workspace/b', '/workspace/c'],
    )

    expect(result).toEqual({ created: 1, updated: 1, removed: 1 })
    expect(update).toHaveBeenCalledWith(existing[1], projectPayload, '/workspace/b')
    expect(create).toHaveBeenCalledWith('shared-tools', projectPayload, '/workspace/c')
    expect(remove).toHaveBeenCalledWith(existing[0], '/workspace/a')
  })

  it('restores updated copies and removes additions when sync fails', async () => {
    const { callbacks, create, update, remove } = makeCallbacks()
    const existing = [server('/workspace/a'), server('/workspace/b')]
    remove.mockImplementation(async (_record, cwd) => {
      if (cwd === '/workspace/a') throw new Error('remove failed')
    })

    await expect(
      syncProjectCopies(callbacks, 'shared-tools', projectPayload, existing, ['/workspace/b', '/workspace/c']),
    ).rejects.toBeInstanceOf(McpProjectFanoutError)

    expect(create).toHaveBeenCalledWith('shared-tools', expect.anything(), '/workspace/c')
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/workspace/c' }), '/workspace/c')
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('removes every project copy when moving to a single scope', async () => {
    const { callbacks, create, remove } = makeCallbacks()
    const existing = [server('/workspace/a'), server('/workspace/b')]

    const result = await moveProjectCopiesToSingle(
      callbacks,
      'shared-tools',
      existing,
      { scope: 'user', config: projectPayload.config },
      undefined,
    )

    expect(result).toEqual({ created: 1, updated: 0, removed: 2 })
    expect(remove).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledWith('shared-tools', expect.anything(), undefined)
  })

  it('recreates the single server when moving it into project copies fails', async () => {
    const { callbacks, create, remove } = makeCallbacks()
    const single = server('/workspace/single', {
      scope: 'local',
      configLocation: '/workspace/single/.claude.json',
    })
    create.mockRejectedValueOnce(new Error('create failed'))

    await expect(
      moveSingleToProjectCopies(
        callbacks,
        single,
        projectPayload,
        ['/workspace/a', '/workspace/b'],
      ),
    ).rejects.toBeInstanceOf(McpProjectFanoutError)

    expect(remove).toHaveBeenCalledWith(single, '/workspace/single')
    expect(create).toHaveBeenLastCalledWith(
      'shared-tools',
      { scope: 'local', config: single.config },
      '/workspace/single',
    )
  })

  it('updates an existing local target instead of creating a conflicting copy', async () => {
    const { callbacks, create, update } = makeCallbacks()
    const existingLocal = server('/workspace/a', {
      scope: 'local',
      configLocation: '/workspace/a/.claude.json',
    })

    const result = await moveProjectCopiesToSingle(
      callbacks,
      'shared-tools',
      [existingLocal, server('/workspace/a'), server('/workspace/b')],
      { scope: 'local', config: projectPayload.config },
      '/workspace/a',
    )

    expect(result).toEqual({ created: 0, updated: 1, removed: 2 })
    expect(update).toHaveBeenCalledWith(existingLocal, expect.anything(), '/workspace/a')
    expect(create).not.toHaveBeenCalled()
  })

  it('returns a typed error for an empty selection', async () => {
    const { callbacks } = makeCallbacks()

    await expect(
      createProjectCopies(callbacks, 'shared-tools', projectPayload, []),
    ).rejects.toMatchObject({ code: 'empty-selection' })
  })
})
