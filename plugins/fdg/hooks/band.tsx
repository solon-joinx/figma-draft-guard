import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { notice } from '../src/messages.ts'
import type { DraftBand } from '../types'

const REFRESH_MS = 30 * 1000
const POLL_MS = 5 * 60 * 1000
const POLL_TIMEOUT_MS = 15 * 1000
const STATUS_PATH = '.figma-draft-guard/status.json'

const band = atom({ plugin: 'fdg', key: 'band' } as const, null as DraftBand)

// Walk up from the working directory so subfolders see the status too
function parents(cwd: string) {
  const parts = cwd.split('/').filter(Boolean)
  return parts.map((_, index) => `/${parts.slice(0, parts.length - index).join('/')}`)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    const refresh = async () => {
      for (const dir of parents(await $.session.cwd())) {
        try {
          const { result, locale } = JSON.parse(await $.fs.read(`${dir}/${STATUS_PATH}`))
          const shown = result ? notice(result, locale, await $.clock.now()) : null
          await update($, band, () => shown)
          return
        } catch {
          // No status file at this level, so try the parent
        }

        // Stop at the project boundary, as the record lookup does
        const isRepoRoot = await $.fs.read(`${dir}/.git/HEAD`).then(
          () => true,
          () => false,
        )
        if (isRepoRoot) break
      }
      await update($, band, () => null)
    }

    const poll = async () => {
      try {
        await $.process.run(['node', `${$.plugin.root}/dist/hook.mjs`, 'poll'], {
          env: {
            FDG_TOKEN: String(options.figma_token ?? ''),
            CLAUDE_PROJECT_DIR: await $.session.cwd(),
          },
          timeoutMs: POLL_TIMEOUT_MS,
        })
        await refresh()
      } catch {
        // The next poll tries again; the session start and read checks still run
      }
    }

    await refresh()
    $.clock.every(REFRESH_MS, refresh)
    $.clock.every(POLL_MS, poll)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, band)
    if (!current || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text bold color={current.tone}>
          {current.text}
        </Text>
      </Box>
    )
  })
}
