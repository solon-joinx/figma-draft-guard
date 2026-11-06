// The band module loads this file too, so it must not depend on Node

const MINUTE_MS = 60 * 1000
const STABLE_AFTER_MS = 30 * MINUTE_MS

export type Locale = 'en' | 'zh-TW'
export type Phase = 'editing' | 'stable'
export type FailureCode =
  | 'no-token'
  | 'auth'
  | 'not-found'
  | 'rate-limited'
  | 'network'
  | 'bad-response'
  | 'bad-record'

export type Assessment =
  | { status: 'not-ready'; key: string; fileName: string }
  | {
      status: 'fresh' | 'stale'
      key: string
      fileName: string
      phase: Phase
      mainUpdatedAt: string | null
      draftFromUpdatedAt: string | null
    }
  | { status: 'failed'; key: string; code: FailureCode; fileName?: string }

export type Tone = 'blue' | 'yellow' | 'red' | 'green'

export interface Notice {
  text: string
  tone: Tone
}

export const FAILURE_REASONS: Record<Locale, Record<FailureCode, string>> = {
  en: {
    'no-token': 'Figma token not set (/plugin → fdg)',
    auth: 'Figma token invalid, expired, or missing file_metadata:read',
    'not-found': 'Main file not found, or not readable with this token',
    'rate-limited': 'Figma API rate limit reached',
    network: 'Figma API unreachable',
    'bad-response': 'Unexpected Figma API response',
    'bad-record': 'Binding record damaged; bind the draft again',
  },
  'zh-TW': {
    'no-token': '未設定 Figma token（/plugin → fdg）',
    auth: 'Figma token 無效、已過期，或缺少 file_metadata:read 權限',
    'not-found': '找不到主檔，或此 token 無讀取權限',
    'rate-limited': '已達 Figma API 速率限制',
    network: '無法連線至 Figma API',
    'bad-response': 'Figma API 回應格式異常',
    'bad-record': '綁定紀錄損毀，請重新綁定 draft',
  },
}

export function phaseOf(lastChangedAt: string | null, now: number): Phase {
  const changed = Date.parse(lastChangedAt ?? '')
  return now - changed < STABLE_AFTER_MS ? 'editing' : 'stable'
}

export function formatTime(value: string | null | undefined): string {
  const date = new Date(value ?? '')
  if (Number.isNaN(date.getTime())) return '--/-- --:--'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function relativeTime(value: string | null, now: number, locale: Locale): string {
  const elapsed = now - Date.parse(value ?? '')
  const isZh = locale === 'zh-TW'
  if (Number.isNaN(elapsed)) return isZh ? '未知' : 'unknown'

  const minutes = Math.floor(elapsed / MINUTE_MS)
  if (minutes < 1) return isZh ? '不到 1 分鐘前' : 'under 1 min ago'
  if (minutes < 60) return isZh ? `${minutes} 分鐘前` : `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return isZh ? `${hours} 小時前` : `${hours} hr ago`

  const days = Math.floor(hours / 24)
  return isZh ? `${days} 天前` : `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export function notice(result: Assessment, locale: Locale, now: number): Notice {
  const isZh = locale === 'zh-TW'

  switch (result.status) {
    case 'fresh': {
      const main = formatTime(result.mainUpdatedAt)
      return {
        tone: 'green',
        text: isZh
          ? `✅ Draft 已同步 ｜ ${result.fileName} ｜ 主檔版本 ${main}`
          : `✅ Draft in sync | ${result.fileName} | Main file version ${main}`,
      }
    }
    case 'stale': {
      const changed = relativeTime(result.mainUpdatedAt, now, locale)
      if (phaseOf(result.mainUpdatedAt, now) === 'editing') {
        return {
          tone: 'blue',
          text: isZh
            ? `🔵 Draft 版本落後 ｜ 主檔編輯中 ｜ 最後變更：${changed}`
            : `🔵 Draft out of date | Main file being edited | Last change: ${changed}`,
        }
      }
      return {
        tone: 'yellow',
        text: isZh
          ? `⚠️ Draft 版本落後 ｜ 主檔已穩定 ｜ 最後變更：${changed} ｜ 可更新`
          : `⚠️ Draft out of date | Main file stable | Last change: ${changed} | Ready to update`,
      }
    }
    case 'not-ready':
      return {
        tone: 'yellow',
        text: isZh
          ? `⚠️ Draft 綁定未完成 ｜ ${result.fileName} ｜ 尚未開始監看`
          : `⚠️ Draft binding incomplete | ${result.fileName} | Not watching yet`,
      }
    case 'failed': {
      const reason = FAILURE_REASONS[locale][result.code]
      return {
        tone: 'red',
        text: isZh ? `❌ 版本檢查失敗 ｜ 原因：${reason}` : `❌ Version check failed | Reason: ${reason}`,
      }
    }
  }
}
