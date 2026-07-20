import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './custom.css'

// The Documentify-inspired visual system lives entirely in custom.css
// (owned by the theme designer). This entry only extends the default theme
// and pulls those overrides in.
export default {
  extends: DefaultTheme,
} satisfies Theme
