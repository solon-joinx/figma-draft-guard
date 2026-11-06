export type DraftBand = { text: string; tone: string } | null

declare module 'claude-code' {
  interface PluginState {
    fdg: { band: DraftBand }
  }
}
